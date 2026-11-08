# Pulse, by BlueCredit

A workspace for startups. Any company can **Start a workspace** and gets its own private space; teammates join with
the company's code, contractors and consultants with a separate contractor code. One sign-in opens the apps:

| Address | App | What it's for |
|---|---|---|
| `/` | **Landing page** | Signed out: what Pulse does, the apps, pricing, FAQ, and sign in / start / join. Signed in: launches every app |
| `/help/` | **Help Center** | Public guides for every app (also the **?** in every top bar, which opens the topic for the app you're in) |
| `/review/` | **Business Review** | Opportunities, action items, and daily / weekly / monthly / quarterly reviews |
| `/contacts/` | **Contacts** | Government POCs, primes, partners, investors, experts, mailing list; import and follow-ups |
| `/funding/` | **Funding** | Grant and loan applications in progress, plus the funding catalog |
| `/opportunities/` | **Opportunities** | Two tabs: Contracts (sub-tabs Federal from SAM.gov and Bids from MyBidMatch: federal, state, local, education) and Grants (Grants.gov) from saved searches checked on a schedule (default once a day); add a contract to the pipeline or a grant to Funding |
| `/timecards/` | **Timecards** | Weekly timesheets by project, approvals, hours and amounts by project |
| `/people/` | **People** | Hiring (openings with a public apply link, candidate board, interviews, blind scorecards), then onboarding checklists, invite and offboarding. `/onboarding/` redirects here |
| `/careers/?c=…` | Careers page | Public list of a company's Open openings, turned on in People → Hiring setup; `careers/embed.js` puts it inside the company's own website |
| `/apply/?t=…` | Apply page | Public, no sign-in: the opening's description and an application form with resume upload |
| `/projects/` | **Projects** | Portfolio, schedule, task board, team, budget vs. actual, documents, risks, status reports, close-out |
| `/agreements/` | **Agreements** | Teaming, consulting, confidentiality agreements and amendments: fill in, e-sign, amend, close out |
| `/sign/` | **Signing page** | Public page a signer opens from their private link (no Pulse account needed) |
| `/scheduler/` | **Scheduler** | Everyone's Google/Outlook free/busy, find a time, book with invites |
| `/chief/` | **Chief of Staff** | AI chief of staff (Claude): daily brief, Q&A, suggestions, reminders |
| `/admin/` | **Admin** | Team, roles, codes, workspace settings (name, logo, lists, tools, AI name) |
| `/tickets/` | **Tickets** | My requests, My approvals, My assets: equipment, purchases, time off, travel, access and IT help |

- **Site:** https://pulse.bluecredits.org (Contabo, see `deploy/DEPLOY_CONTABO.md`) and
  https://bluecredits.github.io/bluecredit-pulse/ (GitHub Pages, from `web/`; no build step).
- **Data and logins:** one Supabase project for every company. Each company is a **workspace**; every row carries its
  `workspace_id` and row-level security only shows a person their own workspace's rows. Nothing confidential is in this repo.
- **Roles:** *admin* (creates the workspace or is promoted), *member* (joins with the company code), *contractor*
  (joins with the contractor code; sees only Timecards for their projects, their onboarding checklist, Tickets and Scheduler).
- **Server functions:** `supabase/functions/calendar` (Google/Outlook) and `supabase/functions/chief` (Claude) run on
  the Contabo server or as Supabase Edge Functions. Secrets live only there.

### Code layout

```
web/index.html, hub.js     landing page: sign-in, join, password reset, app launcher
web/core.js                shared by every app: Supabase client, sign-in check, helpers, file readers
web/icons.js, style.css    shared icon set and styles (matches the Marketplace look)
web/config.js              Supabase URL + publishable key
web/records.js, schema.js  records engine shared by Business Review, Contacts and Funding (fields, lists, reviews)
web/packs.js               starter packs (lists and agendas a new workspace starts with)
web/review/                Business Review app
web/contacts/              Contacts app
web/funding/               Funding app
web/tickets/               Tickets app
web/timecards/, people/, apply/, scheduler/, chief/, admin/   the other apps
supabase/functions/        calendar and chief server functions (Deno) + tests
deploy/                    Contabo: install.sh, nginx site, systemd services, DEPLOY_CONTABO.md
supabase/schema.sql        the whole database: tables, security rules, functions (safe to re-run; upgrades old installs)
supabase/bluecredit_workspace.sql   one-time: BlueCredit's own lists after the multi-company upgrade
```

Business Review, Contacts and Funding share one records engine. Each app's `index.html` has its own
sidebar and sets `window.PULSE_APP = { home: ... }`; a link to a page that belongs to another app
(for example a Funding card on the Today page) opens that app.

To add another app: make `web/<app>/index.html` that loads `../core.js` and calls `requireMember()`,
then add a tile to `APPS` in `web/hub.js`.

## Opportunities: federal contracts (SAM.gov) and grants (Grants.gov)

- **How it runs:** a database timer (pg_cron, every 5 minutes) asks SAM.gov's Get Opportunities API for today's notices on each
  workspace's schedule (default once a day; down to every 15 minutes) through pg_net, stores them, and matches every active search locally.
  The number of searches doesn't change how many API requests are used. Once a day it also re-reads yesterday's notices.
- **API key:** each workspace's admin pastes their own SAM.gov public API key in Federal → Settings. It's stored in Supabase Vault
  (encrypted) and never sent to the browser. Keys expire every 90 days; the app shows SAM.gov's error when it needs a new one.
  A personal key allows 10 requests a day without a role on the entity's SAM registration, 1,000 with one.
- **Grants:** when a workspace has an active grants search, each check also reads all open and forecasted grants from Grants.gov's
  search2 API (no key). Grants searches filter by assistance listing (ALN prefixes), agency, status and keywords.
- **Matches:** Contracts and Grants tabs, each New / Saved / Dismissed / Added. **Add to pipeline** creates a Business Review
  opportunity (stage Identified); **Add to Funding** creates a Funding record (type Grant, status Identified).
- **Bid Match:** an admin pastes the private MyBidMatch link (`mybidmatch.outreachsystems.com/go?sub=…`, kept in Vault). Each check reads the
  list of days, each new day's list (last 3 days only) and each new bid's page once, and sorts bids into Federal / State / Local / Education from the
  buyer and the notice text. This is how Virginia eVA (VBO) bids come in. If MyBidMatch changes its page layout, the parser in
  `fed_store_bm` needs updating.
- **Setup:** in Supabase turn on the `pg_net` and `pg_cron` extensions (Vault is on by default), then run `supabase/schema.sql`;
  it creates the `pulse-federal` timer. Settings shows whether each piece is on.
- **Not connected:** FedConnect has no public API (its contracts over $25K also post to SAM.gov); eVA's open data is yearly spend
  history only and its bid board has no API. `/federal/` redirects to `/opportunities/`.

## Agreements

- **Templates** (`web/agreements/templates.js`): Teaming, Consulting, Confidentiality & Assignment, Amendment. Governing law is
  chosen per agreement (country, then state/province); venue and notice wording follow it. Workspaces can edit the wording or
  add their own templates; any `{{placeholder}}` without a defined field becomes a form field. Special provisions are added
  as numbered sections. Company details (legal name, entity, address, signer) live in Agreements → Templates.
- **Signing:** sending locks the text and stores its SHA-256 fingerprint. Each signer gets a private link
  (`/sign/#<token>`; only a hash of the token is stored). Signing records a typed or drawn signature, consent to sign
  electronically, time, IP address and browser. When everyone has signed the agreement becomes Active and the linked
  onboarding checklist ticks the matching items. Signed elsewhere? **Upload signed copy** (stored in the database, 10 MB max).
- **Lifecycle:** Draft → Out for signature → Active → (Amendments) → Expired / Terminated → close-out checklist → Closed out.
  Declined or voided agreements can be copied into a corrected draft.
- The wording is a starting point, not legal advice: have counsel review it for the places you use it.

## Projects

Projects share the Timecards `projects` table. Each has a manager, dates, contract value, cost budget and budget hours;
milestones (shown on a timeline), tasks (board and list), team (from Timecards), costs (labor from approved and pending
hours × rates, plus other costs), agreements, risks/issues/decisions/changes, and weekly status reports that prefill from
finished tasks and upcoming milestones. Close-out checks open tasks, milestones, agreements and unapproved timesheets.
Contractors see only their assigned projects (milestones and tasks; they can move their own tasks).

## Tickets

- **Request types:** IT support, New equipment, Purchase or expense, Time off, Travel, Access or account,
  Asset problem, Return an asset, Other. Equipment, purchases, time off, travel and access need approval.
- **Approvals:** the requester picks an approver (default: an admin). Nobody approves their own request,
  except an admin when there is no other admin yet. Rejecting needs a reason, which the requester sees.
- **Fulfilment:** admins (or whoever a request is assigned to) start and finish approved and open requests.
  Finishing a *Return an asset* request checks the asset back into the register; an *Asset problem* marks it
  In repair while it's being fixed.
- **Privacy:** a request is visible only to the requester, the approver, the assignee and admins. Requests are
  not written to the team-wide activity log; each has its own timeline of comments and status changes.
- **Assets:** everyone sees what's assigned to them; admins manage the register (add, assign, import a
  spreadsheet, export CSV).

