# BlueCredit Pulse

BlueCredit's internal workspace. One sign-in opens a landing page with the team's apps:

| Address | App | What it's for |
|---|---|---|
| `/` | **Landing page** | Sign in or join with the company code; launches every app; links to the other BlueCredit sites |
| `/review/` | **Business Review** | Opportunities, funding, contacts, action items, and daily / weekly / monthly / quarterly reviews |
| `/tickets/` | **Tickets** | My requests, My approvals, My assets: equipment, purchases, time off, travel, access and IT help |

- **Site:** https://bluecredits.github.io/bluecredit-pulse/ (GitHub Pages, from the `web/` folder; no build step)
- **Data and logins:** one Supabase project shared by all the apps. Nothing confidential is stored in this repo.
- **Access:** join with the **company code** on the landing page, then sign in with email and password.
  Without the code an account sees nothing; the database enforces this, not just the page.

### Code layout

```
web/index.html, hub.js     landing page: sign-in, join, password reset, app launcher
web/core.js                shared by every app: Supabase client, sign-in check, helpers, file readers
web/icons.js, style.css    shared icon set and styles (matches the Marketplace look)
web/config.js              Supabase URL + publishable key
web/review/                Business Review app
web/tickets/               Tickets app
supabase/schema.sql        the whole database: tables, security rules, functions (safe to re-run)
```

To add another app: make `web/<app>/index.html` that loads `../core.js` and calls `requireMember()`,
then add a tile to `APPS` in `web/hub.js`.

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

## Business Review

| Page | What it holds |
|---|---|
| **Today** | Deadlines in the next 14 days, your open actions, pipeline by stage, review rhythm |
| **Reviews** | Daily, weekly, monthly, quarterly. Each opens with a live snapshot, then notes and action items |
| **Opportunities** | Consulting bids, federal and EPA forecasts, water credit projects |
| **Funding** | Applications pipeline plus the funding catalog (status *Catalog*) |
| **Contacts** | Government POCs, corporates, investors, primes, partners, NGOs, experts, mailing list |
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
