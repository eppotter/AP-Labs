---
owner: Ely Potter          # the named client person who owns this file
signed_off: 2026-10-31  # pending, or the ISO date (YYYY-MM-DD) the owner signed off
signed_off_by: "Ely Potter (2026-10-31)"  # who signed off: the owner, recorded by a facilitator
updated: 2026-10-31        # ISO date of the last edit
---

# Organisation context

Drafted by Scribe from the Onboarder's findings; every agent reads it. Write only what a client
source supports, and mark anything inferred as _inferred_. No secrets, no personal data.
Brightside is fictional.

Until 2026-10-31 these files named a fictional owner, Dana Reyes, played by Ely; lines that say
"Ely as Dana Reyes" are kept as history. Ely Potter owns and signs them since 2026-10-31 (plan
brightside-v1, Story 18.1).

## What the company does

Brightside Home Cleaning is a residential cleaner working across five service zones. Its clients
are households: about 2,000 client accounts at 2026-09-30. A household can have more than one home.

It sells recurring plans (weekly, every two weeks or monthly) and one-off visits. There are three
packages (Standard clean, Deep clean and Move-out clean) and five add-ons (Baseboards, Inside
fridge, Laundry fold, Inside oven and Interior windows).

It makes money by invoicing each completed visit. Clients pay by card or bank transfer (ACH),
in full or in parts. The data history runs from 2024-10-01 to 2026-09-30.

## Teams

**Field crews.** There are 15 crews, three per zone (for example "North crew A"). Each crew has
three members, one of whom is the crew lead. Cleaners and crew leads are paid by the hour. Staff
join, leave and move between crews.

**Office and owners** (_inferred_). Ely Potter is the admin and owns the client files; Steven
Auslander is an admin with the same grants; Marcus Lee is a member. Their job titles are not recorded.

## Tools and systems

Brightside uses a CRM for client records and an email tool for campaign lists, such as win-back.
Both are mocks.

The Brightside bot lives in Slack (`/brightside`) and opens a menu: Say hello and Dataset (open to
everyone) and Email outbox (admin only). Planned entries are Win-back list, Unpaid invoices and
Labour cost (owner and admin only).

The shared data sits in MotherDuck; the bot reads it but never writes. Connection details are in
`connectors.md`.

## Vocabulary

- **Zone:** one of North, South, East, West and Central. A client's zone is where they live.
- **Plan:** a recurring cleaning schedule for one home. It "lapses" when it ends.
- **Win-back:** asking clients whose plan recently lapsed to come back.
- **Crew-day:** one crew's working day.
- Data terms (active, lapsed, billed, paid, outstanding, labour cost) are defined in `data.md`.

## Sources

- `profiles/brightside/profile.yml` (users, resources): 2026-10-25.
- `docs/planning/specs/spec-runtime/fixture-tables.md` and `examples/brightside/fixture/lib/reference.js`
  (zones, crews, packages, add-ons, plans): 2026-10-25.
- `examples/brightside/app/` (connectors, modules, hub): 2026-10-25.
- No interview with Brightside people: the client is fictional, and Ely Potter signs (until
  2026-10-31 as a fictional owner, Dana Reyes).