## Contacts and Funding

- **Contacts:** views for working contacts, follow-ups due and everyone. **Import contacts** reads a
  spreadsheet or CSV, matches its columns, combines duplicates and uploads in one step.
- **Funding:** views for active applications, all applications, catalog programs with open deadlines
  and the whole catalog. Move a catalog program to *Identified* to put it in the pipeline.
- Both still feed the business reviews: funding deadlines, wins and contact follow-ups show up in
  every review snapshot.

## Business Review

| Page | What it holds |
|---|---|
| **Today** | Deadlines in the next 14 days, your open actions, pipeline by stage, review rhythm |
| **Reviews** | Daily, weekly, monthly, quarterly. Each opens with a live snapshot, then notes and action items |
| **Opportunities** | Consulting bids, federal and EPA forecasts, water credit projects |
| **Action items** | Who does what by when, linked to a review and/or a record |
| **Resources** | Bid boards, forecast portals, below-SAT strategy, district offices, feasibility programs |
| **Activity log** | Every add, edit, status change and delete, with who did it |
| **Team** | Members, roles, the company code (admins only) |

### Reviews

| Cadence | Looks back | Looks ahead | Adds |
|---|---|---|---|
| Daily | 1 day | 7 days | — |
| Weekly | 7 days | 30 days | Pipeline by stage |
| Monthly | 31 days | 60 days | Win rate, value won, results by owner |
| Quarterly | 92 days | 120 days | Same, over the quarter |

