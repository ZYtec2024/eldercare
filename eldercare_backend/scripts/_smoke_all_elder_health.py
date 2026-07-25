"""Smoke: every elder account can check-in and read trend via user_id."""
from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request

from db import get_db_connection

BASE = "http://127.0.0.1:5000/api"


def http_json(method: str, url: str, body: dict | None = None):
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={"Content-Type": "application/json"} if body is not None else {},
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main() -> int:
    conn = get_db_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT u.user_id, u.username, e.elder_id, e.name
                FROM users u
                JOIN elders e ON e.user_id = u.user_id
                WHERE u.role = 'elder'
                ORDER BY e.elder_id
                """
            )
            elders = cur.fetchall()
    finally:
        conn.close()

    if not elders:
        print("FAIL: no elder accounts")
        return 1

    failed = []
    for row in elders:
        user_id = int(row["user_id"])
        elder_id = int(row["elder_id"])
        name = row["name"]
        try:
            chart_before = http_json("GET", f"{BASE}/elder/health/chart?user_id={user_id}")
            resolved = int((chart_before.get("data") or {}).get("elder_id") or 0)
            if resolved != elder_id:
                raise RuntimeError(f"chart resolved elder_id={resolved}, expected {elder_id}")

            checkin = http_json(
                "POST",
                f"{BASE}/elder/health/checkin",
                {
                    "user_id": user_id,
                    "blood_pressure_sys": 126,
                    "blood_pressure_dia": 80,
                    "heart_rate": 72,
                    "blood_oxygen": 98,
                    "temperature": 36.5,
                    "weight": 60,
                },
            )
            if int(checkin.get("code") or 0) != 200:
                raise RuntimeError(checkin.get("message") or "checkin failed")
            if int((checkin.get("data") or {}).get("elder_id") or 0) != elder_id:
                raise RuntimeError("checkin returned wrong elder_id")

            chart_after = http_json("GET", f"{BASE}/elder/health/chart?user_id={user_id}")
            records = (chart_after.get("data") or {}).get("records") or []
            if not records:
                raise RuntimeError("trend empty after checkin")

            family = http_json("GET", f"{BASE}/family/elder-health-chart/{elder_id}")
            family_rows = family.get("data") or []
            if not isinstance(family_rows, list) or not family_rows:
                raise RuntimeError("family chart empty after checkin")

            print(f"OK user_id={user_id} elder_id={elder_id} {name} points={len(records)}")
        except Exception as exc:
            print(f"FAIL user_id={user_id} elder_id={elder_id} {name}: {exc}")
            failed.append(name)

    print(f"DONE total={len(elders)} failed={len(failed)}")
    return 1 if failed else 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except urllib.error.URLError as exc:
        print("FAIL network", exc, file=sys.stderr)
        raise SystemExit(1)
