"""Quick end-to-end check of the API against a throwaway database. Run: python scripts/smoke_test.py"""
import os
import sys
import tempfile

os.environ["DATABASE_PATH"] = os.path.join(tempfile.mkdtemp(), "test.db")
os.environ["APP_USERS"] = "tester:pw"
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from fastapi.testclient import TestClient  # noqa: E402
from app.main import app  # noqa: E402

with TestClient(app) as c:
    assert c.get("/api/schema").status_code == 401
    assert c.post("/api/login", json={"username": "tester", "password": "nope"}).status_code == 401
    assert c.post("/api/login", json={"username": "tester", "password": "pw"}).status_code == 200
    o = c.post("/api/opportunities", json={"title": "Test RFP", "stage": "Identified", "deadline": "2099-01-01", "value": "$50,000"}).json()
    assert o["value"] == 50000
    assert c.put(f"/api/opportunities/{o['id']}", json={"stage": "Submitted"}).json()["stage"] == "Submitted"
    assert c.get("/api/opportunities?q=RFP").json()["total"] == 1
    r = c.post("/api/x/reviews", json={"cadence": "weekly"}).json()
    c.post("/api/actions", json={"text": "Follow up", "status": "Open", "review_id": r["id"]})
    rv = c.get(f"/api/x/reviews/{r['id']}").json()
    assert rv["snapshot"]["cadence"] == "weekly" and len(rv["actions"]) == 1
    q = c.post("/api/x/reviews", json={"cadence": "quarterly"}).json()
    assert c.get(f"/api/x/reviews/{q['id']}").json()["snapshot"]["results"]["opportunities"]["Submitted"] == 1
    assert c.get("/api/x/dashboard").json()["kpis"]["submitted"] == 1
    assert "Test RFP" in c.get("/api/opportunities/export.csv").text
    assert c.get("/").status_code == 200
print("smoke test passed")
