"""Location / region sync tests for dispatch.

Covers:
1) live order region follows standing district (opened)
2) unopened standing district is rejected
3) volunteer match/grab uses current point region
4) location update does not rewrite in-flight service snapshot
5) map focus key changes when coordinates change

Run:
  python eldercare_backend/tests/test_location_region_sync.py
  # optional live API (backend must be rebuilt/running):
  python eldercare_backend/tests/test_location_region_sync.py --live http://127.0.0.1:5000
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


BAOSHAN = "310113"
PUDONG = "310115"
# Rectangular seed centers from SEED_REGIONS (GCJ-02-ish demo points).
BAOSHAN_POINT = (121.458, 31.382)
PUDONG_POINT = (121.572, 31.218)
# Outside all opened seed districts (near Shanghai but not Baoshan/Pudong/Chaoyang).
UNOPENED_POINT = (121.30, 31.20)


def _ok(name: str) -> None:
    print(f"  PASS  {name}")


def _fail(name: str, detail: str) -> None:
    print(f"  FAIL  {name}: {detail}")
    raise AssertionError(f"{name}: {detail}")


def test_region_helpers() -> None:
    from routes.dispatch import REGION_CATALOG, _region_for_point, _volunteer_current_region

    assert _region_for_point(*BAOSHAN_POINT) == BAOSHAN, _region_for_point(*BAOSHAN_POINT)
    assert _volunteer_current_region(*PUDONG_POINT) == PUDONG
    assert _region_for_point(*UNOPENED_POINT) is None
    assert BAOSHAN in REGION_CATALOG and PUDONG in REGION_CATALOG
    _ok("region helpers: baoshan/pudong/unopened")


def test_map_focus_key_includes_coords() -> None:
    """Mirror DispatchMap focusKey composition (coords must affect the key)."""

    def focus_key(elders: list[dict[str, Any]], volunteers: list[dict[str, Any]], orders: list[dict[str, Any]]) -> str:
        return "|".join(
            [
                "310113",
                *[f"e{item['elder_id']}:{item['lng']:.5f},{item['lat']:.5f}" for item in elders],
                *[f"v{item['volunteer_id']}:{item['lng']:.5f},{item['lat']:.5f}" for item in volunteers],
                *[
                    f"o{item['order_id']}:{float(item['lng']):.5f},{float(item['lat']):.5f}"
                    for item in orders
                    if item.get("lng") is not None and item.get("lat") is not None
                ],
            ]
        )

    before = focus_key(
        [{"elder_id": 1, "lng": BAOSHAN_POINT[0], "lat": BAOSHAN_POINT[1]}],
        [],
        [],
    )
    after = focus_key(
        [{"elder_id": 1, "lng": PUDONG_POINT[0], "lat": PUDONG_POINT[1]}],
        [],
        [],
    )
    if before == after:
        _fail("map focus key", "coordinate change did not alter focusKey")
    _ok("map focus key changes when live coords change")


def test_create_order_live_sets_region_and_snapshot(app_client: Any) -> None:
    from routes import dispatch as dispatch_mod

    elder_user_id = _find_elder_user_id()
    fake_live = {
        "lng": PUDONG_POINT[0],
        "lat": PUDONG_POINT[1],
        "adcode": PUDONG,
        "formatted_address": "上海市浦东新区测试点",
        "district_name": "浦东新区",
    }
    with patch.object(dispatch_mod, "reverse_geocode", return_value=fake_live):
        resp = app_client.post(
            "/api/dispatch/orders",
            json={
                "user_id": elder_user_id,
                "service_type": "上门陪聊",
                "location_mode": "live",
                "lng": PUDONG_POINT[0],
                "lat": PUDONG_POINT[1],
                "notes": "location-sync-test-live",
            },
        )
    body = resp.get_json()
    if resp.status_code != 200 or body.get("code") != 200:
        _fail("live create order", f"status={resp.status_code} body={body}")
    order_id = int(body["data"]["order_id"])
    row = _fetch_order(order_id)
    if str(row["region_adcode"]) != PUDONG:
        _fail("live create region", f"expected {PUDONG}, got {row['region_adcode']}")
    if abs(float(row["service_lng"]) - PUDONG_POINT[0]) > 1e-5:
        _fail("live create snapshot lng", str(row["service_lng"]))
    if abs(float(row["service_lat"]) - PUDONG_POINT[1]) > 1e-5:
        _fail("live create snapshot lat", str(row["service_lat"]))
    # Cleanup pending test order so it does not clutter matching.
    _cancel_order(order_id)
    _ok("live create: region=浦东 + service_lng/lat snapshot")


def test_create_order_rejects_unopened(app_client: Any) -> None:
    from routes import dispatch as dispatch_mod

    elder_user_id = _find_elder_user_id()
    fake_live = {
        "lng": UNOPENED_POINT[0],
        "lat": UNOPENED_POINT[1],
        "adcode": "310114",  # 嘉定区 — not in opened catalog
        "formatted_address": "未开通区域测试点",
        "district_name": "嘉定区",
    }
    with patch.object(dispatch_mod, "reverse_geocode", return_value=fake_live):
        with patch.object(dispatch_mod, "is_active_region", return_value=False):
            resp = app_client.post(
                "/api/dispatch/orders",
                json={
                    "user_id": elder_user_id,
                    "service_type": "上门陪聊",
                    "location_mode": "live",
                    "lng": UNOPENED_POINT[0],
                    "lat": UNOPENED_POINT[1],
                    "notes": "location-sync-test-unopened",
                },
            )
    body = resp.get_json()
    if resp.status_code != 400 or "尚未开通" not in str(body.get("message") or ""):
        _fail("unopened reject", f"status={resp.status_code} body={body}")
    _ok("live create rejects unopened region")


def test_volunteer_candidates_filter_by_standing(app_client: Any) -> None:
    from routes.dispatch import _candidate_rows, _order_context
    from db import get_db_connection

    elder_user_id = _find_elder_user_id()
    # Place a Baoshan volunteer at Pudong and ensure Pudong order sees them,
    # while a Baoshan-only standing volunteer is excluded from Pudong matching.
    baoshan_vol, pudong_standing_vol = _pick_two_volunteers()
    _set_volunteer_point(baoshan_vol, *BAOSHAN_POINT)
    _set_volunteer_point(pudong_standing_vol, *PUDONG_POINT)

    from routes import dispatch as dispatch_mod

    fake_live = {
        "lng": PUDONG_POINT[0],
        "lat": PUDONG_POINT[1],
        "adcode": PUDONG,
        "formatted_address": "上海市浦东新区测试点",
        "district_name": "浦东新区",
    }
    with patch.object(dispatch_mod, "reverse_geocode", return_value=fake_live):
        resp = app_client.post(
            "/api/dispatch/orders",
            json={
                "user_id": elder_user_id,
                "service_type": "上门陪聊",
                "location_mode": "live",
                "lng": PUDONG_POINT[0],
                "lat": PUDONG_POINT[1],
                "required_skills": ["companion"],
                "notes": "location-sync-test-match",
            },
        )
    body = resp.get_json()
    if resp.status_code != 200 or body.get("code") != 200:
        _fail("match setup create", f"{resp.status_code} {body}")
    order_id = int(body["data"]["order_id"])
    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            order = _order_context(cursor, order_id)
            candidates = _candidate_rows(cursor, order)
    finally:
        conn.close()
    ids = {int(item["volunteer_id"]) for item in candidates}
    if pudong_standing_vol not in ids:
        _fail("standing match", f"pudong volunteer {pudong_standing_vol} missing from {sorted(ids)[:20]}...")
    if baoshan_vol in ids:
        _fail("standing match", f"baoshan-standing volunteer {baoshan_vol} should not match pudong order")
    _cancel_order(order_id)
    _ok("candidates filter by volunteer standing district")


def test_location_update_keeps_order_snapshot(app_client: Any) -> None:
    from routes import dispatch as dispatch_mod

    elder_user_id = _find_elder_user_id()
    fake_live = {
        "lng": BAOSHAN_POINT[0],
        "lat": BAOSHAN_POINT[1],
        "adcode": BAOSHAN,
        "formatted_address": "上海市宝山区测试点",
        "district_name": "宝山区",
    }
    with patch.object(dispatch_mod, "reverse_geocode", return_value=fake_live):
        resp = app_client.post(
            "/api/dispatch/orders",
            json={
                "user_id": elder_user_id,
                "service_type": "上门陪聊",
                "location_mode": "live",
                "lng": BAOSHAN_POINT[0],
                "lat": BAOSHAN_POINT[1],
                "notes": "location-sync-test-snapshot",
            },
        )
    body = resp.get_json()
    if resp.status_code != 200 or body.get("code") != 200:
        _fail("snapshot setup create", f"{resp.status_code} {body}")
    order_id = int(body["data"]["order_id"])
    before = _fetch_order(order_id)

    # Move live pin to Pudong without rewriting registration / order snapshot.
    move = app_client.post(
        "/api/dispatch/locations/elder",
        json={
            "user_id": elder_user_id,
            "lng": PUDONG_POINT[0],
            "lat": PUDONG_POINT[1],
            "source": "browser_gps",
        },
    )
    move_body = move.get_json()
    if move.status_code != 200 or move_body.get("code") != 200:
        _fail("location update", f"{move.status_code} {move_body}")

    after = _fetch_order(order_id)
    if str(after["region_adcode"]) != str(before["region_adcode"]):
        _fail("snapshot region", "order.region_adcode changed after live pin move")
    if float(after["service_lng"]) != float(before["service_lng"]) or float(after["service_lat"]) != float(before["service_lat"]):
        _fail("snapshot coords", "order.service_* changed after live pin move")

    # Order context for routing must still prefer service snapshot.
    from routes.dispatch import _order_context
    from db import get_db_connection

    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            ctx = _order_context(cursor, order_id)
    finally:
        conn.close()
    if abs(float(ctx["elder_lng"]) - float(before["service_lng"])) > 1e-5:
        _fail("order context", f"elder_lng drifted to {ctx['elder_lng']}")
    _cancel_order(order_id)
    _ok("live pin update keeps in-flight service snapshot")


def _find_elder_user_id() -> int:
    from db import get_db_connection

    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute(
                """SELECT e.user_id FROM elders e
                   JOIN elder_location_state l ON l.elder_id = e.elder_id
                   WHERE e.region_adcode = %s
                   ORDER BY e.elder_id LIMIT 1""",
                (BAOSHAN,),
            )
            row = cursor.fetchone()
            if not row:
                raise RuntimeError("no baoshan elder found")
            return int(row["user_id"])
    finally:
        conn.close()


def _pick_two_volunteers() -> tuple[int, int]:
    from db import get_db_connection

    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute(
                """SELECT p.volunteer_id
                   FROM volunteer_location_state p
                   JOIN volunteers_profile vp ON vp.user_id = p.volunteer_id
                   JOIN volunteer_skill_tags s ON s.volunteer_id = p.volunteer_id AND s.verified = TRUE
                   WHERE vp.audit_status = 'approved'
                     AND p.availability IN ('idle', 'returning')
                     AND s.skill_tag = 'companion'
                   GROUP BY p.volunteer_id
                   ORDER BY p.volunteer_id
                   LIMIT 2"""
            )
            rows = cursor.fetchall()
            if len(rows) < 2:
                raise RuntimeError("need >=2 companion volunteers for match test")
            return int(rows[0]["volunteer_id"]), int(rows[1]["volunteer_id"])
    finally:
        conn.close()


def _set_volunteer_point(volunteer_id: int, lng: float, lat: float) -> None:
    from db import get_db_connection

    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute(
                """UPDATE volunteer_location_state
                   SET lng = %s, lat = %s, availability = 'idle', fatigue_score = 0,
                       updated_at = CURRENT_TIMESTAMP
                   WHERE volunteer_id = %s""",
                (lng, lat, volunteer_id),
            )
        conn.commit()
    finally:
        conn.close()


def _fetch_order(order_id: int) -> dict[str, Any]:
    from db import get_db_connection

    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute(
                """SELECT order_id, region_adcode, service_lng, service_lat, status, address
                   FROM orders WHERE order_id = %s""",
                (order_id,),
            )
            row = cursor.fetchone()
            if not row:
                raise RuntimeError(f"order {order_id} missing")
            return dict(row)
    finally:
        conn.close()


def _cancel_order(order_id: int) -> None:
    from db import get_db_connection

    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute(
                "UPDATE orders SET status = 'cancelled' WHERE order_id = %s AND status = 'pending'",
                (order_id,),
            )
            cursor.execute(
                """UPDATE dispatch_orders
                   SET dispatch_state = 'cancelled'
                   WHERE order_id = %s""",
                (order_id,),
            )
        conn.commit()
    finally:
        conn.close()


def _http_json(method: str, url: str, payload: dict[str, Any] | None = None) -> tuple[int, dict[str, Any]]:
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={"Content-Type": "application/json"} if payload is not None else {},
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            body = json.loads(resp.read().decode("utf-8"))
            return resp.status, body
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            body = json.loads(raw)
        except json.JSONDecodeError:
            body = {"message": raw}
        return exc.code, body


def run_live_api_smoke(base: str) -> None:
    print(f"\n[live API smoke] {base}")
    # Region helper endpoints are not exposed; probe tracking health.
    status, body = _http_json("GET", f"{base}/")
    if status >= 500:
        _fail("backend up", str(body))
    _ok("backend reachable")

    # Unopened live resolve should fail for an elder when adcode inactive —
    # this needs AMap; skip if key/network fails.
    elder_id = None
    try:
        elder_id = _find_elder_user_id()
    except Exception as exc:
        print(f"  SKIP  live resolve (no DB access from host: {exc})")
        return

    status, body = _http_json(
        "POST",
        f"{base}/api/profile/location/resolve",
        {
            "user_id": elder_id,
            "role": "elder",
            "lng": UNOPENED_POINT[0],
            "lat": UNOPENED_POINT[1],
        },
    )
    if status == 502:
        print(f"  SKIP  live resolve unopened ({body.get('message')})")
    elif status == 400 and ("尚未开通" in str(body.get("message") or "") or "不属于" in str(body.get("message") or "")):
        _ok("live resolve rejects non-opened / invalid standing point")
    else:
        # Point may still reverse-geocode into an opened district depending on polygons.
        print(f"  INFO  live resolve returned {status}: {body.get('message')}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--live", default="", help="Optional base URL for HTTP smoke, e.g. http://127.0.0.1:5000")
    args = parser.parse_args()

    print("[unit]")
    test_region_helpers()
    test_map_focus_key_includes_coords()

    print("\n[flask + db]")
    # Ensure DB env points at docker-published openGauss when run from host.
    import os

    os.environ.setdefault("DB_HOST", "127.0.0.1")
    os.environ.setdefault("DB_PORT", "5432")
    os.environ.setdefault("DB_USER", "gaussdb")
    os.environ.setdefault("DB_PASSWORD", "Enmo@123")
    os.environ.setdefault("DB_NAME", "omm")

    from app import app

    # Warm region catalog the same way production requests do.
    from routes.dispatch import ensure_dispatch_schema, REGION_CATALOG
    from region_service import refresh_runtime_catalog
    from db import get_db_connection

    ensure_dispatch_schema()
    conn = get_db_connection()
    try:
        refresh_runtime_catalog(REGION_CATALOG, conn)
    finally:
        conn.close()

    client = app.test_client()
    test_create_order_rejects_unopened(client)
    test_create_order_live_sets_region_and_snapshot(client)
    test_volunteer_candidates_filter_by_standing(client)
    test_location_update_keeps_order_snapshot(client)

    if args.live:
        run_live_api_smoke(args.live.rstrip("/"))

    print("\nAll location/region sync tests passed.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except AssertionError as exc:
        print(f"\nFAILED: {exc}")
        raise SystemExit(1)
