import csv
import hmac
import io
import json
import logging
import os
import secrets
from datetime import date, timedelta

from fastapi import Depends, FastAPI, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.sessions import SessionMiddleware

from .db import get_db, init_db, log, now_iso, row_to_dict
from .reviews import build_snapshot
from .schema import ACTIVE_FUNDING, ACTIVE_OPP, CADENCES, ENTITIES, field_names, field_types, public_schema

APP_NAME = os.environ.get("APP_NAME", "BlueCredit Pulse")
STATIC = os.path.join(os.path.dirname(__file__), "static")
logger = logging.getLogger("pulse")


def load_users():
    """APP_USERS="barasa:secret1,sohaib:secret2" — one shared login per teammate."""
    raw = os.environ.get("APP_USERS", "").strip()
    if not raw:
        logger.warning("APP_USERS not set — using dev login admin / admin. Set APP_USERS before deploying.")
        return {"admin": "admin"}
    users = {}
    for pair in raw.split(","):
        if ":" in pair:
            u, p = pair.split(":", 1)
            users[u.strip().lower()] = p.strip()
    return users


USERS = load_users()
app = FastAPI(title=APP_NAME, docs_url=None, redoc_url=None)
app.add_middleware(SessionMiddleware, secret_key=os.environ.get("SECRET_KEY") or secrets.token_hex(32),
                   max_age=60 * 60 * 24 * 14, same_site="lax",
                   https_only=os.environ.get("HTTPS_ONLY", "0") == "1")


@app.on_event("startup")
def startup():
    init_db()
    # First boot on a new server: load the spreadsheets if IMPORT_DIR points at them and the DB is empty.
    folder = os.environ.get("IMPORT_DIR")
    if folder and os.path.isdir(folder):
        with get_db() as db:
            empty = db.execute("SELECT (SELECT COUNT(*) FROM opportunities) + (SELECT COUNT(*) FROM contacts)").fetchone()[0] == 0
        if empty:
            import subprocess, sys
            logger.warning("Empty database — importing spreadsheets from %s", folder)
            subprocess.run([sys.executable, os.path.join(os.path.dirname(__file__), "..", "scripts", "import_spreadsheets.py"), folder], check=False)


def current_user(request: Request) -> str:
    user = request.session.get("user")
    if not user:
        raise HTTPException(401, "Not signed in")
    return user


# ---------------------------------------------------------------- auth / meta
@app.post("/api/login")
async def login(request: Request):
    body = await request.json()
    u = str(body.get("username", "")).strip().lower()
    p = str(body.get("password", ""))
    if u in USERS and hmac.compare_digest(USERS[u], p):
        request.session["user"] = u
        return {"user": u}
    raise HTTPException(401, "Wrong username or password")


@app.post("/api/logout")
def logout(request: Request):
    request.session.clear()
    return {"ok": True}


@app.get("/api/me")
def me(request: Request):
    return {"user": request.session.get("user"), "app_name": APP_NAME}


@app.get("/api/schema")
def schema(user: str = Depends(current_user)):
    return public_schema()


# ---------------------------------------------------------------- helpers
def check_entity(entity):
    if entity not in ENTITIES:
        raise HTTPException(404, "Unknown entity")


def clean(entity, data):
    types = field_types(entity)
    out = {}
    for k, v in data.items():
        if k not in types:
            continue
        if isinstance(v, str):
            v = v.strip()
        if types[k] == "number":
            if v in ("", None):
                v = None
            else:
                try:
                    v = float(str(v).replace(",", "").replace("$", "").replace("%", ""))
                except ValueError:
                    raise HTTPException(422, f"{k} must be a number")
        elif v is None:
            v = ""
        out[k] = v
    return out


def get_row(db, entity, rid):
    row = db.execute(f"SELECT * FROM {entity} WHERE id=?", (rid,)).fetchone()
    if not row:
        raise HTTPException(404, "Not found")
    return row_to_dict(row)


def build_where(entity, params):
    names = set(field_names(entity))
    where, args = [], []
    q = params.get("q", "").strip()
    if q:
        text_fields = [f for f, t in field_types(entity).items() if t in ("text", "textarea", "email", "select")]
        for term in q.split():
            where.append("(" + " OR ".join(f'COALESCE("{f}",\'\') LIKE ?' for f in text_fields) + ")")
            args += [f"%{term}%"] * len(text_fields)
    for k, v in params.items():
        if k in names and v != "":
            vals = v.split("|")
            if vals == ["__blank__"]:
                where.append(f'COALESCE("{k}",\'\') = \'\'')
            else:
                where.append(f'"{k}" IN ({",".join("?" * len(vals))})')
                args += vals
        elif k.endswith("__not") and k[:-5] in names and v:
            vals = v.split("|")
            where.append(f'COALESCE("{k[:-5]}",\'\') NOT IN ({",".join("?" * len(vals))})')
            args += vals
        elif k.endswith("__gte") and k[:-5] in names and v:
            where.append(f'"{k[:-5]}" >= ? AND "{k[:-5]}" <> \'\''); args.append(v)
        elif k.endswith("__lte") and k[:-5] in names and v:
            where.append(f'"{k[:-5]}" <= ? AND "{k[:-5]}" <> \'\''); args.append(v)
    return (" WHERE " + " AND ".join(where)) if where else "", args


