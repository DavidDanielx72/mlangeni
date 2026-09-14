"use client";

import { useState } from "react";
import {
  ChefHat,
  MessageCircle,
  User,
  UserCheck,
  Users,
  Calendar,
  Clock,
  MapPin,
  ChevronDown,
  Loader2,
} from "lucide-react";
import { supabase } from "@/services/supabaseClient";
import StatusDropdown from "./StatusDropdown";

const currency = new Intl.NumberFormat("en-ZA", {
  style: "currency",
  currency: "ZAR",
});

function formatDate(dateString) {
  return new Date(dateString + "T00:00:00").toLocaleDateString("en-ZA", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function formatTime(time) {
  return String(time ?? "").slice(0, 5);
}

function toWhatsAppLink(phone) {
  const digitsOnly = phone.replace(/[^\d+]/g, "").replace(/^\+/, "");
  return `https://wa.me/${digitsOnly}`;
}

export default function EnquiryRow({ enquiry, onStatusChange }) {
  const [localError, setLocalError] = useState(null);
  const [expanded, setExpanded] = useState(false);
  const [items, setItems] = useState(null); // null = not loaded yet
  const [loadingItems, setLoadingItems] = useState(false);

  const isCustomer = Boolean(enquiry.user_id);
  const isMenuBuilder = enquiry.source === "menu_builder";

  async function handleStatusChange(newStatus) {
    setLocalError(null);

    // set_enquiry_status is the approval process, not a plain column write:
    // confirming a menu request is what creates the actual order and its line
    // items, and cancelling one cancels that order back. A direct
    // .update({ status }) would flip the label and build nothing. See
    // db/006_menu_builder_enquiries.sql.
    const { error } = await supabase.rpc("set_enquiry_status", {
      p_enquiry_id: enquiry.id,
      p_status: newStatus,
    });

    if (error) {
      console.error("Failed to update enquiry status:", error);

      // The orders_no_overlap exclusion constraint is the database's authority
      // on double-booking, and approval is the first moment it gets a say.
      if (
        String(error.code) === "23P01" ||
        /overlap|exclusion/i.test(error.message ?? "")
      ) {
        setLocalError(
          "That date and time window is already taken by a confirmed booking. " +
            "Cancel the other one first, or ask the customer for another slot.",
        );
      } else {
        setLocalError(error.message || "Couldn't update status. Please try again.");
      }
      return;
    }

    onStatusChange(enquiry.id, newStatus);
  }

  async function toggleItems() {
    const next = !expanded;
    setExpanded(next);

    if (!next || items !== null || loadingItems) return;

    setLoadingItems(true);
    const { data, error } = await supabase
      .from("enquiry_menu_items")
      .select("enquiry_item_id, quantity, menu_item:item_id (name, price)")
      .eq("enquiry_id", enquiry.id);

    if (error) {
      console.error("Failed to load enquiry menu items:", error);
      setLocalError("Couldn't load the requested menu.");
      setItems([]);
    } else {
      setItems(data ?? []);
    }
    setLoadingItems(false);
  }

  return (
    <div className="rounded-xl border border-[#1F1F1F] bg-white/5 p-5 transition hover:border-[#2A2A2A]">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-medium text-white">{enquiry.name}</h3>

            <span
              className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${
                isCustomer
                  ? "border-[#D4AF37]/30 bg-[#D4AF37]/5 text-[#D4AF37]"
                  : "border-[#1F1F1F] bg-white/5 text-[#A0A0A0]"
              }`}
            >
              {isCustomer ? <UserCheck size={11} /> : <User size={11} />}
              {isCustomer ? "Customer" : "Guest"}
            </span>

            {isMenuBuilder && (
              <span className="flex items-center gap-1 rounded-full border border-emerald-400/30 bg-emerald-400/5 px-2 py-0.5 text-xs text-emerald-400">
                <ChefHat size={11} />
                Custom menu
              </span>
            )}
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-[#A0A0A0]">
            <span className="flex items-center gap-1.5">
              <Calendar size={13} />
              {formatDate(enquiry.event_date)} · {enquiry.session}
            </span>
            <span className="flex items-center gap-1.5">
              <Users size={13} />
              {enquiry.guests} guests
            </span>
            {enquiry.start_time && enquiry.end_time && (
              <span className="flex items-center gap-1.5">
                <Clock size={13} />
                {formatTime(enquiry.start_time)} – {formatTime(enquiry.end_time)}
              </span>
            )}
          </div>

          {enquiry.event_location && (
            <p className="mt-2 flex items-start gap-1.5 text-sm text-[#A0A0A0]">
              <MapPin size={13} className="mt-0.5 shrink-0" />
              {enquiry.event_location}
            </p>
          )}

          {enquiry.message && (
            <p className="mt-3 line-clamp-2 text-sm text-[#858585]">
              {enquiry.message}
            </p>
          )}

          <p className="mt-2 text-xs text-[#5F5F5F]">
            {enquiry.email}
            {enquiry.phone ? ` · ${enquiry.phone}` : ""}
          </p>

          {isMenuBuilder && (
            <div className="mt-3">
              <button
                type="button"
                onClick={toggleItems}
                aria-expanded={expanded}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-[#D4AF37] transition hover:text-[#e3bf52]"
              >
                <ChevronDown
                  size={13}
                  className={`transition-transform ${expanded ? "rotate-180" : ""}`}
                />
                {expanded ? "Hide requested menu" : "View requested menu"}
                {enquiry.total_price != null && (
                  <span className="text-[#A0A0A0]">
                    · {currency.format(Number(enquiry.total_price))} est.
                  </span>
                )}
              </button>

              {expanded && (
                <div className="mt-3 rounded-lg border border-[#1F1F1F] bg-[#0B0A09] p-4">
                  {loadingItems ? (
                    <p className="flex items-center gap-2 text-xs text-[#A0A0A0]">
                      <Loader2 size={13} className="animate-spin" />
                      Loading menu…
                    </p>
                  ) : items && items.length > 0 ? (
                    <ul className="divide-y divide-[#1A1A1A]">
                      {items.map((row) => (
                        <li
                          key={row.enquiry_item_id}
                          className="flex items-center justify-between gap-4 py-2 text-sm"
                        >
                          <span className="min-w-0 flex-1 truncate text-white">
                            {row.menu_item?.name ?? "Item removed from the menu"}
                          </span>
                          <span className="shrink-0 text-xs tabular-nums text-[#5F5F5F]">
                            {currency.format(Number(row.menu_item?.price ?? 0))} ×{" "}
                            {row.quantity}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-xs text-[#5F5F5F]">
                      No menu items recorded on this request.
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {enquiry.order_id && (
            <p className="mt-2 text-xs text-emerald-400">
              Approved — order #{enquiry.order_id} created.
            </p>
          )}

          {localError && (
            <p className="mt-2 text-xs text-red-400">{localError}</p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {enquiry.phone && (
            <a
              href={toWhatsAppLink(enquiry.phone)}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Open WhatsApp chat"
              className="flex h-10 w-10 items-center justify-center rounded-lg border border-[#1F1F1F] text-emerald-400 transition hover:border-emerald-400"
            >
              <MessageCircle size={17} />
            </a>
          )}

          <StatusDropdown
            value={enquiry.status}
            onChange={handleStatusChange}
            isMenuBuilder={isMenuBuilder}
          />
        </div>
      </div>
    </div>
  );
}
