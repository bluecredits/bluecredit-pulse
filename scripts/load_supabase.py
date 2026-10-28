"""Load BlueCredit's data into the Supabase database.

    pip install psycopg2-binary openpyxl python-docx
    python scripts/load_supabase.py --db-url "postgresql://postgres.xxxx:PASSWORD@aws-0-us-east-1.pooler.supabase.com:5432/postgres" \
        --spreadsheets /path/to/folder-with-the-spreadsheets

    or, if you already have the prepared database file (pulse.db):
    python scripts/load_supabase.py --db-url "..." --sqlite pulse.db

Get the connection string in Supabase: Connect (top bar) → Session pooler → URI.
Run supabase/schema.sql first. Add --replace to wipe and reload the six data tables.
The connection string contains your database password: keep it out of git and chat.
"""
import argparse
import json
import os
import sqlite3
import subprocess
import sys
import tempfile

import psycopg2
from psycopg2.extras import execute_values

TABLES = ["reviews", "opportunities", "funding", "contacts", "resources", "actions"]  # reviews before actions (FK)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db-url", required=True, help="Supabase Postgres connection string")
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--sqlite", help="Prepared pulse.db file")
    src.add_argument("--spreadsheets", help="Folder with the original spreadsheets")
    ap.add_argument("--replace", action="store_true", help="Empty the data tables first")
    a = ap.parse_args()

    path = a.sqlite
    if a.spreadsheets:
        path = os.path.join(tempfile.mkdtemp(), "pulse.db")
        here = os.path.dirname(os.path.abspath(__file__))
        subprocess.run([sys.executable, os.path.join(here, "import_spreadsheets.py"), a.spreadsheets, "--reset"],
                       env={**os.environ, "DATABASE_PATH": path}, check=True)
    lite = sqlite3.connect(path)
    lite.row_factory = sqlite3.Row

    pg = psycopg2.connect(a.db_url)
    pg.autocommit = False
    cur = pg.cursor()
    counts = {t: cur.execute(f"select count(*) from public.{t}") or cur.fetchone()[0] for t in TABLES}
    if any(counts.values()) and not a.replace:
        sys.exit(f"The database already has data ({counts}). Re-run with --replace to wipe and reload.")
    if a.replace:
        cur.execute("truncate " + ", ".join(f"public.{t}" for t in TABLES) + " restart identity cascade")

    for t in TABLES:
        cur.execute("select column_name, data_type from information_schema.columns where table_schema='public' and table_name=%s", (t,))
        pg_types = dict(cur.fetchall())
        lite_cols = [r["name"] for r in lite.execute(f"pragma table_info({t})")]
        cols = [c for c in lite_cols if c in pg_types and c not in ("created_at", "updated_at")]
        rows = []
        for r in lite.execute(f"select {', '.join(cols)} from {t}"):
            out = []
            for c in cols:
                v = r[c]
                if v == "":
                    v = None
                if v is not None:
                    typ = pg_types[c]
                    if typ == "date":
                        v = str(v)[:10]
                    elif typ == "jsonb":
                        v = json.dumps(v if not isinstance(v, str) else json.loads(v))
                    elif typ in ("numeric", "bigint"):
                        v = float(v) if typ == "numeric" else int(v)
                out.append(v)
            rows.append(out)
        if rows:
            execute_values(cur, f"insert into public.{t} ({', '.join(cols)}) overriding system value values %s", rows, page_size=1000)
        cur.execute(f"select setval(pg_get_serial_sequence('public.{t}', 'id'), greatest((select max(id) from public.{t}), 1))")
        print(f"  {t}: {len(rows):,} rows")
    pg.commit()
    print("Done.")


if __name__ == "__main__":
    main()
