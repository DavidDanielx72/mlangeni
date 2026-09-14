/**
 * Writing a menu-builder quote to the database.
 *
 * This writes an ENQUIRY, not an order. The menu builder used to insert
 * straight into `orders`, which meant a request became a booking the moment it
 * was submitted — it locked the slot through the orders_no_overlap constraint,
 * appeared on the customer's Orders page as a real booking, and never reached
 * the admin Enquiries screen where the approval process actually lives. An
 * order is now created by `set_enquiry_status` when an admin confirms. See
 * db/006_menu_builder_enquiries.sql.
 *
 * Extracted from QuoteStep so the submit sequence can be read (and reasoned
 * about) without the JSX around it. Three failure modes are handled here that
 * the old inline version got wrong:
 *
 *  1. The line-item insert failing after the parent insert succeeded, leaving
 *     a request with no food in it. Preferably avoided by the
 *     create_menu_enquiry RPC; otherwise compensated for with a delete.
 *  2. `guests` and the customer's notes never being written at all.
 *  3. An existing customer's edited name or phone never being saved.
 *
 * Everything degrades if `db/00*.sql` hasn't been run.
 */

import { supabase } from "@/services/supabaseClient";
import { computeTotals, guestCount, lineItems } from "./pricing";
import { toDateKey } from "./availability";

export class MenuEnquiryError extends Error {
  constructor(message, { code, orphanEnquiryId } = {}) {
    super(message);
    this.name = "MenuEnquiryError";
    this.code = code;
    this.orphanEnquiryId = orphanEnquiryId;
  }
}

const isMissingFunction = (e) =>
  !!e &&
  (String(e.code) === "PGRST202" ||
    String(e.code) === "42883" ||
    /could not find the function|schema cache/i.test(String(e.message ?? "")));

const isMissingColumn = (e, column) =>
  !!e &&
  (String(e.code) === "PGRST204" || String(e.code) === "42703") &&
  String(e.message ?? "").includes(column);

function mapEnquiryError(err) {
  if (!err) return new MenuEnquiryError("An unexpected error occurred.");

  if (String(err.code) === "23503") {
    return new MenuEnquiryError(
      "Something in your selection is no longer available. Please review your menu.",
      { code: err.code },
    );
  }
  return new MenuEnquiryError(err.message || "An unexpected error occurred.", {
    code: err.code,
  });
}

function splitName(fullName) {
  const [first, ...rest] = String(fullName ?? "").trim().split(/\s+/);
  return { first_name: first || null, last_name: rest.join(" ") || null };
}

/**
 * Which session label this time window falls into.
 *
 * Mirrors public.derive_session in db/006 — the database is the authority (it
 * computes the stored value), this copy only exists so the UI can say which
 * session a request will occupy without a round trip. Keep the two in step.
 */
