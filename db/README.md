# Database

**New to this project? Start with [`schema.sql`](schema.sql).** It is a
generated, commented snapshot of the entire `public` schema — every table,
enum, foreign key, index, function and RLS policy, plus a map of how the
tables relate and a list of known issues. It is documentation, not a
migration: nothing runs it, and it is not part of the numbered sequence below.

Regenerate it whenever the schema changes — ask Claude Code
("regenerate db/schema.sql from the live database"), since the Supabase MCP
server is already configured in `.mcp.json`.

It is **stale as of 006**: that migration adds the `enquiry_menu_items` table,
seven columns to `enquiries` and four functions, and it fixes known issue (a)
in section 8 — the world-readable `enquiries` policy. Regenerate after running
it.

## Migrations

These are SQL files for the hosted Supabase project. Run them in numerical
order, either by pasting into the **Supabase SQL editor** or via the Supabase
MCP server's `apply_migration` (which also records them in migration history —
see "Migration history" below).

Every file is safe to re-run.

| File | What it does | Required by |
|---|---|---|
| `001_orders_special_requests.sql` | Adds `orders.special_requests` so the menu builder's dietary/logistics notes are actually stored | Menu builder submit |
| `002_get_booked_slots.sql` | `get_booked_slots(from, to)` — the availability lookup that powers the date picker | Menu builder date step |
| `003_create_menu_order.sql` | `create_menu_order(...)` — writes the order and its line items in one transaction | Menu builder submit (optional) |
| `004_lock_down_function_grants.sql` | Revokes the default `PUBLIC` EXECUTE grant from the `SECURITY DEFINER` functions, and pins `set_updated_at`'s `search_path` | Security — **not** optional |
| `005_testimonials_curation.sql` | Ties a review to the event it is about, adds the admin's `featured` / `display_order` controls, splits the SELECT policy by role, and adds `get_public_testimonials()` so anonymous visitors can see reviewers' names without the `customer` table being readable | Testimonials — customer submission, admin moderation, homepage carousel |
| `006_menu_builder_enquiries.sql` | Routes the Interactive Menu Builder through the enquiry approval process instead of writing orders directly. Widens `enquiries`, adds `enquiry_menu_items`, `create_menu_enquiry()`, `set_enquiry_status()` and `get_booked_sessions()`, and closes the world-readable `enquiries` policy | Menu builder submit, admin approval — **not** optional |

## The app works without these

001, 002, 003 and 005 are **optional**. 004 and 006 are not — see below. The menu builder detects a missing function or
column and degrades:

- No `get_booked_slots` → the availability panel shows a neutral "live
  availability isn't connected yet" message and **every date stays bookable**.
  It deliberately does not disable dates when the lookup fails, because that
  would silently make the product unbookable.
- No `create_menu_order` → falls back to two separate inserts plus a
  compensating delete if the second one fails.
- No `special_requests` column → the insert is retried once without it and the
  note is dropped, with a console warning.
- No `get_public_testimonials` → the homepage testimonial section and the
  dashboard review card hide themselves rather than erroring, and the customer
  "Leave a review" page explains that reviews are not connected yet. Nothing
  on the marketing site renders a broken or empty block.

Running them turns on early conflict warnings, atomic writes, note storage, and
customer reviews.

## 004 is a security fix, not a feature

Postgres grants `EXECUTE` on every new function to `PUBLIC`, and both `anon` and
`authenticated` inherit from `PUBLIC`. Any function in an exposed schema is
therefore a live endpoint at `/rest/v1/rpc/<name>` unless you revoke that grant.
When the function is also `SECURITY DEFINER` it runs as its owner and bypasses
RLS entirely, so it can hand out exactly the data the policies were written to
protect.

Two functions were reachable with nothing but the publishable key that ships in
the browser bundle:

- `get_admin_user_ids()` — every admin's auth `user_id`, to anyone.
- `get_calendar_events()` — the date, time window and event type of **every**
  order, to anyone, with no range cap. Note that this is the same data
  `002_get_booked_slots.sql` goes to some trouble to withhold.

`is_admin()` deliberately keeps its grant to `anon`: the `{anon,authenticated}`
policy "anyone can view approved testimonials" calls it, and policy expressions
run with the *caller's* privileges. Revoking it would break the public
testimonials list rather than secure anything. The function answers only "is the
caller an admin", which is `false` for every anonymous caller.

Confirm the result with:

```sql
select p.proname,
       pg_get_function_identity_arguments(p.oid) as args,
       p.prosecdef as security_definer,
       p.proconfig,
       p.proacl
from pg_proc p
where p.pronamespace = 'public'::regnamespace
order by p.proname;
```

A bare `=X/postgres` entry in `proacl` **is** the `PUBLIC` grant. After 004 the
only function that should still show one is `is_admin`.

## 006 changes what `orders` means

Before 006 the menu builder inserted straight into `orders`. That made a
request indistinguishable from a booking: the row immediately held the slot
through the `orders_no_overlap` exclusion constraint, showed up on the
customer's Orders page, and was eligible for a consultation — all before a
human had read it. The admin Enquiries screen, which is where the approval
process actually lives, never saw it at all.

After 006, `orders` means **approved booking** and nothing else:

