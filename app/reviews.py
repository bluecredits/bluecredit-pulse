"""Builds the data snapshot behind each daily / weekly / monthly / quarterly review."""
from datetime import date, timedelta

from .db import row_to_dict
from .schema import ACTIVE_FUNDING, ACTIVE_OPP, AGENDAS, CADENCES


def _q(db, sql, args=()):
    return [row_to_dict(r) for r in db.execute(sql, args)]


def _slim(rows, keys):
    return [{k: r.get(k) for k in keys} for r in rows]


def build_snapshot(db, cadence, as_of=None):
    cfg = CADENCES[cadence]
    today = date.fromisoformat(as_of) if as_of else date.today()
    since = (today - timedelta(days=cfg["lookback"])).isoformat()
    until = (today + timedelta(days=cfg["ahead"])).isoformat()
    t = today.isoformat()
    ph_o = ",".join("?" * len(ACTIVE_OPP))
    ph_f = ",".join("?" * len(ACTIVE_FUNDING))

    snap = {"cadence": cadence, "as_of": t, "since": since, "until": until,
            "agenda": AGENDAS[cadence]}

    # --- upcoming deadlines --------------------------------------------------
    snap["opp_deadlines"] = _slim(_q(db, f"""SELECT * FROM opportunities WHERE stage IN ({ph_o})
        AND deadline >= ? AND deadline <= ? ORDER BY deadline""", (*ACTIVE_OPP, t, until)),
        ["id", "title", "agency", "deadline", "stage", "priority", "owner", "value", "value_text"])
    snap["funding_deadlines"] = _slim(_q(db, f"""SELECT * FROM funding WHERE status IN ({ph_f})
        AND deadline >= ? AND deadline <= ? ORDER BY deadline""", (*ACTIVE_FUNDING, t, until)),
        ["id", "name", "organization", "deadline", "status", "owner", "amount_text"])
    # active items whose deadline already passed without an outcome
    snap["stale"] = _slim(_q(db, """SELECT 'opportunities' AS entity, id, title AS name, deadline, stage AS status, owner
        FROM opportunities WHERE stage IN ('Identified','Qualifying','Pursuing') AND deadline < ? AND deadline <> ''
        UNION ALL
        SELECT 'funding', id, name, deadline, status, owner FROM funding
        WHERE status IN ('Identified','Pursuing') AND deadline < ? AND deadline <> ''
        ORDER BY deadline DESC LIMIT 50""", (t, t)), ["entity", "id", "name", "deadline", "status", "owner"])

    # --- action items --------------------------------------------------------
    snap["actions_overdue"] = _q(db, """SELECT * FROM actions WHERE status='Open' AND due_date <> ''
        AND due_date < ? ORDER BY due_date""", (t,))
    snap["actions_upcoming"] = _q(db, """SELECT * FROM actions WHERE status='Open'
        AND (due_date IS NULL OR due_date = '' OR (due_date >= ? AND due_date <= ?)) ORDER BY due_date""", (t, until))
    snap["actions_completed"] = _q(db, """SELECT * FROM actions WHERE status='Done' AND substr(updated_at,1,10) >= ?
        ORDER BY updated_at DESC""", (since,))

    # --- contacts / outreach -------------------------------------------------
    snap["followups_due"] = _slim(_q(db, """SELECT * FROM contacts WHERE next_step_date <> '' AND next_step_date <= ?
        AND COALESCE(status,'') NOT IN ('Do Not Contact','Dormant') ORDER BY next_step_date LIMIT 100""", (until,)),
        ["id", "name", "organization", "next_step", "next_step_date", "owner", "status"])
    snap["contacts_touched"] = db.execute("SELECT COUNT(*) FROM contacts WHERE last_touch >= ?", (since,)).fetchone()[0]

    # --- what changed --------------------------------------------------------
    acts = _q(db, "SELECT * FROM activity WHERE substr(ts,1,10) >= ? ORDER BY ts DESC LIMIT 400", (since,))
    snap["changes"] = acts[:60]
    status_moves = [a for a in acts if a["field"] in ("stage", "status") and a["entity"] in ("opportunities", "funding")]
    snap["moves"] = {
        "submitted": [a for a in status_moves if a["new_value"] == "Submitted"],
        "won": [a for a in status_moves if a["new_value"] == "Won"],
        "lost": [a for a in status_moves if a["new_value"] in ("Lost", "Missed")],
    }
    snap["created"] = {e: sum(1 for a in acts if a["entity"] == e and a["action"] == "create")
                       for e in ("opportunities", "funding", "contacts")}

    # --- pipeline (weekly+) --------------------------------------------------
    if cadence != "daily":
        snap["opp_pipeline"] = _q(db, """SELECT stage, COUNT(*) n, COALESCE(SUM(value),0) value FROM opportunities
            GROUP BY stage ORDER BY n DESC""")
        snap["funding_pipeline"] = _q(db, """SELECT status, COUNT(*) n, COALESCE(SUM(amount),0) amount FROM funding
            WHERE status <> 'Catalog' GROUP BY status ORDER BY n DESC""")

    # --- period results (monthly / quarterly) -------------------------------
    if cadence in ("monthly", "quarterly"):
        def outcome(entity, field):
            rows = _q(db, f"""SELECT new_value, COUNT(DISTINCT entity_id) n FROM activity
                WHERE entity=? AND field=? AND substr(ts,1,10) >= ? GROUP BY new_value""", (entity, field, since))
            return {r["new_value"]: r["n"] for r in rows}
        o, f = outcome("opportunities", "stage"), outcome("funding", "status")
        won, lost = o.get("Won", 0) + f.get("Won", 0), o.get("Lost", 0) + f.get("Lost", 0)
        snap["results"] = {
            "opportunities": o, "funding": f,
            "win_rate": round(100 * won / (won + lost)) if won + lost else None,
            "value_won": db.execute("""SELECT COALESCE(SUM(value),0) FROM opportunities WHERE stage='Won'
                AND id IN (SELECT entity_id FROM activity WHERE entity='opportunities' AND new_value='Won'
                AND substr(ts,1,10) >= ?)""", (since,)).fetchone()[0],
            "funding_submitted_by_date": db.execute("""SELECT COUNT(*) FROM funding
                WHERE submitted_date >= ? AND submitted_date <= ?""", (since, t)).fetchone()[0],
        }
        snap["by_owner"] = _q(db, f"""SELECT COALESCE(NULLIF(owner,''),'Unassigned') owner,
            SUM(CASE WHEN src='o' AND status IN ({ph_o}) THEN 1 ELSE 0 END) active_opps,
            SUM(CASE WHEN src='f' AND status IN ({ph_f}) THEN 1 ELSE 0 END) active_funding,
            SUM(CASE WHEN status='Submitted' THEN 1 ELSE 0 END) submitted,
            SUM(CASE WHEN status='Won' THEN 1 ELSE 0 END) won
            FROM (SELECT owner, stage status, 'o' src FROM opportunities
                  UNION ALL SELECT owner, status, 'f' FROM funding WHERE status <> 'Catalog')
            GROUP BY 1 ORDER BY active_opps + active_funding DESC""", (*ACTIVE_OPP, *ACTIVE_FUNDING))

    # --- carry-over from the last review of this cadence --------------------
    prev = db.execute("""SELECT id, review_date, title FROM reviews WHERE cadence=? AND review_date < ?
        ORDER BY review_date DESC LIMIT 1""", (cadence, t)).fetchone()
    snap["previous_review"] = dict(prev) if prev else None
    snap["carry_over"] = _q(db, "SELECT * FROM actions WHERE review_id=? AND status='Open'", (prev["id"],)) if prev else []
    return snap