Every snapshot shows open actions carried over from the last review of the same type, overdue
actions, upcoming deadlines, what moved (submitted / won / lost / new), contact follow-ups due, and
active items whose deadline passed without an outcome. Notes autosave. **Print** gives a clean copy.

Wins, losses and win rate come from status changes made in the app, so move items to
*Submitted*, *Won* or *Lost* as it happens.

## One-time setup (about 10 minutes)

### 1. Create the database
1. Create a free project at [supabase.com](https://supabase.com) (region: US East).
2. **SQL Editor → New query**, paste all of [`supabase/schema.sql`](supabase/schema.sql), click **Run**.
3. Optional but recommended for an internal team: **Authentication → Sign In / Providers → Email** →
   turn off **Confirm email**, so people can sign in right after joining.
4. **Authentication → URL Configuration**: set **Site URL** to
   `https://bluecredits.github.io/bluecredit-pulse/` (needed for confirmation and password-reset links).

### 2. Connect the site
In **Project Settings → API** copy the **Project URL** and the **anon / publishable** key into
[`web/config.js`](web/config.js) and push. Those two values are designed to be public. Row-level
security is what protects the data. **Never** put the `service_role` / secret key in this repo.

### 3. Turn on GitHub Pages
Repo **Settings → Pages → Source: GitHub Actions**. Every push that touches `web/` redeploys.
The site appears at `https://bluecredits.github.io/bluecredit-pulse/`.

### 4. Load the existing data
```bash
pip install -r scripts/requirements.txt
python scripts/load_supabase.py --db-url "<Supabase: Connect → Session pooler → URI>" \
    --spreadsheets /path/to/the/spreadsheets
```
The spreadsheets stay on your computer; only the database receives them. Use `--replace` to
wipe and reload. Keep the connection string private: it contains the database password.

### 5. Get the team in
1. You join first. Open the site, choose **Join with company code**, and enter the code. The first
   person to join becomes **admin**. To see the starting code, run
   `select value from settings;` in the Supabase SQL Editor.
2. On the **Team** page, copy the code and send it to teammates. They join the same way, as members.
3. **Change code** stops new sign-ups with the old code. **Turn off** removes someone immediately.

## Customizing

- Fields, option lists, owners, review windows and agendas: [`web/schema.js`](web/schema.js).
  A new field also needs a column. Add it in `supabase/schema.sql` and run
  `alter table public.<table> add column <name> text;` in the SQL Editor.
- App name: `appName` in `web/config.js`.
- **Import CSV** on any list page bulk-adds rows. Headers can be field names or labels.
  **Export CSV** downloads exactly what the current filter shows.

## Backups

Supabase takes daily backups on paid plans. On the free plan, use **Export CSV** on each page,
or `pg_dump` with the connection string.

## Data notes

- The *Username/Pw* column from the Subcontract Applications sheet is **not** imported.
  Keep vendor-portal credentials in a password manager.
- Reference sheets in watercontacts_db (US counties, private schools, universities) are not imported.
- The funding catalog (~2,400 programs) is kept separate as status *Catalog*. Move one to
  *Identified* to put it in the pipeline.
- Forecast items use the estimated solicitation date as the due date.

## Plans and billing
- **Starter $3**, **Pro $6**, **Enterprise $10** per staff user per month (contractors free; yearly = 10 months).
  Starter: Business Review, Contacts, Funding, Timecards, Tickets, People (team and onboarding; up to 10 users).
  Pro adds Opportunities, Projects, Agreements, Hiring. Enterprise adds Chief of Staff and Scheduler.
- New workspaces get 14 days of Pro. The plan is enforced in the database (`ws_has_app`, restrictive `plan_gate` policies,
  checks in the apps' functions, the Opportunities timer) and by the server functions (402 for Scheduler / Chief).
- **Admin → Plan and billing**: plan, users, monthly total, choose a plan. Pulse operators (table `pulse_operators`) see every
  workspace and set plans for invoiced or complimentary companies.
- **Card payments**: `supabase/functions/billing` (Stripe Checkout, customer portal, seat sync, webhook). Deploy it with
  Verify JWT off and secrets `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `SITE_URL`; point a Stripe webhook at
  `/functions/v1/billing/webhook` for `checkout.session.completed` and `customer.subscription.*`. Until then, Choose a plan
  opens an invoice request to support@bluecredits.org.