```
menu builder
   └─> enquiries (pending) + enquiry_menu_items
          │
     admin confirms  ->  set_enquiry_status(id, 'confirmed')
          │
          └─> orders (confirmed) + customer_menu_items
                 └─> consultations -> invoices
                 └─> orders_no_overlap now applies
```

Two consequences worth knowing before you debug something:

- **Two customers can request the same slot.** The exclusion constraint only
  gets a say at approval, so the *second approval* is what fails, with 23P01.
  That is deliberate: which request wins is an admin's decision, not the
  outcome of a race between two customers. The admin UI surfaces the clash.
- **`get_booked_slots` (002) now reports confirmed bookings only**, because
  pending requests are no longer orders. The menu builder's availability panel
  is correspondingly less conservative — it warns about locked slots, not
  about other people's outstanding requests.

`create_menu_order` (003) is left installed so an older client bundle still
works, but nothing in the app calls it any more.

### Why 006 is not optional

It closes known issue (a) from `schema.sql` section 8: the policy "Allow public
read on enquiries" is granted to `PUBLIC` with `USING (true)`, and because
permissive policies are OR'd it defeats both narrow policies on the table —
every lead's name, email, phone and message was readable with the publishable
key. 006 adds venue address, price and `customer_id` to that same table, so
shipping the two halves separately would mean publishing those too.

The policy only survived this long because three components read `session` off
it to work out availability. `get_booked_sessions(date)` gives them exactly
that and nothing else, so all three now call the RPC:

- `app/sections/EnquiryForm.jsx`
- `app/components/contact/SessionDropDown.jsx`
- `app/components/dashboard/customer/enquiry/EnquiryContent.jsx`

The third one matters most: it runs as a signed-in customer, and availability
depends on *other* customers' confirmed enquiries. Without the RPC it would
report every date as free rather than erroring, which is the kind of bug that
takes a double-booking to notice.

## Migration history

`supabase_migrations.schema_migrations` is currently **empty** — 001 to 003 were
pasted into the SQL editor, so Supabase has no record that they ran. The
database and this directory can drift with nothing to detect it, and the schema
cannot be rebuilt from source.

Applying each file with `apply_migration` (rather than the SQL editor) backfills
that history. Because every file is idempotent, re-applying them against a
database that already has them is a no-op apart from the history rows.

## Verify

```sql
-- 001
select column_name from information_schema.columns
where table_name = 'orders' and column_name = 'special_requests';

-- 002
select * from public.get_booked_slots(current_date, current_date + 60);

-- 003
select oid::regprocedure from pg_proc where proname = 'create_menu_order';
```

## One thing to check before running 002

`get_booked_slots` treats an order as blocking unless its status is
`cancelled`. That must match the `WHERE` clause of the exclusion constraint on
`public.orders`, otherwise the calendar and the database will disagree about
which slots are free. Check with:

```sql
select conname, pg_get_constraintdef(oid)
from pg_constraint
where conrelid = 'public.orders'::regclass and contype = 'x';
```

`public.order_status` has exactly five labels — `pending`, `confirmed`,
`in_progress`, `completed`, `cancelled`. Naming any other label in that filter
is not a harmless no-op: the literal is cast to the enum and the function fails
with `22P02 invalid_text_representation` on every call.

An earlier version of 002 filtered on `'declined'` and `'rejected'` (both are
`testimonial_status` labels, not `order_status`), so `get_booked_slots` threw on
every invocation. The menu builder's graceful degradation then did its job a
little too well — the availability panel showed "live availability isn't
connected yet" and left every date bookable, which looks identical to the
function simply not being installed. Check the labels before changing that
filter:

```sql
select enumlabel from pg_enum
where enumtypid = 'public.order_status'::regtype
order by enumsortorder;
```

## Type safety

`003` uses `%TYPE` anchors and `jsonb_populate_recordset` rather than
hardcoding `uuid` or `bigint`, so it adopts whatever key types the tables
already use. Nothing here needs adjusting for the schema.

## Environment variables

The email routes read these (see `.env.example`):

```
MGH_ADMIN_EMAIL      # REQUIRED - who gets booking notifications
MGH_FROM_EMAIL       # leave UNSET until a domain is verified in Resend
MGH_REPLY_TO         # optional
NEXT_PUBLIC_SITE_URL # used for dashboard deep-links in emails
```

### Sandbox mode (current setup)

No domain is verified in Resend yet, so the app runs in **sandbox mode**:

- Mail is sent from `onboarding@resend.dev`.
- Resend will **only deliver to the address that owns the Resend account**.
  `MGH_ADMIN_EMAIL` must be that address, or every send returns 403.
- Customer-facing mail is **redirected to that same inbox**, with a gold banner
  at the top naming who it was really for and the subject prefixed
  `[Sandbox → someone@example.com]`. That way both templates can still be read
  and reviewed without a domain.
- Only the first `MGH_ADMIN_EMAIL` address is used, since sandbox rejects a
  send the moment any recipient isn't the owner.

To go live: verify `mlangeni.co.za` in Resend (add the DNS records it lists),
then set `MGH_FROM_EMAIL`. Nothing else changes — the redirect switches off on
its own and customers start receiving their own mail.

Booking success never depends on email success in either mode.
