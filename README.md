# BlueCredit Pulse

Internal pipeline and business-review tool for BlueCredit Inc. It replaces the BD Tracker
workbook, the contact spreadsheets and the Daily Business Review Word doc with one shared app.

## What's in it

| Page | What it holds | Came from |
|---|---|---|
| **Today** | Deadlines in the next 14 days, your open actions, pipeline by stage, review rhythm | — |
| **Reviews** | Daily, weekly, monthly, quarterly reviews. Each opens with a live snapshot, then notes and action items | Daily Business Review .docx |
| **Opportunities** | Consulting bids, federal forecasts, EPA forecast, water credit projects | BD Tracker (Consulting, Water Credit Projects), EPA Opportunities, forecast export |
| **Funding** | Applications pipeline plus the funding catalog (status *Catalog*) | BD Tracker (Funding Applications), funding_db |
| **Contacts** | Government POCs, corporates, investors, primes, partners, NGOs, experts, mailing list — de-duplicated by email | All contact sheets, SBIC list, DEQ, simplified acquisitions, industrial sites |
| **Action items** | Who does what by when, linked to a review and/or a record | — |
| **Resources** | Bid boards, forecast portals, below-SAT strategy, district offices, feasibility programs | FedAgency BidBoard, BD Tracker (Feasibility) |
| **Activity log** | Every add, edit, status change and delete | — |

### How reviews work

| Cadence | Looks back | Looks ahead | Adds |
|---|---|---|---|
| Daily | 1 day | 7 days | — |
| Weekly | 7 days | 30 days | Pipeline by stage |
| Monthly | 31 days | 60 days | Win rate, value won, results by owner |
| Quarterly | 92 days | 120 days | Same, over the quarter |

Every snapshot shows: open actions carried over from the last review of the same cadence,
overdue actions, upcoming deadlines, what moved (submitted / won / lost / new records),
contact follow-ups due, and active items whose deadline passed without an outcome.
"Refresh snapshot" re-runs it. Notes autosave. "Print" gives a clean copy to share.

Status changes are what drive the monthly/quarterly numbers, so move items to *Submitted*,
*Won* or *Lost* in the app as they happen.

## Run locally

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python scripts/import_spreadsheets.py /path/to/spreadsheets --reset   # one-time load
APP_USERS="barasa:pw,sohaib:pw" SECRET_KEY=dev uvicorn app.main:app --reload
# open http://localhost:8000
```

Without `APP_USERS` the app falls back to `admin` / `admin` for local testing only.

## Deploy from git

The repo has a `Dockerfile` (works on Render, Railway, Fly.io, or any VPS) and a
`render.yaml` blueprint.

**Render (simplest):**
1. Push this repo to a **private** GitHub repo.
2. Render → New → Blueprint → pick the repo. It builds the Dockerfile and attaches a 1 GB disk at `/data` for the database.
3. In the service's Environment tab set `APP_USERS` = `barasa:…,sohaib:…,robert:…,beckee:…`.
4. Load the data once (pick one):
   - Render Shell: upload the spreadsheets to `/data/import`, then `python scripts/import_spreadsheets.py /data/import`
   - Or run the importer locally and upload `data/pulse.db` to `/data/pulse.db`
   - Or set `IMPORT_DIR` to a folder with the files; the app imports on first boot when the database is empty

Every push to `main` redeploys; the database on the disk is untouched. GitHub Actions runs
`scripts/smoke_test.py` on every push.

> GitHub Pages can't host this — it only serves static files, and the team needs a shared database.

## Backups

The whole dataset is one SQLite file (`DATABASE_PATH`). Copy it on a schedule, and every
list page has **Export CSV**.

## Customizing

- Fields, option lists, owners, review windows and agendas all live in `app/schema.py`.
  Add a field there and it appears in the forms, tables, search and CSV export; the column is
  added to the database on next start.
- `APP_NAME` changes the display name.
- **Import CSV** on any list page bulk-adds rows; headers can be field names or labels.

## Data notes

- The *Username/Pw* column from the Subcontract Applications sheet is **not** imported.
  Keep vendor-portal credentials in a password manager.
- Reference sheets in watercontacts_db (US counties, private schools, universities) are not imported.
- The funding catalog (~2,400 programs) is kept separate as status *Catalog*. Move one to
  *Identified* to put it in the pipeline.
- Forecast items use the estimated solicitation date as the due date.
