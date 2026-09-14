"use client";

import { useMemo, useState } from "react";
import { startOfDay, startOfMonth } from "date-fns";
import { CalendarClock, MapPin, Users } from "lucide-react";
import { useMenu } from "./MenuContext";
import { rowDisplayName } from "./constants";
import {
  getAdvanceBookingMessage,
  getMinimumEventDate,
  getMinimumEventDateInputValue,
  isBeforeMinimumEventDate,
} from "@/app/utils/customerBookingRules";

export function EventDetailsStep() {
  const { state, dispatch } = useMenu();

  const [errors, setErrors] = useState({});
  const minimumEventDate = getMinimumEventDate();
  const minimumEventDateInput = getMinimumEventDateInputValue();

  const validate = () => {
    const e = {};
    if (!state.guests || parseInt(state.guests) < 1)
      e.guests = "Please enter guest count";
    if (!state.eventDate) e.eventDate = "Please select an event date";
    else if (isBeforeMinimumEventDate(state.eventDate, minimumEventDate))
      e.eventDate = getAdvanceBookingMessage(minimumEventDate);
    if (!state.eventTypeId) e.eventTypeId = "Please select event type";
    if (!state.eventLocation.trim())
      e.eventLocation = "Please enter venue location";
    if (state.endTime <= state.startTime)
      e.endTime = "End time must be after start time";
    return e;
  };

  const set = (type, payload, field) => {
    dispatch({ type, payload });
    revalidate({ ...state, [field]: payload });
  };

  const setContact = (field, payload) => {
    dispatch({ type: "SET_CONTACT", field, payload });
    revalidate({ ...state, [field]: payload });
  };

  const handleBlur = (field) => {
    setTouched((p) => ({ ...p, [field]: true }));
    revalidate(state, field);
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    const all = validateEventDetails(state, ctx);

    if (Object.keys(all).length > 0) {
      setErrors(all);
      setTouched(
        Object.keys(all).reduce((acc, k) => ({ ...acc, [k]: true }), touched),
      );
      const first = firstInvalidField(all);
      if (first) {
        const el = document.getElementById(first);
        el?.focus();
        el?.scrollIntoView({ block: "center", behavior: "smooth" });
      }
      return;
    }

    setErrors({});
    dispatch({ type: "NEXT_STEP" });
  };

  const eventTypeOptions = state.eventTypes.map((et) => ({
    value: String(et.event_id),
    label: rowDisplayName(et, "event_id"),
  }));

  const card =
    "rounded-2xl border border-mgh-line bg-mgh-surface p-6 sm:p-7";

  return (
    <form onSubmit={handleSubmit} noValidate>
      <header className="mb-8">
        <p className="text-[10px] font-semibold uppercase tracking-[0.25em] text-mgh-gold">
          Step 5 of 6
        </p>
        <h2 className="mt-2 font-serif text-3xl font-medium tracking-tight text-mgh-text md:text-4xl">
          Event &amp; Booking Logistics
        </h2>
        <p className="mt-2 max-w-2xl text-sm text-mgh-muted md:text-base">
          Tell us where and when. We&apos;ll check the date against our diary as
          you go.
        </p>
      </header>

      <div className="space-y-6">
        {/* ── The occasion ─────────────────────────────────────────── */}
        <fieldset className={card}>
          <Legend icon={Users}>The Occasion</Legend>

          <div className="mt-5 grid grid-cols-1 gap-6 sm:grid-cols-2">
            <TextField
              id="guests"
              label="Number of Guests"
              required
              type="number"
              inputMode="numeric"
              min={1}
              max={GUEST_MAX}
              placeholder="e.g. 75"
              value={state.guests}
              error={errors.guests}
              onBlur={() => handleBlur("guests")}
              onChange={(e) => set("SET_GUESTS", e.target.value, "guests")}
            />

            <SelectField
              id="eventTypeId"
              label="Event Occasion / Type"
              required
              placeholder="Select an occasion…"
              options={eventTypeOptions}
              value={state.eventTypeId}
              error={errors.eventTypeId}
              onBlur={() => handleBlur("eventTypeId")}
              onChange={(e) =>
                set("SET_EVENT_TYPE", e.target.value, "eventTypeId")
              }
            />
          </div>
        </fieldset>

          <div>
            <label className="mb-2 block text-xs uppercase tracking-wider text-[#A0A0A0]">
              Event Date *
            </label>
            <input
              type="date"
              min={minimumEventDateInput}
              value={state.eventDate}
              onChange={(e) => {
                dispatch({ type: "SET_DATE", payload: e.target.value });
                setErrors((p) => ({ ...p, eventDate: "" }));
              }}
            />
          </div>
        </fieldset>

        {/* ── Venue & notes ────────────────────────────────────────── */}
        <fieldset className={card}>
          <Legend icon={MapPin}>Venue &amp; Notes</Legend>

          <div className="mt-5 space-y-6">
            <TextField
              id="eventLocation"
              label="Event Venue / Address"
              required
              placeholder="e.g. Constantia Winelands, Cape Town"
              value={state.eventLocation}
              error={errors.eventLocation}
              onBlur={() => handleBlur("eventLocation")}
              onChange={(e) =>
                set("SET_EVENT_LOCATION", e.target.value, "eventLocation")
              }
            />

            <TextAreaField
              id="notes"
              label="Special Culinary or Dietary Notes"
              rows={3}
              maxLength={NOTES_MAX}
              placeholder="Dietary requirements, kitchen facilities on site, timing notes…"
              value={state.notes}
              error={errors.notes}
              hint="Optional — allergies, service style, anything our chefs should know."
              onChange={(e) => set("SET_NOTES", e.target.value, "notes")}
            />
          </div>
        </fieldset>

        {/* ── Contact ──────────────────────────────────────────────── */}
        <fieldset className={card}>
          <Legend icon={Users}>Contact Details</Legend>
          <p className="mt-2 text-sm text-mgh-faint">
            Who should we reach about this quote?
          </p>

          <div className="mt-5 grid grid-cols-1 gap-6 sm:grid-cols-2">
            <TextField
              id="contactName"
              label="Full Name"
              required
              autoComplete="name"
              value={state.contactName}
              error={errors.contactName}
              onBlur={() => handleBlur("contactName")}
              onChange={(e) => setContact("contactName", e.target.value)}
            />

            <TextField
              id="contactPhone"
              label="Phone Number"
              type="tel"
              autoComplete="tel"
              placeholder="+27…"
              value={state.contactPhone}
              error={errors.contactPhone}
              hint="Optional, but it speeds things up."
              onBlur={() => handleBlur("contactPhone")}
              onChange={(e) => setContact("contactPhone", e.target.value)}
            />

            <div className="sm:col-span-2">
              <ReadOnlyField
                id="contactEmail"
                label="Email"
                value={state.contactEmail || state.authUser?.email}
                hint="Your quote is sent here — it comes from your account."
              />
            </div>
          </div>
        </fieldset>
      </div>

      <div className="mt-10 flex items-center justify-between border-t border-mgh-line-soft pt-6">
        <button
          type="button"
          onClick={() => dispatch({ type: "PREV_STEP" })}
          className="rounded-xl border border-mgh-line-strong px-6 py-3 text-xs font-semibold uppercase tracking-widest text-mgh-muted transition-colors hover:border-mgh-text hover:text-mgh-text focus:outline-none focus:ring-2 focus:ring-mgh-gold/40"
        >
          ← Back
        </button>

        <button
          type="submit"
          className="rounded-xl border border-mgh-gold bg-mgh-gold px-8 py-3 text-xs font-semibold uppercase tracking-widest text-mgh-gold-ink transition-all hover:bg-transparent hover:text-mgh-gold focus:outline-none focus:ring-2 focus:ring-mgh-gold/40"
        >
          Review Final Quote →
        </button>
      </div>
    </form>
  );
}

function Legend({ icon: Icon, children }) {
  return (
    <legend className="flex items-center gap-2.5 text-xs font-semibold uppercase tracking-widest text-mgh-gold">
      <Icon size={15} aria-hidden="true" />
      {children}
    </legend>
  );
}