# ---------------------------------------------------------------- generic CRUD
@app.get("/api/{entity}")
def list_rows(entity: str, request: Request, user: str = Depends(current_user)):
    check_entity(entity)
    params = dict(request.query_params)
    where, args = build_where(entity, params)
    sort = params.get("sort") or ENTITIES[entity]["default_sort"]
    desc = sort.startswith("-")
    sort = sort.lstrip("-")
    if sort not in field_names(entity) + ["id", "updated_at", "created_at"]:
        sort = "id"
    # blanks always last
    order = f'(COALESCE("{sort}",\'\') = \'\'), "{sort}" {"DESC" if desc else "ASC"}, id DESC'
    limit = min(int(params.get("limit", 100)), 5000)
    offset = int(params.get("offset", 0))
    with get_db() as db:
        total = db.execute(f"SELECT COUNT(*) FROM {entity}{where}", args).fetchone()[0]
        rows = [row_to_dict(r) for r in db.execute(
            f"SELECT * FROM {entity}{where} ORDER BY {order} LIMIT ? OFFSET ?", (*args, limit, offset))]
    return {"total": total, "rows": rows}


@app.get("/api/{entity}/export.csv")
def export_csv(entity: str, request: Request, user: str = Depends(current_user)):
    check_entity(entity)
    where, args = build_where(entity, dict(request.query_params))
    cols = ["id"] + field_names(entity) + ["updated_at"]
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(cols)
    with get_db() as db:
        for r in db.execute(f"SELECT {','.join(chr(34)+c+chr(34) for c in cols)} FROM {entity}{where}", args):
            w.writerow(list(r))
    buf.seek(0)
    return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv",
                             headers={"Content-Disposition": f'attachment; filename="{entity}-{date.today()}.csv"'})


@app.post("/api/{entity}/import")
async def import_csv(entity: str, file: UploadFile, user: str = Depends(current_user)):
    """Bulk-add rows from a CSV whose headers match field names or labels."""
    check_entity(entity)
    labels = {l.lower(): n for n, _, l, _ in ENTITIES[entity]["fields"]}
    names = set(field_names(entity))
    text = (await file.read()).decode("utf-8-sig", errors="replace")
    added = 0
    with get_db() as db:
        for raw in csv.DictReader(io.StringIO(text)):
            data = {}
            for k, v in raw.items():
                if k is None:
                    continue
                key = k.strip() if k.strip() in names else labels.get(k.strip().lower())
                if key:
                    data[key] = v
            data = clean(entity, data)
            if not any(v not in (None, "") for v in data.values()):
                continue
            insert(db, entity, data, user, quiet=True)
            added += 1
        log(db, user, entity, None, "import", f"Imported {added} rows from {file.filename}")
    return {"added": added}


def insert(db, entity, data, user, quiet=False):
    ts = now_iso()
    cols = list(data.keys()) + ["created_at", "updated_at", "updated_by"]
    cur = db.execute(f'INSERT INTO {entity} ({",".join(chr(34)+c+chr(34) for c in cols)}) VALUES ({",".join("?"*len(cols))})',
                     (*data.values(), ts, ts, user))
    rid = cur.lastrowid
    if not quiet:
        title = data.get(ENTITIES[entity]["title_field"], "")
        log(db, user, entity, rid, "create", f"Added {ENTITIES[entity]['singular'].lower()}: {title}")
        sf = ENTITIES[entity]["status_field"]
        if sf and data.get(sf) and entity in ("opportunities", "funding"):
            log(db, user, entity, rid, "update", f"{title}: {sf} → {data[sf]}", sf, None, data[sf])
    return rid


@app.post("/api/{entity}")
async def create_row(entity: str, request: Request, user: str = Depends(current_user)):
    check_entity(entity)
    data = clean(entity, await request.json())
    with get_db() as db:
        rid = insert(db, entity, data, user)
        return get_row(db, entity, rid)