export function deriveSession(startTime, endTime) {
  const mins = (t) => {
    const m = String(t ?? "").match(/^(\d{1,2}):(\d{2})/);
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const start = mins(startTime);
  const end = mins(endTime);

  if (start === null) return "full_day";
  if (end !== null && end - start >= 8 * 60) return "full_day";
  if (start < 12 * 60) return "morning";
  if (start < 17 * 60) return "afternoon";
  return "evening";
}

/** Create the customer row if it's missing, or push through any edits. */
async function ensureCustomer(state) {
  const { first_name, last_name } = splitName(state.contactName);
  const phone = state.contactPhone?.trim() || null;

  if (state.existingCustomer?.customer_id) {
    const existing = state.existingCustomer;
    const changed =
      existing.first_name !== first_name ||
      existing.last_name !== last_name ||
      (existing.phone_number || null) !== phone;

    if (changed) {
      // Non-fatal: a booking shouldn't fail because a profile tweak didn't save.
      const { error } = await supabase
        .from("customer")
        .update({ first_name, last_name, phone_number: phone })
        .eq("customer_id", existing.customer_id);
      if (error) {
        console.warn("[menu] could not update customer details:", error.message);
      }
    }
    return existing.customer_id;
  }

  const { data, error } = await supabase
    .from("customer")
    .insert({
      user_id: state.authUser.id,
      email: state.authUser.email,
      first_name,
      last_name,
      phone_number: phone,
    })
    .select("customer_id")
    .single();

  if (error) throw mapEnquiryError(error);
  return data.customer_id;
}

/** Atomic path — one transaction. Returns null if the RPC isn't installed. */
async function tryCreateViaRpc(payload) {
  const { data, error } = await supabase.rpc("create_menu_enquiry", {
    p_customer_id: payload.customerId,
    p_event_type_id: payload.eventTypeId,
    p_name: payload.contactName,
    p_email: payload.contactEmail,
    p_phone: payload.contactPhone,
    p_event_date: payload.eventDate,
    p_start_time: payload.startTime,
    p_end_time: payload.endTime,
    p_location: payload.location,
    p_guests: payload.guests,
    p_total_price: payload.totalPrice,
    p_message: payload.notes,
    p_items: payload.items.map((item_id) => ({ item_id })),
  });

  if (error) {
    if (isMissingFunction(error)) return null;
    throw mapEnquiryError(error);
  }
  return data;
}

/** Fallback path — two inserts, with a compensating delete if the second fails. */
async function createViaInserts(payload) {
  const row = {
    source: "menu_builder",
    user_id: payload.userId,
    customer_id: payload.customerId,
    event_type_id: payload.eventTypeId,
    name: payload.contactName,
    email: payload.contactEmail,
    phone: payload.contactPhone,
    event_date: payload.eventDate,
    start_time: payload.startTime,
    end_time: payload.endTime,
    session: deriveSession(payload.startTime, payload.endTime),
    event_location: payload.location,
    guests: payload.guests,
    total_price: payload.totalPrice,
    message: payload.notes,
    status: "pending",
  };

  const { data: enquiry, error } = await supabase
    .from("enquiries")
    .insert(row)
    .select("id")
    .single();

  // db/006 hasn't been run: the enquiry table can't hold a menu at all, so
  // there is nothing useful to degrade to. Say so rather than silently
  // dropping the customer's selections.
  if (isMissingColumn(error, "source") || isMissingColumn(error, "total_price")) {
    throw new MenuEnquiryError(
      "Menu requests aren't set up on this environment yet. Please contact us " +
        "directly and we'll take your booking. (Run db/006_menu_builder_enquiries.sql.)",
      { code: error.code },
    );
  }

  if (error) throw mapEnquiryError(error);

  const itemRows = payload.items.map((item_id) => ({
    enquiry_id: enquiry.id,
    item_id,
    quantity: payload.guests,
  }));

  if (itemRows.length > 0) {
    const { error: itemsErr } = await supabase
      .from("enquiry_menu_items")
      .insert(itemRows);

    if (itemsErr) {
      const { error: cleanupErr } = await supabase
        .from("enquiries")
        .delete()
        .eq("id", enquiry.id);

      if (cleanupErr) {
        throw new MenuEnquiryError(
          `Your request was received but the menu items didn't save. ` +
            `Please quote reference #${enquiry.id} when you contact us.`,
          { code: itemsErr.code, orphanEnquiryId: enquiry.id },
        );
      }
      throw mapEnquiryError(itemsErr);
    }
  }

  return enquiry.id;
}

/**
 * @returns {Promise<{ enquiryId, customerId, totals, items }>}
 * @throws {MenuEnquiryError}
 */
export async function submitMenuEnquiry(state) {
  if (!state.authUser?.id) {
    throw new MenuEnquiryError("You need to be signed in to submit a request.");
  }

  const guests = guestCount(state.guests);
  const totals = computeTotals(state.selections, guests);
  const items = lineItems(state.selections, guests);

  const customerId = await ensureCustomer(state);

  const payload = {
    userId: state.authUser.id,
    customerId,
    eventTypeId: state.eventTypeId,
    contactName: state.contactName?.trim() || null,
    contactEmail: (state.contactEmail || state.authUser.email)?.trim() || null,
    contactPhone: state.contactPhone?.trim() || null,
    eventDate: toDateKey(state.eventDate),
    startTime: state.startTime,
    endTime: state.endTime,
    location: state.eventLocation?.trim() || null,
    guests,
    totalPrice: totals.total,
    notes: state.notes?.trim() || null,
    items: items.map((r) => r.item.item_id),
  };

  const viaRpc = await tryCreateViaRpc(payload);
  const enquiryId = viaRpc ?? (await createViaInserts(payload));

  return { enquiryId, customerId, totals, items };
}
