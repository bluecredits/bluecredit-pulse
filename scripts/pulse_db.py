import json
import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone

from pulse_schema import ENTITIES, field_types

DB_PATH = os.environ.get("DATABASE_PATH", os.path.join(os.path.dirname(__file__), "..", "data", "pulse.db"))

SQL_TYPES = {"number": "REAL"}


def now_iso():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def connect():
    os.makedirs(os.path.dirname(os.path.abspath(DB_PATH)), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


@contextmanager
def get_db():
    conn = connect()
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db():
    with get_db() as db:
        for name in ENTITIES:
            types = field_types(name)
            cols = ", ".join(f'"{f}" {SQL_TYPES.get(t, "TEXT")}' for f, t in types.items())
            db.execute(f"""CREATE TABLE IF NOT EXISTS {name} (
                id INTEGER PRIMARY KEY AUTOINCREMENT, {cols},
                meta TEXT, created_at TEXT, updated_at TEXT, updated_by TEXT)""")
            # add any columns introduced after first deploy
            existing = {r["name"] for r in db.execute(f"PRAGMA table_info({name})")}
            for f, t in types.items():
                if f not in existing:
                    db.execute(f'ALTER TABLE {name} ADD COLUMN "{f}" {SQL_TYPES.get(t, "TEXT")}')
        db.execute("""CREATE TABLE IF NOT EXISTS reviews (
            id INTEGER PRIMARY KEY AUTOINCREMENT, cadence TEXT, review_date TEXT, title TEXT,
            attendees TEXT, notes TEXT, snapshot TEXT, created_by TEXT, created_at TEXT, updated_at TEXT)""")
        db.execute("""CREATE TABLE IF NOT EXISTS activity (
            id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, user TEXT, entity TEXT, entity_id INTEGER,
            action TEXT, field TEXT, old_value TEXT, new_value TEXT, summary TEXT)""")
        for idx in ["opportunities(deadline)", "opportunities(stage)", "funding(deadline)", "funding(status)",
                    "contacts(email)", "contacts(category)", "actions(status)", "actions(review_id)",
                    "activity(ts)", "reviews(cadence, review_date)"]:
            name = "ix_" + idx.replace("(", "_").replace(")", "").replace(", ", "_")
            db.execute(f"CREATE INDEX IF NOT EXISTS {name} ON {idx}")


def row_to_dict(row):
    d = dict(row)
    if d.get("meta"):
        try:
            d["meta"] = json.loads(d["meta"])
        except (TypeError, ValueError):
            pass
    if d.get("snapshot"):
        try:
            d["snapshot"] = json.loads(d["snapshot"])
        except (TypeError, ValueError):
            pass
    return d


def log(db, user, entity, entity_id, action, summary="", field=None, old=None, new=None):
    db.execute("""INSERT INTO activity (ts, user, entity, entity_id, action, field, old_value, new_value, summary)
                  VALUES (?,?,?,?,?,?,?,?,?)""",
               (now_iso(), user, entity, entity_id, action, field,
                None if old is None else str(old), None if new is None else str(new), summary))