@app.get("/api/{entity}/{rid:int}")
def read_row(entity: str, rid: int, user: str = Depends(current_user)):
    check_entity(entity)
    with get_db() as db:
        row = get_row(db, entity, rid)
        row["history"] = [row_to_dict(r) for r in db.execute(
            "SELECT * FROM activity WHERE entity=? AND entity_id=? ORDER BY ts DESC LIMIT 50", (entity, rid))]
        if entity in ("opportunities", "funding", "contacts"):
            row["actions"] = [row_to_dict(r) for r in db.execute(
                "SELECT * FROM actions WHERE linked_type=? AND linked_id=? ORDER BY status, due_date", (entity, rid))]
    return row


@app.put("/api/{entity}/{rid:int}")
async def update_row(entity: str, rid: int, request: Request, user: str = Depends(current_user)):
    check_entity(entity)
    data = clean(entity, await request.json())
    with get_db() as db:
        old = get_row(db, entity, rid)
        changed = {k: v for k, v in data.items() if (old.get(k) if old.get(k) is not None else "") != (v if v is not None else "")}
        if not changed:
            return old
        sets = ",".join(f'"{k}"=?' for k in changed) + ",updated_at=?,updated_by=?"
        db.execute(f"UPDATE {entity} SET {sets} WHERE id=?", (*changed.values(), now_iso(), user, rid))
        title = data.get(ENTITIES[entity]["title_field"]) or old.get(ENTITIES[entity]["title_field"]) or ""
        sf = ENTITIES[entity]["status_field"]
        for k, v in changed.items():
            if k == sf:
                log(db, user, entity, rid, "update", f"{title}: {k} {old.get(k) or '—'} → {v}", k, old.get(k), v)
        others = [k for k in changed if k != sf]
        if others:
            log(db, user, entity, rid, "update", f"{title}: edited {', '.join(others)}")
        return get_row(db, entity, rid)


@app.delete("/api/{entity}/{rid:int}")
def delete_row(entity: str, rid: int, user: str = Depends(current_user)):
    check_entity(entity)
    with get_db() as db:
        old = get_row(db, entity, rid)
        db.execute(f"DELETE FROM {entity} WHERE id=?", (rid,))
        log(db, user, entity, rid, "delete", f"Deleted: {old.get(ENTITIES[entity]['title_field'])}",
            None, json.dumps({k: v for k, v in old.items() if v not in (None, '')}, default=str)[:4000], None)
    return {"ok": True}


# ---------------------------------------------------------------- dashboard
@app.get("/api/x/dashboard")
def dashboard(user: str = Depends(current_user)):
    t = date.today().isoformat()
    in14 = (date.today() + timedelta(days=14)).isoformat()
    po, pf = ",".join("?" * len(ACTIVE_OPP)), ",".join("?" * len(ACTIVE_FUNDING))
    with get_db() as db:
        one = lambda sql, a=(): db.execute(sql, a).fetchone()[0]
        q = lambda sql, a=(): [row_to_dict(r) for r in db.execute(sql, a)]
        return {
            "kpis": {
                "active_opps": one(f"SELECT COUNT(*) FROM opportunities WHERE stage IN ({po})", ACTIVE_OPP),
                "active_opp_value": one(f"SELECT COALESCE(SUM(value),0) FROM opportunities WHERE stage IN ({po})", ACTIVE_OPP),
                "active_funding": one(f"SELECT COUNT(*) FROM funding WHERE status IN ({pf})", ACTIVE_FUNDING),
                "submitted": one("SELECT COUNT(*) FROM opportunities WHERE stage='Submitted'")
                             + one("SELECT COUNT(*) FROM funding WHERE status='Submitted'"),
                "won": one("SELECT COUNT(*) FROM opportunities WHERE stage='Won'") + one("SELECT COUNT(*) FROM funding WHERE status='Won'"),
                "open_actions": one("SELECT COUNT(*) FROM actions WHERE status='Open'"),
                "overdue_actions": one("SELECT COUNT(*) FROM actions WHERE status='Open' AND due_date<>'' AND due_date < ?", (t,)),
                "contacts": one("SELECT COUNT(*) FROM contacts"),
                "followups_due": one("SELECT COUNT(*) FROM contacts WHERE next_step_date<>'' AND next_step_date <= ?", (t,)),
            },
            "due_soon": q(f"""SELECT 'opportunities' entity, id, title name, agency org, deadline, stage status, owner, priority
                FROM opportunities WHERE stage IN ({po}) AND deadline >= ? AND deadline <= ?
                UNION ALL SELECT 'funding', id, name, organization, deadline, status, owner, ''
                FROM funding WHERE status IN ({pf}) AND deadline >= ? AND deadline <= ? ORDER BY deadline""",
                (*ACTIVE_OPP, t, in14, *ACTIVE_FUNDING, t, in14)),
            "my_actions": q("""SELECT * FROM actions WHERE status='Open' AND lower(COALESCE(owner,''))=?
                ORDER BY (COALESCE(due_date,'')=''), due_date LIMIT 20""", (user.lower(),)),
            "opp_by_stage": q("SELECT stage k, COUNT(*) n, COALESCE(SUM(value),0) v FROM opportunities GROUP BY stage"),
            "funding_by_status": q("SELECT status k, COUNT(*) n FROM funding WHERE status<>'Catalog' GROUP BY status"),
            "recent": q("SELECT * FROM activity ORDER BY id DESC LIMIT 25"),
            "last_reviews": q("""SELECT cadence, MAX(review_date) last FROM reviews GROUP BY cadence"""),
        }


# ---------------------------------------------------------------- reviews
@app.get("/api/x/reviews")
def list_reviews(cadence: str = "", user: str = Depends(current_user)):
    with get_db() as db:
        sql = """SELECT r.id, r.cadence, r.review_date, r.title, r.attendees, r.created_by,
                 (SELECT COUNT(*) FROM actions a WHERE a.review_id=r.id) n_actions,
                 (SELECT COUNT(*) FROM actions a WHERE a.review_id=r.id AND a.status='Open') n_open
                 FROM reviews r"""
        args = ()
        if cadence:
            sql += " WHERE cadence=?"; args = (cadence,)
        return [dict(r) for r in db.execute(sql + " ORDER BY review_date DESC, id DESC LIMIT 300", args)]


@app.get("/api/x/reviews/preview")
def preview_review(cadence: str, as_of: str = "", user: str = Depends(current_user)):
    if cadence not in CADENCES:
        raise HTTPException(400, "Unknown cadence")
    with get_db() as db:
        return build_snapshot(db, cadence, as_of or None)


@app.post("/api/x/reviews")
async def create_review(request: Request, user: str = Depends(current_user)):
    body = await request.json()
    cadence = body.get("cadence")
    if cadence not in CADENCES:
        raise HTTPException(400, "Unknown cadence")
    rdate = body.get("review_date") or date.today().isoformat()
    with get_db() as db:
        snap = build_snapshot(db, cadence, rdate)
        title = body.get("title") or f"{CADENCES[cadence]['label']} review — {rdate}"
        cur = db.execute("""INSERT INTO reviews (cadence, review_date, title, attendees, notes, snapshot, created_by,
                         created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)""",
                         (cadence, rdate, title, body.get("attendees", ""), body.get("notes", ""),
                          json.dumps(snap, default=str), user, now_iso(), now_iso()))
        log(db, user, "reviews", cur.lastrowid, "create", f"Started {title}")
        return {"id": cur.lastrowid}


@app.get("/api/x/reviews/{rid:int}")
def get_review(rid: int, user: str = Depends(current_user)):
    with get_db() as db:
        r = db.execute("SELECT * FROM reviews WHERE id=?", (rid,)).fetchone()
        if not r:
            raise HTTPException(404)
        out = row_to_dict(r)
        out["actions"] = [row_to_dict(a) for a in db.execute(
            "SELECT * FROM actions WHERE review_id=? ORDER BY status, due_date", (rid,))]
        return out


@app.put("/api/x/reviews/{rid:int}")
async def update_review(rid: int, request: Request, user: str = Depends(current_user)):
    body = await request.json()
    with get_db() as db:
        if body.get("refresh"):
            r = db.execute("SELECT cadence, review_date FROM reviews WHERE id=?", (rid,)).fetchone()
            db.execute("UPDATE reviews SET snapshot=? WHERE id=?",
                       (json.dumps(build_snapshot(db, r["cadence"], r["review_date"]), default=str), rid))
        fields = {k: body[k] for k in ("title", "attendees", "notes", "review_date") if k in body}
        if fields:
            db.execute(f"UPDATE reviews SET {','.join(k+'=?' for k in fields)}, updated_at=? WHERE id=?",
                       (*fields.values(), now_iso(), rid))
    return get_review(rid, user)


@app.delete("/api/x/reviews/{rid:int}")
def delete_review(rid: int, user: str = Depends(current_user)):
    with get_db() as db:
        db.execute("UPDATE actions SET review_id=NULL WHERE review_id=?", (rid,))
        db.execute("DELETE FROM reviews WHERE id=?", (rid,))
        log(db, user, "reviews", rid, "delete", "Deleted review")
    return {"ok": True}


@app.get("/api/x/activity")
def activity(limit: int = 100, user: str = Depends(current_user)):
    with get_db() as db:
        return [row_to_dict(r) for r in db.execute("SELECT * FROM activity ORDER BY id DESC LIMIT ?", (min(limit, 1000),))]


@app.get("/healthz")
def healthz():
    return {"ok": True}


# ---------------------------------------------------------------- frontend
app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.get("/{path:path}")
def spa(path: str):
    if path.startswith("api/"):
        return JSONResponse({"detail": "Not found"}, 404)
    return FileResponse(os.path.join(STATIC, "index.html"))
