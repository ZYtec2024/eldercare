"""Intelligent dispatch centre backed by the AMap web map on the client.

The backend supplies protected people, order and movement endpoints.  The
shared front-end map resolves the actual driving geometry and traffic layer
through AMap, avoiding a fabricated road grid in the business UI.
"""

from __future__ import annotations

import datetime as dt
import json
import math
import random
import threading
import time
from typing import Any
from urllib.parse import urlencode

from flask import Blueprint, jsonify, request

from db import get_db_connection
from region_service import (
    admin_is_root,
    enrich_missing_polygons,
    ensure_region_columns,
    fetch_district_children,
    fetch_district_detail,
    is_active_region,
    refresh_runtime_catalog,
    resolve_region_adcode,
    upsert_region,
)


dispatch_bp = Blueprint("dispatch", __name__)

# Built-in demo districts (seed only). Runtime catalog is reloaded from DB and
# prefers official AMap polygons when available.
SEED_REGIONS: dict[str, dict[str, Any]] = {
    "310113": {
        "name": "上海市宝山区", "city": "上海市", "level": "district",
        "bounds": {"west": 121.405, "east": 121.535, "south": 31.325, "north": 31.455},
        "center": (121.458, 31.382), "polygons": [],
    },
    "310115": {
        "name": "上海市浦东新区", "city": "上海市", "level": "district",
        "bounds": {"west": 121.500, "east": 121.700, "south": 31.120, "north": 31.320},
        "center": (121.572, 31.218), "polygons": [],
    },
    "110105": {
        "name": "北京市朝阳区", "city": "北京市", "level": "district",
        "bounds": {"west": 116.370, "east": 116.560, "south": 39.820, "north": 40.060},
        "center": (116.472, 39.943), "polygons": [],
    },
}
REGION_CATALOG: dict[str, dict[str, Any]] = {code: dict(meta) for code, meta in SEED_REGIONS.items()}
DEFAULT_REGION_ADCODE = "310113"
MAP_BOUNDS = REGION_CATALOG[DEFAULT_REGION_ADCODE]["bounds"]
NEAR_RADIUS_KM = 2.0
MID_RADIUS_KM = 4.5
FAR_RADIUS_KM = 8.0
# A background location clock persists journey positions once per second.  The
# UI may poll less often, but no browser is the source of truth for movement.
DISPATCH_ADVANCE_COOLDOWN_SECONDS = 1.0
JOURNEY_PROGRESS_PER_SECOND = 0.65
# Return travel is still persisted server-side, but is accelerated for the
# acceptance demo.  The 20-second visible return window therefore represents
# roughly 70% of a return journey rather than an invisible first few metres.
RETURN_PROGRESS_PER_SECOND = 3.5
RETURN_AUTO_DISPATCH_GRACE_SECONDS = 20
TOP1_WINDOW_SECONDS = 8
TOP3_WINDOW_SECONDS = 20
TOP10_WINDOW_SECONDS = 35
_advance_lock = threading.Lock()
_last_advance_at = 0.0

SERVICE_CATALOG = {
    "陪同就医": {"label": "陪同就医", "skills": ["medical_support"], "hours": 2, "urgent": False},
    "陪同复诊": {"label": "陪同复诊", "skills": ["medical_support"], "hours": 2, "urgent": False},
    "代买药品": {"label": "代买药品", "skills": ["medical_support", "errand"], "hours": 1, "urgent": False},
    "代购物资": {"label": "代购物资", "skills": ["errand"], "hours": 1, "urgent": False},
    "上门陪聊": {"label": "上门陪聊", "skills": ["companion"], "hours": 1, "urgent": False},
    "康复训练": {"label": "康复训练", "skills": ["rehab"], "hours": 1, "urgent": False},
    "健康咨询": {"label": "健康咨询", "skills": ["medical_support"], "hours": 1, "urgent": False},
    "智能设备协助": {"label": "智能设备协助", "skills": ["digital_assist"], "hours": 1, "urgent": False},
    "上门理发": {"label": "上门理发", "skills": ["grooming"], "hours": 1, "urgent": False},
    "SOS紧急救助": {"label": "SOS紧急救助", "skills": ["emergency_response"], "hours": 1, "urgent": True},
}

SKILL_LABELS = {
    "medical_support": "医疗陪护",
    "emergency_response": "急救响应",
    "mobility_assist": "行动辅助",
    "errand": "代办采购",
    "companion": "陪伴沟通",
    "rehab": "康复训练",
    "digital_assist": "智能设备协助",
    "grooming": "生活照护",
}


def _now() -> dt.datetime:
    # openGauss in the project Docker container stores its TIMESTAMP values in
    # UTC.  Using the Windows local (Asia/Shanghai) clock here made every
    # route appear eight hours old on the next refresh, completing a newly
    # created return route immediately and sending the next task from home.
    # Keep all persisted journey arithmetic on the same naive UTC timeline.
    return dt.datetime.now(dt.timezone.utc).replace(tzinfo=None)


def _iso(value: Any) -> str | None:
    if isinstance(value, (dt.datetime, dt.date)):
        return value.isoformat(sep=" ", timespec="seconds")
    return str(value) if value is not None else None


def _distance_km(a_lng: float, a_lat: float, b_lng: float, b_lat: float) -> float:
    lat_km = (b_lat - a_lat) * 111.0
    lng_km = (b_lng - a_lng) * 111.0 * math.cos(math.radians((a_lat + b_lat) / 2))
    return round(math.hypot(lat_km, lng_km), 2)


def _point_on_route(path: list[Any], progress: float) -> tuple[float, float]:
    """Interpolate by travelled distance over a persisted road polyline."""
    points: list[tuple[float, float]] = []
    for raw in path:
        try:
            points.append((float(raw[0]), float(raw[1])))
        except (TypeError, ValueError, IndexError):
            continue
    if len(points) < 2:
        return points[0] if points else (0.0, 0.0)
    lengths = [_distance_km(a[0], a[1], b[0], b[1]) for a, b in zip(points, points[1:])]
    total = sum(lengths)
    if total <= 0:
        return points[-1]
    target = total * max(0.0, min(1.0, progress))
    covered = 0.0
    for index, length in enumerate(lengths):
        if covered + length >= target:
            ratio = 0.0 if length <= 0 else (target - covered) / length
            start, end = points[index], points[index + 1]
            return (start[0] + (end[0] - start[0]) * ratio, start[1] + (end[1] - start[1]) * ratio)
        covered += length
    return points[-1]


def _clamp(value: int, lower: int, upper: int) -> int:
    return max(lower, min(upper, value))


def _demo_motion_seconds(eta_minutes: int | float | None, returning: bool = False) -> int:
    """A visible but accelerated timeline derived from AMap's ETA."""
    eta = max(1, int(eta_minutes or 1))
    # Return trips intentionally remain visible for at least two minutes.  It
    # gives a real order enough time to catch a volunteer in transit and lets
    # the dispatcher demonstrate that the next route starts at the current
    # point on the purple line rather than at the volunteer's home.
    base = eta * (15 if not returning else 13)
    return _clamp(base, 70 if not returning else 120, 180 if not returning else 240)


def _route_motion_rate(route: dict[str, Any], fallback: float = JOURNEY_PROGRESS_PER_SECOND) -> float:
    try:
        seconds = float(route.get("motion_seconds") or 0)
        if seconds > 0:
            return 100.0 / seconds
    except (TypeError, ValueError):
        pass
    return fallback


def _arrival_visual_ready(route: dict[str, Any], grace_seconds: float = 1.0) -> bool:
    """Give every portal time to animate the final road segment before state changes.

    Without this one-second persisted hand-off, the request that advances a route to
    100% also changes it to ``serving`` (or deletes a return route).  The map
    receives only the final state and appears to teleport the volunteer.
    """
    pending_since = route.get("arrival_pending_since")
    if not pending_since:
        route["arrival_pending_since"] = _iso(_now())
        return False
    try:
        return (_now() - dt.datetime.fromisoformat(str(pending_since))).total_seconds() >= grace_seconds
    except (TypeError, ValueError):
        route["arrival_pending_since"] = _iso(_now())
        return False


def route_endpoints(start_lng: float, start_lat: float, end_lng: float, end_lat: float, version: int) -> dict[str, Any]:
    """Return route endpoints only; AMap.Driving renders the real road path."""
    distance = _distance_km(start_lng, start_lat, end_lng, end_lat)
    eta_minutes = max(2, round(distance / 28 * 60))
    return {
        "path": [[round(start_lng, 6), round(start_lat, 6)], [round(end_lng, 6), round(end_lat, 6)]],
        "eta_minutes": eta_minutes, "distance_km": distance, "traffic_version": version,
        "motion_seconds": _demo_motion_seconds(eta_minutes),
        "route_provider": "amap_web_driving",
    }


def _add_column_if_missing(cursor: Any, table_name: str, column_name: str, definition: str) -> None:
    """openGauss rejects ALTER TABLE ADD COLUMN IF NOT EXISTS.

    Inspect the catalogue first so the embedded migration is safe on both a
    fresh database and the user's existing OpenGauss container.
    """
    cursor.execute("""SELECT 1 FROM information_schema.columns
                      WHERE table_schema = current_schema()
                        AND table_name = %s AND column_name = %s""",
                   (table_name, column_name))
    if not cursor.fetchone():
        cursor.execute(f"ALTER TABLE {table_name} ADD COLUMN {column_name} {definition}")


def ensure_dispatch_schema() -> None:
    global MAP_BOUNDS
    conn = get_db_connection()
    if not conn:
        return
    try:
        with conn.cursor() as cursor:
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS dispatch_system_state (
                    state_key VARCHAR(64) PRIMARY KEY,
                    state_value VARCHAR(255) NOT NULL,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS administrative_regions (
                    adcode VARCHAR(12) PRIMARY KEY,
                    name VARCHAR(80) NOT NULL,
                    city_name VARCHAR(80) NOT NULL,
                    region_level VARCHAR(20) NOT NULL DEFAULT 'district',
                    bounds_json TEXT NOT NULL,
                    active BOOLEAN NOT NULL DEFAULT TRUE,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS admin_region_scope (
                    admin_user_id INT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
                    region_adcode VARCHAR(12) NOT NULL,
                    permission VARCHAR(20) NOT NULL DEFAULT 'manage',
                    PRIMARY KEY (admin_user_id, region_adcode)
                )
            """)
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS emergency_incidents (
                    incident_id SERIAL PRIMARY KEY,
                    elder_id INT NOT NULL REFERENCES elders(elder_id) ON DELETE CASCADE,
                    region_adcode VARCHAR(12) NOT NULL,
                    incident_type VARCHAR(40) NOT NULL DEFAULT 'general_help',
                    description TEXT NOT NULL DEFAULT '',
                    status VARCHAR(24) NOT NULL DEFAULT 'reported',
                    created_by INT NULL REFERENCES users(user_id) ON DELETE SET NULL,
                    linked_order_id INT NULL REFERENCES orders(order_id) ON DELETE SET NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    acknowledged_at TIMESTAMP NULL,
                    acknowledged_by INT NULL REFERENCES users(user_id) ON DELETE SET NULL,
                    resolved_at TIMESTAMP NULL,
                    resolved_by INT NULL REFERENCES users(user_id) ON DELETE SET NULL,
                    resolution_summary TEXT NULL
                )
            """)
            _add_column_if_missing(cursor, "alerts", "emergency_incident_id", "INT NULL")
            _add_column_if_missing(cursor, "emergency_incidents", "acknowledged_by", "INT NULL REFERENCES users(user_id) ON DELETE SET NULL")
            _add_column_if_missing(cursor, "emergency_incidents", "resolved_by", "INT NULL REFERENCES users(user_id) ON DELETE SET NULL")
            _add_column_if_missing(cursor, "emergency_incidents", "resolution_summary", "TEXT NULL")
            cursor.execute("CREATE INDEX IF NOT EXISTS idx_alerts_emergency_incident ON alerts(emergency_incident_id)")
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS emergency_notifications (
                    notification_id SERIAL PRIMARY KEY,
                    incident_id INT NOT NULL REFERENCES emergency_incidents(incident_id) ON DELETE CASCADE,
                    recipient_user_id INT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
                    recipient_role VARCHAR(20) NOT NULL,
                    notification_type VARCHAR(24) NOT NULL DEFAULT 'in_app',
                    read_at TIMESTAMP NULL,
                    acknowledged_at TIMESTAMP NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE (incident_id, recipient_user_id, notification_type)
                )
            """)
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS conversations (
                    conversation_id SERIAL PRIMARY KEY,
                    conversation_type VARCHAR(24) NOT NULL,
                    elder_id INT NULL REFERENCES elders(elder_id) ON DELETE CASCADE,
                    order_id INT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
                    incident_id INT NULL REFERENCES emergency_incidents(incident_id) ON DELETE CASCADE,
                    status VARCHAR(20) NOT NULL DEFAULT 'active',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    archived_at TIMESTAMP NULL
                )
            """)
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS conversation_members (
                    conversation_id INT NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
                    user_id INT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
                    role_in_conversation VARCHAR(24) NOT NULL,
                    last_read_at TIMESTAMP NULL,
                    PRIMARY KEY (conversation_id, user_id)
                )
            """)
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS conversation_messages (
                    message_id SERIAL PRIMARY KEY,
                    conversation_id INT NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
                    sender_user_id INT NULL REFERENCES users(user_id) ON DELETE SET NULL,
                    message_type VARCHAR(24) NOT NULL DEFAULT 'text',
                    content TEXT NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS volunteer_location_state (
                    volunteer_id INT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
                    lng NUMERIC(10,6) NOT NULL,
                    lat NUMERIC(10,6) NOT NULL,
                    availability VARCHAR(20) NOT NULL DEFAULT 'idle',
                    fatigue_score INT NOT NULL DEFAULT 0 CHECK (fatigue_score BETWEEN 0 AND 100),
                    service_rating NUMERIC(3,2) NOT NULL DEFAULT 4.50,
                    assigned_today INT NOT NULL DEFAULT 0,
                    location_source VARCHAR(24) NOT NULL DEFAULT 'simulated',
                    home_lng NUMERIC(10,6),
                    home_lat NUMERIC(10,6),
                    auto_accept_enabled BOOLEAN NOT NULL DEFAULT FALSE,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS elder_location_state (
                    elder_id INT PRIMARY KEY REFERENCES elders(elder_id) ON DELETE CASCADE,
                    lng NUMERIC(10,6) NOT NULL,
                    lat NUMERIC(10,6) NOT NULL,
                    location_source VARCHAR(24) NOT NULL DEFAULT 'simulated',
                    is_home_fixed BOOLEAN NOT NULL DEFAULT TRUE,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS volunteer_skill_tags (
                    volunteer_id INT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
                    skill_tag VARCHAR(64) NOT NULL,
                    verified BOOLEAN NOT NULL DEFAULT TRUE,
                    PRIMARY KEY (volunteer_id, skill_tag)
                )
            """)
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS dispatch_orders (
                    order_id INT PRIMARY KEY REFERENCES orders(order_id) ON DELETE CASCADE,
                    urgency VARCHAR(16) NOT NULL DEFAULT 'normal',
                    required_skills TEXT NOT NULL,
                    dispatch_state VARCHAR(24) NOT NULL DEFAULT 'matching',
                    search_stage INT NOT NULL DEFAULT 1,
                    dispatch_phase VARCHAR(24) NOT NULL DEFAULT 'top1',
                    phase_started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    phase_expires_at TIMESTAMP NULL,
                    dispatch_version INT NOT NULL DEFAULT 1,
                    forced_assignment BOOLEAN NOT NULL DEFAULT FALSE,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    last_expanded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS dispatch_candidates (
                    candidate_id SERIAL PRIMARY KEY,
                    order_id INT NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
                    volunteer_id INT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
                    eligible BOOLEAN NOT NULL,
                    skill_match TEXT NOT NULL,
                    distance_km NUMERIC(8,2),
                    eta_minutes INT,
                    distance_score NUMERIC(8,2),
                    traffic_score NUMERIC(8,2),
                    fatigue_score NUMERIC(8,2),
                    rating_score NUMERIC(8,2),
                    total_score NUMERIC(8,2),
                    candidate_rank INT,
                    response_status VARCHAR(20) NOT NULL DEFAULT 'waiting',
                    invited_at TIMESTAMP NULL,
                    responded_at TIMESTAMP NULL,
                    UNIQUE (order_id, volunteer_id)
                )
            """)
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS dispatch_routes (
                    order_id INT PRIMARY KEY REFERENCES orders(order_id) ON DELETE CASCADE,
                    volunteer_id INT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
                    route_json TEXT NOT NULL,
                    eta_minutes INT NOT NULL,
                    traffic_version INT NOT NULL,
                    replanned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS dispatch_events (
                    event_id SERIAL PRIMARY KEY,
                    order_id INT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
                    event_type VARCHAR(40) NOT NULL,
                    message VARCHAR(500) NOT NULL,
                    details TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS volunteer_return_routes (
                    volunteer_id INT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
                    route_json TEXT NOT NULL,
                    eta_minutes INT NOT NULL,
                    traffic_version INT NOT NULL,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            cursor.execute("SELECT state_key FROM dispatch_system_state WHERE state_key = 'traffic_version'")
            if not cursor.fetchone():
                cursor.execute("INSERT INTO dispatch_system_state (state_key, state_value) VALUES ('traffic_version', '1')")
            _ensure_column(cursor, "volunteer_location_state", "location_source", "VARCHAR(24) NOT NULL DEFAULT 'simulated'")
            _ensure_column(cursor, "volunteer_location_state", "home_lng", "NUMERIC(10,6)")
            _ensure_column(cursor, "volunteer_location_state", "home_lat", "NUMERIC(10,6)")
            _ensure_column(cursor, "volunteer_location_state", "auto_accept_enabled", "BOOLEAN NOT NULL DEFAULT FALSE")
            _ensure_column(cursor, "volunteer_location_state", "return_started_at", "TIMESTAMP NULL")
            _ensure_column(cursor, "volunteer_location_state", "fatigue_updated_at", "TIMESTAMP NULL")
            _ensure_column(cursor, "volunteer_location_state", "service_region_adcode", "VARCHAR(12) NOT NULL DEFAULT '310113'")
            _ensure_column(cursor, "elders", "region_adcode", "VARCHAR(12) NOT NULL DEFAULT '310113'")
            _ensure_column(cursor, "orders", "region_adcode", "VARCHAR(12) NOT NULL DEFAULT '310113'")
            _ensure_column(cursor, "orders", "proxy_created_by", "INT NULL")
            _ensure_column(cursor, "orders", "proxy_reason", "TEXT NULL")
            _ensure_column(cursor, "dispatch_orders", "region_adcode", "VARCHAR(12) NOT NULL DEFAULT '310113'")
            _ensure_column(cursor, "dispatch_orders", "dispatch_phase", "VARCHAR(24) NOT NULL DEFAULT 'top1'")
            _ensure_column(cursor, "dispatch_orders", "phase_started_at", "TIMESTAMP NULL")
            _ensure_column(cursor, "dispatch_orders", "phase_expires_at", "TIMESTAMP NULL")
            _ensure_column(cursor, "dispatch_orders", "dispatch_version", "INT NOT NULL DEFAULT 1")
            cursor.execute("""UPDATE dispatch_orders SET dispatch_phase = COALESCE(dispatch_phase, 'top1'),
                              phase_started_at = COALESCE(phase_started_at, created_at, CURRENT_TIMESTAMP),
                              dispatch_version = COALESCE(dispatch_version, 1)""")
            # Version 2 measures completed work rather than accepting a card.
            # Clear only the inherited counters once so historical demo clicks
            # do not bias today's new dispatch ranking.
            cursor.execute("SELECT state_key FROM dispatch_system_state WHERE state_key = 'fatigue_model_v2_initialized'")
            if not cursor.fetchone():
                cursor.execute("""UPDATE volunteer_location_state
                                  SET fatigue_score = 0, assigned_today = 0, fatigue_updated_at = CURRENT_TIMESTAMP""")
                cursor.execute("INSERT INTO dispatch_system_state (state_key, state_value) VALUES ('fatigue_model_v2_initialized', '1')")
            # Old demonstration requests used admin_escalated as a dead end.
            # In the live model a normal request remains in the capacity queue
            # until a matching volunteer becomes available; SOS is the only
            # request that may still require explicit administrator handling.
            cursor.execute("""UPDATE dispatch_orders d SET dispatch_state = 'queued_waiting_capacity'
                              FROM orders o
                              WHERE o.order_id = d.order_id AND o.status = 'pending'
                                AND d.urgency = 'normal' AND d.dispatch_state = 'admin_escalated'""")
            _ensure_column(cursor, "elder_location_state", "location_source", "VARCHAR(24) NOT NULL DEFAULT 'simulated'")
            _ensure_column(cursor, "elder_location_state", "is_home_fixed", "BOOLEAN NOT NULL DEFAULT TRUE")
            ensure_region_columns(cursor)
            for adcode, region in SEED_REGIONS.items():
                cursor.execute("SELECT adcode FROM administrative_regions WHERE adcode = %s", (adcode,))
                if not cursor.fetchone():
                    cursor.execute("""INSERT INTO administrative_regions
                                      (adcode, name, city_name, region_level, bounds_json, active)
                                      VALUES (%s, %s, %s, %s, %s, TRUE)""",
                                   (adcode, region["name"], region["city"], region["level"], json.dumps(region["bounds"])))
            cursor.execute("CREATE INDEX IF NOT EXISTS idx_orders_region_status ON orders (region_adcode, status, created_at)")
            cursor.execute("CREATE INDEX IF NOT EXISTS idx_volunteer_region_available ON volunteer_location_state (service_region_adcode, availability)")
            conn.commit()
        seed_dispatch_demo_data(conn)
        seed_regional_demo_data(conn)
        _repair_active_dispatch_routes(conn)
        try:
            enrich_missing_polygons(conn, list(SEED_REGIONS))
        except Exception as enrich_exc:  # noqa: BLE001
            print(f"region polygon enrichment skipped: {enrich_exc}")
        refresh_runtime_catalog(REGION_CATALOG, conn)
        if DEFAULT_REGION_ADCODE in REGION_CATALOG:
            MAP_BOUNDS = REGION_CATALOG[DEFAULT_REGION_ADCODE]["bounds"]
        elif REGION_CATALOG:
            MAP_BOUNDS = next(iter(REGION_CATALOG.values()))["bounds"]
    except Exception as exc:
        conn.rollback()
        print(f"dispatch schema initialization failed: {exc}")
    finally:
        conn.close()


def _ensure_column(cursor: Any, table_name: str, column_name: str, definition: str) -> None:
    """Apply additive schema evolution without relying on PostgreSQL-only syntax."""
    cursor.execute(
        """SELECT column_name FROM information_schema.columns
           WHERE table_name = %s AND column_name = %s""",
        (table_name, column_name),
    )
    if not cursor.fetchone():
        # The table/column names are fixed local constants, not request data.
        cursor.execute(f"ALTER TABLE {table_name} ADD COLUMN {column_name} {definition}")


def _user_id(cursor: Any, username: str, role: str, name: str, index: int) -> int:
    cursor.execute("SELECT user_id FROM users WHERE username = %s", (username,))
    row = cursor.fetchone()
    if row:
        return int(row["user_id"])
    cursor.execute(
        """INSERT INTO users (username, password_hash, role, real_name, phone, email)
           VALUES (%s, 'pass123', %s, %s, %s, %s) RETURNING user_id""",
        (username, role, name, f"1399{index:07d}", f"{username}@dispatch.demo"),
    )
    return int(cursor.fetchone()["user_id"])


def _demo_point(index: int, ring: int) -> tuple[float, float]:
    """Spread simulated points over inland Baoshan, never the river/sea."""
    center_lng, center_lat = 121.458, 31.382
    radius = (0.026, 0.046, 0.060)[ring]
    angle = math.radians((index * 71 + ring * 29) % 360)
    lng = center_lng + math.cos(angle) * radius
    lat = center_lat + math.sin(angle) * radius * 0.58
    return round(max(121.402, min(121.518, lng)), 6), round(max(31.338, min(31.425, lat)), 6)


def seed_dispatch_demo_data(conn: Any) -> None:
    """Create a compact 8-volunteer / 25-elder Baoshan demo scenario."""
    skill_sets = [
        ["medical_support", "emergency_response", "mobility_assist", "errand"],
        ["medical_support", "rehab", "mobility_assist"],
        ["digital_assist", "companion", "errand"],
        ["companion", "rehab", "mobility_assist"],
        ["grooming", "companion", "errand"],
        ["medical_support", "emergency_response", "errand"],
        ["digital_assist", "companion"],
        ["rehab", "mobility_assist", "companion"],
    ]
    try:
        with conn.cursor() as cursor:
            cursor.execute("SELECT COUNT(*) AS count FROM volunteer_location_state")
            existing_locations = int(cursor.fetchone()["count"])
            cursor.execute("SELECT user_id FROM users WHERE role = 'volunteer' ORDER BY user_id")
            volunteer_ids = [int(row["user_id"]) for row in cursor.fetchall()]
            for index in range(len(volunteer_ids) + 1, 9):
                name = f"调度志愿者{index:02d}"
                user_id = _user_id(cursor, f"sim_vol_{index:02d}", "volunteer", name, 100 + index)
                cursor.execute("SELECT profile_id FROM volunteers_profile WHERE user_id = %s", (user_id,))
                if cursor.fetchone():
                    cursor.execute("UPDATE volunteers_profile SET audit_status = 'approved' WHERE user_id = %s", (user_id,))
                else:
                    cursor.execute("""INSERT INTO volunteers_profile (user_id, id_card, skills, audit_status)
                                      VALUES (%s, %s, %s, 'approved')""",
                                   (user_id, f"3101101990{index:08d}", "智能调度模拟志愿者"))
                volunteer_ids.append(user_id)

            volunteer_ids = volunteer_ids[:8]
            for index, user_id in enumerate(volunteer_ids):
                ring = 0 if index < 5 else 1 if index < 7 else 2
                lng, lat = _demo_point(index, ring)
                # Current position is the sole dispatch origin.  Home is a
                # different fixed destination used only when returning.
                home_lng, home_lat = _demo_point(index + 17, min(2, ring + 1))
                cursor.execute("SELECT volunteer_id FROM volunteer_location_state WHERE volunteer_id = %s", (user_id,))
                if not cursor.fetchone():
                    cursor.execute("""
                        INSERT INTO volunteer_location_state
                        (volunteer_id, lng, lat, home_lng, home_lat, availability, fatigue_score, service_rating, assigned_today)
                        VALUES (%s, %s, %s, %s, %s, 'idle', %s, %s, %s)
                    """, (user_id, lng, lat, home_lng, home_lat, 8 + (index * 9) % 52, round(4.15 + (index % 7) * 0.11, 2), index % 4))
                else:
                    cursor.execute("""UPDATE volunteer_location_state SET lng = %s, lat = %s
                                      WHERE volunteer_id = %s AND location_source = 'simulated'""", (lng, lat, user_id))
                cursor.execute("""UPDATE volunteer_location_state
                                  SET home_lng = %s, home_lat = %s
                                  WHERE volunteer_id = %s
                                    AND (home_lng IS NULL OR (home_lng = lng AND home_lat = lat AND location_source = 'simulated'))""",
                               (home_lng, home_lat, user_id))
                # One-time migration for legacy demo records where a virtual
                # starting point had been copied into the home fields.  Only
                # idle records with exactly equal coordinates are changed;
                # active/returning live journeys are never reset.
                cursor.execute("""UPDATE volunteer_location_state
                                  SET lng = %s, lat = %s, home_lng = %s, home_lat = %s,
                                      location_source = 'simulated', updated_at = CURRENT_TIMESTAMP
                                  WHERE volunteer_id = %s AND availability = 'idle'
                                    AND home_lng = lng AND home_lat = lat""",
                               (lng, lat, home_lng, home_lat, user_id))
                for skill in skill_sets[index % len(skill_sets)]:
                    cursor.execute("SELECT volunteer_id FROM volunteer_skill_tags WHERE volunteer_id = %s AND skill_tag = %s", (user_id, skill))
                    if not cursor.fetchone():
                        cursor.execute("INSERT INTO volunteer_skill_tags (volunteer_id, skill_tag) VALUES (%s, %s)", (user_id, skill))

            cursor.execute("""UPDATE volunteer_location_state SET availability = 'offline'
                              WHERE service_region_adcode = %s AND volunteer_id NOT IN %s""",
                           (DEFAULT_REGION_ADCODE, tuple(volunteer_ids)))

            cursor.execute("SELECT elder_id FROM elders ORDER BY elder_id")
            elder_ids = [int(row["elder_id"]) for row in cursor.fetchall()]
            for index in range(len(elder_ids) + 1, 26):
                name = f"宝山长者{index:02d}"
                user_id = _user_id(cursor, f"sim_elder_{index:02d}", "elder", name, 300 + index)
                cursor.execute("SELECT elder_id FROM elders WHERE user_id = %s", (user_id,))
                elder = cursor.fetchone()
                if elder:
                    elder_ids.append(int(elder["elder_id"]))
                    continue
                cursor.execute("""
                    INSERT INTO elders (user_id, name, age, gender, address, medical_history, alert_sys_threshold)
                    VALUES (%s, %s, %s, %s, %s, '智能调度模拟档案', 140) RETURNING elder_id
                """, (user_id, name, 68 + index % 22, "女" if index % 2 else "男", f"上海市宝山区友邻路{index}号"))
                elder_ids.append(int(cursor.fetchone()["elder_id"]))
            elder_ids = elder_ids[:25]
            for index, elder_id in enumerate(elder_ids):
                ring = 0 if index < 12 else 1 if index < 20 else 2
                lng, lat = _demo_point(index + 5, ring)
                cursor.execute("SELECT elder_id FROM elder_location_state WHERE elder_id = %s", (elder_id,))
                if not cursor.fetchone():
                    cursor.execute("INSERT INTO elder_location_state (elder_id, lng, lat) VALUES (%s, %s, %s)", (elder_id, lng, lat))
                else:
                    cursor.execute("""UPDATE elder_location_state SET lng = %s, lat = %s
                                      WHERE elder_id = %s AND location_source = 'simulated'""", (lng, lat, elder_id))
            cursor.execute("""UPDATE elder_location_state SET location_source = 'hidden_demo'
                              WHERE elder_id NOT IN %s
                                AND EXISTS (SELECT 1 FROM elders e WHERE e.elder_id = elder_location_state.elder_id
                                            AND e.region_adcode = %s)""",
                           (tuple(elder_ids), DEFAULT_REGION_ADCODE))
            if existing_locations == 0:
                cursor.execute("""INSERT INTO dispatch_events (event_type, message, details)
                    VALUES ('scenario_seeded', '宝山区调度沙盘已就绪：50位老人、20名志愿者。', %s)""",
                    (json.dumps({"near": 10, "middle": 5, "far": 5}, ensure_ascii=False),))
            conn.commit()
    except Exception:
        conn.rollback()
        raise


def _regional_demo_point(region_adcode: str, index: int) -> tuple[float, float]:
    """Deterministic, inland-looking points used only for the two regional demos."""
    center_lng, center_lat = REGION_CATALOG[region_adcode]["center"]
    angle = math.radians((index * 67 + 19) % 360)
    radius = 0.010 + (index % 3) * 0.006
    return round(center_lng + math.cos(angle) * radius, 6), round(center_lat + math.sin(angle) * radius * 0.72, 6)


def seed_regional_demo_data(conn: Any) -> None:
    """Seed two isolated district demos without touching existing Baoshan users."""
    scenarios = {
        "310115": {
            "admin": ("admin_pudong", "浦东新区管理员"),
            "prefix": "浦东",
            "volunteers": [
                ("浦东志愿者李晨", ["medical_support", "emergency_response", "errand"]),
                ("浦东志愿者王宁", ["companion", "rehab", "mobility_assist"]),
                ("浦东志愿者陈悦", ["digital_assist", "errand", "companion"]),
                ("浦东志愿者赵峰", ["medical_support", "emergency_response", "mobility_assist"]),
            ],
            "elders": [
                ("浦东张阿姨", "上海市浦东新区张江路665号"),
                ("浦东陈伯伯", "上海市浦东新区祖冲之路2305号"),
                ("浦东李奶奶", "上海市浦东新区金科路2889号"),
                ("浦东王大爷", "上海市浦东新区世纪大道100号"),
                ("浦东周阿姨", "上海市浦东新区杨高南路729号"),
                ("浦东孙爷爷", "上海市浦东新区浦东南路1111号"),
            ],
        },
        "110105": {
            "admin": ("admin_chaoyang", "朝阳区管理员"),
            "prefix": "朝阳",
            "volunteers": [
                ("朝阳志愿者刘洋", ["medical_support", "emergency_response", "mobility_assist"]),
                ("朝阳志愿者周倩", ["companion", "errand", "digital_assist"]),
                ("朝阳志愿者马强", ["medical_support", "rehab", "errand"]),
                ("朝阳志愿者何静", ["emergency_response", "companion", "mobility_assist"]),
            ],
            "elders": [
                ("朝阳赵阿姨", "北京市朝阳区望京街10号"),
                ("朝阳刘伯伯", "北京市朝阳区阜通东大街6号"),
                ("朝阳孙奶奶", "北京市朝阳区朝阳北路101号"),
                ("朝阳吴大爷", "北京市朝阳区建国路93号"),
                ("朝阳钱阿姨", "北京市朝阳区酒仙桥路10号"),
                ("朝阳冯爷爷", "北京市朝阳区北苑路170号"),
            ],
        },
    }
    try:
        with conn.cursor() as cursor:
            # Existing historical records predate regions and belong to Baoshan.
            cursor.execute("UPDATE elders SET region_adcode = %s WHERE region_adcode IS NULL OR region_adcode = ''", (DEFAULT_REGION_ADCODE,))
            cursor.execute("""UPDATE volunteer_location_state SET service_region_adcode = %s
                              WHERE service_region_adcode IS NULL OR service_region_adcode = ''""", (DEFAULT_REGION_ADCODE,))
            cursor.execute("UPDATE orders SET region_adcode = %s WHERE region_adcode IS NULL OR region_adcode = ''", (DEFAULT_REGION_ADCODE,))
            cursor.execute("UPDATE dispatch_orders SET region_adcode = %s WHERE region_adcode IS NULL OR region_adcode = ''", (DEFAULT_REGION_ADCODE,))
            cursor.execute("SELECT user_id FROM users WHERE username = 'admin' AND role = 'admin'")
            root_admin = cursor.fetchone()
            if root_admin:
                cursor.execute("SELECT 1 FROM admin_region_scope WHERE admin_user_id = %s AND region_adcode = '*'", (root_admin["user_id"],))
                if not cursor.fetchone():
                    cursor.execute("INSERT INTO admin_region_scope (admin_user_id, region_adcode, permission) VALUES (%s, '*', 'overview')", (root_admin["user_id"],))

            for region_adcode, scenario in scenarios.items():
                admin_username, admin_name = scenario["admin"]
                admin_id = _user_id(cursor, admin_username, "admin", admin_name, int(region_adcode[-4:]))
                cursor.execute("UPDATE users SET password_hash = 'Admin@2026' WHERE user_id = %s", (admin_id,))
                cursor.execute("SELECT 1 FROM admin_region_scope WHERE admin_user_id = %s AND region_adcode = %s", (admin_id, region_adcode))
                if not cursor.fetchone():
                    cursor.execute("INSERT INTO admin_region_scope (admin_user_id, region_adcode, permission) VALUES (%s, %s, 'manage')", (admin_id, region_adcode))

                for index, (name, skills) in enumerate(scenario["volunteers"], start=1):
                    username = f"demo_{region_adcode}_vol_{index}"
                    volunteer_id = _user_id(cursor, username, "volunteer", name, int(region_adcode[-4:]) + index)
                    cursor.execute("UPDATE users SET password_hash = 'pass123' WHERE user_id = %s", (volunteer_id,))
                    cursor.execute("SELECT profile_id FROM volunteers_profile WHERE user_id = %s", (volunteer_id,))
                    if cursor.fetchone():
                        cursor.execute("UPDATE volunteers_profile SET audit_status = 'approved' WHERE user_id = %s", (volunteer_id,))
                    else:
                        cursor.execute("""INSERT INTO volunteers_profile (user_id, id_card, skills, audit_status)
                                          VALUES (%s, %s, %s, 'approved')""",
                                       (volunteer_id, f"{region_adcode}19920{index:07d}", "区域智能调度演示志愿者"))
                    lng, lat = _regional_demo_point(region_adcode, index)
                    home_lng, home_lat = _regional_demo_point(region_adcode, index + 14)
                    cursor.execute("SELECT volunteer_id FROM volunteer_location_state WHERE volunteer_id = %s", (volunteer_id,))
                    if cursor.fetchone():
                        cursor.execute("""UPDATE volunteer_location_state
                                          SET lng = %s, lat = %s, home_lng = %s, home_lat = %s,
                                              service_region_adcode = %s, availability = 'idle', updated_at = CURRENT_TIMESTAMP
                                          WHERE volunteer_id = %s""",
                                       (lng, lat, home_lng, home_lat, region_adcode, volunteer_id))
                    else:
                        cursor.execute("""INSERT INTO volunteer_location_state
                                          (volunteer_id, lng, lat, home_lng, home_lat, service_region_adcode,
                                           availability, fatigue_score, service_rating, assigned_today, auto_accept_enabled)
                                          VALUES (%s, %s, %s, %s, %s, %s, 'idle', %s, %s, 0, TRUE)""",
                                       (volunteer_id, lng, lat, home_lng, home_lat, region_adcode, index * 5, 4.5 + (index % 3) / 10))
                    for skill in skills:
                        cursor.execute("SELECT 1 FROM volunteer_skill_tags WHERE volunteer_id = %s AND skill_tag = %s", (volunteer_id, skill))
                        if not cursor.fetchone():
                            cursor.execute("INSERT INTO volunteer_skill_tags (volunteer_id, skill_tag) VALUES (%s, %s)", (volunteer_id, skill))

                for index, (name, address) in enumerate(scenario["elders"], start=1):
                    username = f"demo_{region_adcode}_elder_{index}"
                    elder_user_id = _user_id(cursor, username, "elder", name, int(region_adcode[-4:]) + 100 + index)
                    cursor.execute("UPDATE users SET password_hash = 'pass123' WHERE user_id = %s", (elder_user_id,))
                    cursor.execute("SELECT elder_id FROM elders WHERE user_id = %s", (elder_user_id,))
                    elder = cursor.fetchone()
                    if elder:
                        elder_id = int(elder["elder_id"])
                        cursor.execute("UPDATE elders SET address = %s, region_adcode = %s WHERE elder_id = %s", (address, region_adcode, elder_id))
                    else:
                        cursor.execute("""INSERT INTO elders (user_id, name, age, gender, address, medical_history, alert_sys_threshold, region_adcode)
                                          VALUES (%s, %s, %s, %s, %s, '区域调度演示档案', 140, %s) RETURNING elder_id""",
                                       (elder_user_id, name, 68 + index, "女" if index % 2 else "男", address, region_adcode))
                        elder_id = int(cursor.fetchone()["elder_id"])
                    lng, lat = _regional_demo_point(region_adcode, index + 6)
                    cursor.execute("SELECT elder_id FROM elder_location_state WHERE elder_id = %s", (elder_id,))
                    if cursor.fetchone():
                        cursor.execute("UPDATE elder_location_state SET lng = %s, lat = %s, location_source = 'simulated' WHERE elder_id = %s", (lng, lat, elder_id))
                    else:
                        cursor.execute("INSERT INTO elder_location_state (elder_id, lng, lat, location_source, is_home_fixed) VALUES (%s, %s, %s, 'simulated', TRUE)", (elder_id, lng, lat))
                    family_id = _user_id(cursor, f"demo_{region_adcode}_family_{index}", "family", f"{name}家属", int(region_adcode[-4:]) + 200 + index)
                    cursor.execute("UPDATE users SET password_hash = 'pass123' WHERE user_id = %s", (family_id,))
                    cursor.execute("SELECT 1 FROM user_elder_relation WHERE family_user_id = %s AND elder_id = %s", (family_id, elder_id))
                    if not cursor.fetchone():
                        cursor.execute("INSERT INTO user_elder_relation (family_user_id, elder_id, relation_type) VALUES (%s, %s, '子女')", (family_id, elder_id))
            conn.commit()
    except Exception:
        conn.rollback()
        raise


def _traffic_version(cursor: Any) -> int:
    cursor.execute("SELECT state_value FROM dispatch_system_state WHERE state_key = 'traffic_version'")
    row = cursor.fetchone()
    return int(row["state_value"]) if row else 1


def _event(cursor: Any, order_id: int | None, event_type: str, message: str, details: dict[str, Any] | None = None) -> None:
    cursor.execute("""INSERT INTO dispatch_events (order_id, event_type, message, details)
                   VALUES (%s, %s, %s, %s)""",
                   (order_id, event_type, message, json.dumps(details or {}, ensure_ascii=False)))


def _fallback_open_region() -> str:
    if DEFAULT_REGION_ADCODE in REGION_CATALOG:
        return DEFAULT_REGION_ADCODE
    return next(iter(REGION_CATALOG), DEFAULT_REGION_ADCODE)


def _region_bounds(region_adcode: str | None) -> dict[str, float]:
    code = str(region_adcode or "")
    region = REGION_CATALOG.get(code) or REGION_CATALOG.get(_fallback_open_region())
    if not region:
        return SEED_REGIONS[DEFAULT_REGION_ADCODE]["bounds"]
    return region["bounds"]


def _region_for_point(lng: Any, lat: Any) -> str | None:
    """Resolve the configured dispatch district from a map point.

    Prefers official AMap district polygons stored in administrative_regions;
    falls back to rectangular bounds for seed rows without polylines yet.
    Only returns districts that are currently opened (active).
    """
    return resolve_region_adcode(lng, lat, REGION_CATALOG)


def _valid_region_point(lng: Any, lat: Any, region_adcode: str | None) -> tuple[float, float] | None:
    try:
        value_lng, value_lat = float(lng), float(lat)
    except (TypeError, ValueError):
        return None
    # Unopened / disabled districts must not accept location pins.
    if not is_active_region(region_adcode, REGION_CATALOG):
        return None
    # A small buffer keeps hand-entered nearby addresses usable while avoiding
    # accidental latitude/longitude swaps or a location outside this demo map.
    bounds = REGION_CATALOG[str(region_adcode)]["bounds"]
    if not (bounds["west"] - 0.02 <= value_lng <= bounds["east"] + 0.02):
        return None
    if not (bounds["south"] - 0.02 <= value_lat <= bounds["north"] + 0.02):
        return None
    return round(value_lng, 6), round(value_lat, 6)


def _bind_admin_to_region(cursor: Any, admin_user_id: int, region_adcode: str, permission: str = "manage") -> None:
    cursor.execute(
        "SELECT 1 FROM admin_region_scope WHERE admin_user_id = %s AND region_adcode = %s",
        (admin_user_id, region_adcode),
    )
    if cursor.fetchone():
        return
    cursor.execute(
        "INSERT INTO admin_region_scope (admin_user_id, region_adcode, permission) VALUES (%s, %s, %s)",
        (admin_user_id, region_adcode, permission),
    )


def _create_or_bind_district_admin(
    cursor: Any,
    region_adcode: str,
    *,
    manager_user_id: int | None = None,
    district_admin: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Bind an existing admin or create a new district admin for an opened region."""
    if manager_user_id:
        cursor.execute("SELECT user_id, username, real_name, role FROM users WHERE user_id = %s", (manager_user_id,))
        admin = cursor.fetchone()
        if not admin or admin["role"] != "admin":
            raise ValueError("指定的区管理员账号不存在或不是管理员")
        cursor.execute(
            "SELECT 1 FROM admin_region_scope WHERE admin_user_id = %s AND region_adcode = '*'",
            (manager_user_id,),
        )
        if cursor.fetchone():
            raise ValueError("总管理员无需再绑定区县；请创建或选择区级管理员")
        _bind_admin_to_region(cursor, int(manager_user_id), region_adcode, "manage")
        return {
            "user_id": int(admin["user_id"]),
            "username": admin["username"],
            "real_name": admin["real_name"],
            "created": False,
        }

    profile = district_admin or {}
    username = str(profile.get("username") or "").strip()
    password = str(profile.get("password") or "").strip()
    real_name = str(profile.get("real_name") or "").strip()
    phone = str(profile.get("phone") or "").strip()
    email = str(profile.get("email") or "").strip()
    if not all([username, password, real_name, phone, email]):
        raise ValueError("开通区县时请指定已有管理员，或完整填写新区管理员账号信息")

    cursor.execute("SELECT user_id FROM users WHERE username = %s", (username,))
    if cursor.fetchone():
        raise ValueError(f"用户名 {username} 已被占用")

    cursor.execute(
        """INSERT INTO users (username, password_hash, role, real_name, phone, email)
           VALUES (%s, %s, 'admin', %s, %s, %s) RETURNING user_id, username, real_name""",
        (username, password, real_name, phone, email),
    )
    created = cursor.fetchone()
    new_id = int(created["user_id"])
    _bind_admin_to_region(cursor, new_id, region_adcode, "manage")
    return {
        "user_id": new_id,
        "username": created["username"],
        "real_name": created["real_name"],
        "created": True,
    }


def _valid_baoshan_point(lng: Any, lat: Any) -> tuple[float, float] | None:
    """Backward-compatible helper for the existing Baoshan-only sandbox APIs."""
    return _valid_region_point(lng, lat, DEFAULT_REGION_ADCODE)


def _location_source(value: Any) -> str:
    return str(value) if value in ("fixed_home", "browser_gps", "virtual", "simulated") else "virtual"


def _amap_marker_url(lng: float, lat: float, name: str) -> str:
    params = urlencode({
        "position": f"{lng:.6f},{lat:.6f}", "name": name,
        "src": "elderly_care_system", "coordinate": "gaode", "callnative": "1",
    })
    return f"https://uri.amap.com/marker?{params}"


def _amap_navigation_url(from_lng: float, from_lat: float, to_lng: float, to_lat: float, destination_name: str) -> str:
    # URI API works in the browser and asks the mobile client to open AMap when
    # possible.  This avoids exposing a JS map key in the front-end bundle.
    params = urlencode({
        "from": f"{from_lng:.6f},{from_lat:.6f},志愿者当前位置",
        "to": f"{to_lng:.6f},{to_lat:.6f},{destination_name}",
        "mode": "car", "policy": "1", "src": "elderly_care_system",
        "coordinate": "gaode", "callnative": "1",
    })
    return f"https://uri.amap.com/navigation?{params}"


def _route_for_order(cursor: Any, order_id: int) -> dict[str, Any] | None:
    cursor.execute("SELECT volunteer_id, route_json, eta_minutes, traffic_version, replanned_at FROM dispatch_routes WHERE order_id = %s", (order_id,))
    row = cursor.fetchone()
    if not row:
        return None
    try:
        route = json.loads(row["route_json"])
    except (TypeError, json.JSONDecodeError):
        route = {"path": []}
    result = {
        "order_id": order_id, "volunteer_id": int(row["volunteer_id"]), "eta_minutes": int(row["eta_minutes"]),
        "traffic_version": int(row["traffic_version"]), "replanned_at": _iso(row["replanned_at"]), **route,
    }
    # The browser interpolates this anchor position on every animation frame;
    # the server only writes a coarser correction point.
    if result.get("journey_type") != "returning":
        result["motion_rate"] = _route_motion_rate(result)
    return result


def _return_route_for_volunteer(cursor: Any, volunteer_id: int) -> dict[str, Any] | None:
    """Expose the one persisted return journey to every authorised portal."""
    cursor.execute("""SELECT route_json, eta_minutes, traffic_version, updated_at
                      FROM volunteer_return_routes WHERE volunteer_id = %s""", (volunteer_id,))
    row = cursor.fetchone()
    if not row:
        return None
    try:
        route = json.loads(row["route_json"])
    except (TypeError, json.JSONDecodeError):
        route = {"path": []}
    return {
        "order_id": -int(volunteer_id), "volunteer_id": int(volunteer_id),
        "eta_minutes": int(row["eta_minutes"]), "traffic_version": int(row["traffic_version"]),
        "replanned_at": _iso(row["updated_at"]),
        "motion_rate": _route_motion_rate(route, RETURN_PROGRESS_PER_SECOND), **route,
    }


def _repair_active_dispatch_routes(conn: Any) -> None:
    """Repair legacy smart orders accepted through the old task-hall endpoint.

    Older UI flows could set an intelligent order to ``accepted`` without
    creating a dispatch route.  Repairing those rows once on startup keeps the
    volunteer, elder, family, and admin maps consistent.
    """
    with conn.cursor() as cursor:
        cursor.execute("""
            SELECT o.order_id, o.volunteer_id, o.status
            FROM orders o JOIN dispatch_orders d ON d.order_id = o.order_id
            LEFT JOIN dispatch_routes r ON r.order_id = o.order_id
            WHERE o.status IN ('accepted', 'in_progress')
              AND o.volunteer_id IS NOT NULL AND r.order_id IS NULL
        """)
        missing = cursor.fetchall()
        for row in missing:
            order = _order_context(cursor, int(row["order_id"]))
            if not order:
                continue
            volunteer_id = int(row["volunteer_id"])
            _create_route(cursor, order, volunteer_id)
            cursor.execute("""UPDATE dispatch_orders SET dispatch_state = %s WHERE order_id = %s""",
                           ("serving" if row["status"] == "in_progress" else "accepted", row["order_id"]))
            cursor.execute("""UPDATE volunteer_location_state SET availability = %s, updated_at = CURRENT_TIMESTAMP
                              WHERE volunteer_id = %s""",
                           ("serving" if row["status"] == "in_progress" else "en_route", volunteer_id))
        if missing:
            conn.commit()


def _order_context(cursor: Any, order_id: int) -> dict[str, Any] | None:
    cursor.execute("""
        SELECT o.order_id, o.elder_id, o.service_type, o.service_hours, o.status, o.volunteer_id,
               COALESCE(o.region_adcode, e.region_adcode, '310113') AS region_adcode,
               d.urgency, d.required_skills, d.dispatch_state, d.search_stage, d.dispatch_phase,
               d.phase_started_at, d.phase_expires_at, d.dispatch_version,
               d.forced_assignment, d.created_at, e.name AS elder_name,
               el.lng AS elder_lng, el.lat AS elder_lat
        FROM orders o
        JOIN dispatch_orders d ON d.order_id = o.order_id
        JOIN elders e ON e.elder_id = o.elder_id
        JOIN elder_location_state el ON el.elder_id = o.elder_id
        WHERE o.order_id = %s
    """, (order_id,))
    return cursor.fetchone()


def _volunteer_ready_for_new_dispatch(cursor: Any, volunteer_id: int, availability: str | None) -> bool:
    """Whether this volunteer may enter normal matching / auto-accept.

    - idle: yes
    - returning: yes (service already ended; may accept from the live return point)
    - en_route / serving / anything else: no, even if auto-accept is enabled
    """
    state = str(availability or "")
    if state not in ("idle", "returning"):
        return False
    cursor.execute("""SELECT 1 FROM orders WHERE volunteer_id = %s
                      AND status IN ('accepted', 'in_progress') LIMIT 1""", (volunteer_id,))
    return cursor.fetchone() is None


def _candidate_rows(cursor: Any, order: dict[str, Any]) -> list[dict[str, Any]]:
    required = set(json.loads(order["required_skills"]))
    version = _traffic_version(cursor)
    # Always score from the volunteer's current map point (lng/lat), never the
    # home_lng/home_lat virtual base.  Returning volunteers are first projected
    # onto their live return polyline so distance/ETA stay physical.
    cursor.execute("""SELECT volunteer_id FROM volunteer_location_state
                      WHERE availability = 'returning' AND service_region_adcode = %s""", (order["region_adcode"],))
    for returning in cursor.fetchall():
        _materialize_return_position(cursor, int(returning["volunteer_id"]))
    cursor.execute("""
        SELECT p.volunteer_id, p.lng, p.lat, p.availability, p.fatigue_score,
               p.service_rating, p.assigned_today, u.real_name,
               COALESCE(string_agg(s.skill_tag, '|'), '') AS skill_tags_text
        FROM volunteer_location_state p
        JOIN users u ON u.user_id = p.volunteer_id
        LEFT JOIN volunteer_skill_tags s ON s.volunteer_id = p.volunteer_id
        WHERE u.role = 'volunteer' AND p.service_region_adcode = %s
          AND p.availability IN ('idle', 'returning')
          AND p.fatigue_score < 85
          AND NOT EXISTS (SELECT 1 FROM orders active WHERE active.volunteer_id = p.volunteer_id
                          AND active.status IN ('accepted', 'in_progress'))
        GROUP BY p.volunteer_id, p.lng, p.lat, p.availability, p.fatigue_score,
                 p.service_rating, p.assigned_today, u.real_name
        ORDER BY p.volunteer_id
    """, (order["region_adcode"],))
    candidates = []
    for volunteer in cursor.fetchall():
        if not _volunteer_ready_for_new_dispatch(cursor, int(volunteer["volunteer_id"]), volunteer.get("availability")):
            continue
        skills = {tag for tag in str(volunteer.get("skill_tags_text") or "").split("|") if tag}
        skill_ok = required.issubset(skills)
        distance = _distance_km(float(volunteer["lng"]), float(volunteer["lat"]), float(order["elder_lng"]), float(order["elder_lat"]))
        route = route_endpoints(float(volunteer["lng"]), float(volunteer["lat"]), float(order["elder_lng"]), float(order["elder_lat"]), version)
        eta = route["eta_minutes"]
        fatigue = int(volunteer["fatigue_score"])
        rating = float(volunteer["service_rating"])
        distance_score = max(0.0, 100 - distance / FAR_RADIUS_KM * 100)
        traffic_score = max(0.0, 100 - eta / 35 * 100)
        # Physical fatigue and fairness are related but not counted twice.
        # Fatigue is accumulated only after a completed service; completed
        # jobs make a smaller fairness adjustment for the rest of the day.
        fatigue_score = max(0.0, 100 - fatigue * .75 - int(volunteer["assigned_today"]) * 4)
        rating_score = min(100.0, rating / 5 * 100)
        total = round(distance_score * .40 + traffic_score * .25 + fatigue_score * .10 + rating_score * .25, 2)
        candidates.append({
            **volunteer,
            "skill_ok": skill_ok,
            "required": sorted(required),
            "skills": sorted(skills),
            "distance_km": distance,
            "route": route,
            "eta_minutes": eta,
            "distance_score": round(distance_score, 2),
            "traffic_score": round(traffic_score, 2),
            "fatigue_component": round(fatigue_score, 2),
            "rating_component": round(rating_score, 2),
            "total_score": total,
        })
    candidates.sort(key=lambda item: (not item["skill_ok"], -item["total_score"], item["eta_minutes"]))
    return candidates


def _next_assignment_preview(cursor: Any, volunteer_id: int) -> dict[str, Any] | None:
    """Build a non-binding next-job forecast for an auto-accept volunteer.

    Mid-service volunteers never get matched.  Preview appears once they are
    idle or already returning home (service finished).
    """
    cursor.execute("""
        SELECT p.lng, p.lat, p.fatigue_score, p.assigned_today, p.service_rating,
               p.auto_accept_enabled, p.availability,
               COALESCE(string_agg(s.skill_tag, '|'), '') AS skills_text
        FROM volunteer_location_state p
        LEFT JOIN volunteer_skill_tags s ON s.volunteer_id = p.volunteer_id
        WHERE p.volunteer_id = %s
        GROUP BY p.lng, p.lat, p.fatigue_score, p.assigned_today, p.service_rating,
                 p.auto_accept_enabled, p.availability
    """, (volunteer_id,))
    volunteer = cursor.fetchone()
    if not volunteer or not volunteer["auto_accept_enabled"]:
        return None
    if volunteer.get("availability") == "returning":
        _materialize_return_position(cursor, volunteer_id)
        cursor.execute("SELECT lng, lat FROM volunteer_location_state WHERE volunteer_id = %s", (volunteer_id,))
        live = cursor.fetchone()
        if live:
            volunteer = {**volunteer, "lng": live["lng"], "lat": live["lat"]}
    if not _volunteer_ready_for_new_dispatch(cursor, volunteer_id, volunteer.get("availability")):
        return None
    skills = {tag for tag in str(volunteer.get("skills_text") or "").split("|") if tag}
    origin_lng = float(volunteer["lng"])
    origin_lat = float(volunteer["lat"])
    cursor.execute("""
        SELECT o.order_id, o.service_type, o.address, d.urgency, d.required_skills,
               e.name AS elder_name, e.address AS elder_address, el.lng, el.lat
        FROM orders o JOIN dispatch_orders d ON d.order_id = o.order_id
        JOIN elders e ON e.elder_id = o.elder_id
        JOIN elder_location_state el ON el.elder_id = o.elder_id
        WHERE o.status = 'pending' AND o.region_adcode = (
            SELECT service_region_adcode FROM volunteer_location_state WHERE volunteer_id = %s
        )
        ORDER BY (d.urgency = 'sos') DESC, d.created_at ASC
        LIMIT 40
    """, (volunteer_id,))
    best: dict[str, Any] | None = None
    version = _traffic_version(cursor)
    for row in cursor.fetchall():
        required = set(json.loads(row["required_skills"]))
        if not required.issubset(skills):
            continue
        distance = _distance_km(origin_lng, origin_lat, float(row["lng"]), float(row["lat"]))
        route = route_endpoints(origin_lng, origin_lat, float(row["lng"]), float(row["lat"]), version)
        distance_score = max(0.0, 100 - distance / FAR_RADIUS_KM * 100)
        traffic_score = max(0.0, 100 - route["eta_minutes"] / 35 * 100)
        fatigue_score = max(0.0, 100 - int(volunteer["fatigue_score"]) * .75 - int(volunteer["assigned_today"]) * 4)
        rating_score = min(100.0, float(volunteer["service_rating"]) / 5 * 100)
        score = round(distance_score * .40 + traffic_score * .25 + fatigue_score * .10 + rating_score * .25, 2)
        item = {
            "order_id": int(row["order_id"]), "elder_name": row["elder_name"], "service_type": row["service_type"],
            "urgency": row["urgency"], "address": row["address"] or row["elder_address"],
            "lng": float(row["lng"]), "lat": float(row["lat"]), "distance_km": round(distance, 2),
            "eta_minutes": int(route["eta_minutes"]), "total_score": score,
            "required_skill_labels": [SKILL_LABELS.get(tag, tag) for tag in sorted(required)],
        }
        if best is None or (item["urgency"] == "sos", item["total_score"], -item["eta_minutes"]) > (best["urgency"] == "sos", best["total_score"], -best["eta_minutes"]):
            best = item
    return best


def _upsert_candidates(cursor: Any, order: dict[str, Any]) -> list[dict[str, Any]]:
    candidates = _candidate_rows(cursor, order)
    # Each phase refresh has a new availability snapshot.  Keep the audit rows
    # but deactivate stale candidates; otherwise a person who started serving
    # could remain visible after a page refresh.
    cursor.execute("""UPDATE dispatch_candidates SET eligible = FALSE
                      WHERE order_id = %s AND response_status IN ('waiting', 'invited')""", (order["order_id"],))
    eligible_rank = 0
    for item in candidates:
        if not item["skill_ok"]:
            continue
        eligible_rank += 1
        values = (
            order["order_id"], item["volunteer_id"], True, "精确匹配",
            item["distance_km"], item["eta_minutes"], item["distance_score"], item["traffic_score"],
            item["fatigue_component"], item["rating_component"], item["total_score"], eligible_rank,
        )
        cursor.execute("SELECT candidate_id FROM dispatch_candidates WHERE order_id = %s AND volunteer_id = %s", (order["order_id"], item["volunteer_id"]))
        if cursor.fetchone():
            cursor.execute("""UPDATE dispatch_candidates SET eligible = %s, skill_match = %s, distance_km = %s, eta_minutes = %s,
                              distance_score = %s, traffic_score = %s, fatigue_score = %s, rating_score = %s,
                              total_score = %s, candidate_rank = %s WHERE order_id = %s AND volunteer_id = %s""",
                           values[2:] + values[:2])
        else:
            cursor.execute("""INSERT INTO dispatch_candidates
                (order_id, volunteer_id, eligible, skill_match, distance_km, eta_minutes,
                 distance_score, traffic_score, fatigue_score, rating_score, total_score, candidate_rank)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""", values)
    return candidates


def _stage_radius(stage: int) -> float:
    return NEAR_RADIUS_KM if stage == 1 else MID_RADIUS_KM if stage == 2 else FAR_RADIUS_KM


def _phase_settings(phase: str) -> tuple[int, int | None, int | None, str]:
    """Return stage, manual visibility cap, this phase's duration, and label."""
    return {
        "top1": (1, 1, TOP1_WINDOW_SECONDS, "Top1 专属确认"),
        "top3": (2, 3, TOP3_WINDOW_SECONDS - TOP1_WINDOW_SECONDS, "Top3 抢单"),
        "top10": (3, 10, TOP10_WINDOW_SECONDS - TOP3_WINDOW_SECONDS, "Top10 扩散抢单"),
        # Keep Top10-scale manual invites open after the timed windows end.
        # Auto-accept only covers volunteers who opted in; others must still
        # be able to see and claim the order from their portal.
        "fallback": (4, 10, None, "自动兜底+人工可抢"),
    }.get(phase, (1, 1, TOP1_WINDOW_SECONDS, "Top1 专属确认"))


def _set_dispatch_phase(cursor: Any, order: dict[str, Any], phase: str) -> None:
    stage, _, expiry_seconds, label = _phase_settings(phase)
    cursor.execute("""UPDATE dispatch_orders
                      SET dispatch_phase = %s, search_stage = %s,
                          phase_started_at = CURRENT_TIMESTAMP,
                          phase_expires_at = CASE WHEN %s IS NULL THEN NULL
                              ELSE CURRENT_TIMESTAMP + (%s * INTERVAL '1 second') END,
                          dispatch_version = COALESCE(dispatch_version, 0) + 1,
                          last_expanded_at = CURRENT_TIMESTAMP
                      WHERE order_id = %s""",
                   (phase, stage, expiry_seconds, expiry_seconds, order["order_id"]))
    order["dispatch_phase"] = phase
    order["search_stage"] = stage
    _event(cursor, int(order["order_id"]), "dispatch_phase_changed", f"调度进入{label}阶段。",
           {"phase": phase, "stage": stage, "expires_after_seconds": expiry_seconds})


def _invite_candidates(cursor: Any, order: dict[str, Any], reason: str = "") -> bool:
    """Publish a stable manual candidate snapshot for the current phase."""
    phase = str(order.get("dispatch_phase") or "top1")
    stage, cap, _, label = _phase_settings(phase)
    if cap is None:
        return False
    # Close an earlier manual window before publishing the new snapshot.  The
    # next successful acceptance is still protected by row locks.
    cursor.execute("""UPDATE dispatch_candidates SET response_status = 'waiting', invited_at = NULL
                      WHERE order_id = %s AND response_status = 'invited'""", (order["order_id"],))
    cursor.execute("""
        SELECT c.volunteer_id, c.candidate_rank, c.distance_km, c.total_score, p.availability
        FROM dispatch_candidates c JOIN volunteer_location_state p ON p.volunteer_id = c.volunteer_id
        WHERE c.order_id = %s AND c.eligible = TRUE
          AND c.response_status = 'waiting' AND p.availability IN ('idle', 'returning')
          AND NOT EXISTS (SELECT 1 FROM orders active WHERE active.volunteer_id = c.volunteer_id
                          AND active.status IN ('accepted', 'in_progress'))
        ORDER BY c.candidate_rank NULLS LAST, c.total_score DESC
        LIMIT %s
    """, (order["order_id"], max(cap * 4, 40)))
    rows = []
    for row in cursor.fetchall():
        if not _volunteer_ready_for_new_dispatch(cursor, int(row["volunteer_id"]), row.get("availability")):
            continue
        rows.append(row)
        if len(rows) >= cap:
            break
    for row in rows:
        cursor.execute("""UPDATE dispatch_candidates SET response_status = 'invited', invited_at = CURRENT_TIMESTAMP
                          WHERE order_id = %s AND volunteer_id = %s AND response_status = 'waiting'""",
                       (order["order_id"], row["volunteer_id"]))
    if rows:
        ranks = [int(row["candidate_rank"]) for row in rows]
        _event(cursor, int(order["order_id"]), "candidates_invited",
               f"{label}已开放给排名 {', '.join(map(str, ranks))} 的技能匹配志愿者。",
               {"phase": phase, "stage": stage, "ranks": ranks, "reason": reason})
        return True
    else:
        _event(cursor, int(order["order_id"]), "no_eligible_candidate", "当前范围内没有同时满足技能与空闲条件的志愿者。", {"stage": stage})
        return False


def _create_route(cursor: Any, order: dict[str, Any], volunteer_id: int) -> dict[str, Any]:
    cursor.execute("SELECT lng, lat FROM volunteer_location_state WHERE volunteer_id = %s", (volunteer_id,))
    volunteer = cursor.fetchone()
    route = route_endpoints(float(volunteer["lng"]), float(volunteer["lat"]), float(order["elder_lng"]), float(order["elder_lat"]), _traffic_version(cursor))
    route["progress"] = 0
    route_values = (volunteer_id, json.dumps(route, ensure_ascii=False), route["eta_minutes"], route["traffic_version"], order["order_id"])
    cursor.execute("SELECT order_id FROM dispatch_routes WHERE order_id = %s", (order["order_id"],))
    if cursor.fetchone():
        cursor.execute("""UPDATE dispatch_routes SET volunteer_id = %s, route_json = %s, eta_minutes = %s,
                          traffic_version = %s, replanned_at = CURRENT_TIMESTAMP WHERE order_id = %s""", route_values)
    else:
        cursor.execute("""INSERT INTO dispatch_routes (order_id, volunteer_id, route_json, eta_minutes, traffic_version, replanned_at)
                          VALUES (%s, %s, %s, %s, %s, CURRENT_TIMESTAMP)""",
                       (order["order_id"], volunteer_id, json.dumps(route, ensure_ascii=False), route["eta_minutes"], route["traffic_version"]))
    return route


def _ensure_service_conversation(cursor: Any, order: dict[str, Any], volunteer_id: int) -> None:
    """Open a privacy-scoped service conversation only after a real assignment."""
    cursor.execute("SELECT conversation_id FROM conversations WHERE order_id = %s AND conversation_type = 'service'", (order["order_id"],))
    existing = cursor.fetchone()
    if existing:
        return
    cursor.execute("""INSERT INTO conversations (conversation_type, elder_id, order_id)
                      VALUES ('service', %s, %s) RETURNING conversation_id""",
                   (order["elder_id"], order["order_id"]))
    conversation_id = int(cursor.fetchone()["conversation_id"])
    cursor.execute("SELECT user_id FROM elders WHERE elder_id = %s", (order["elder_id"],))
    elder_user = cursor.fetchone()
    member_ids = {volunteer_id}
    if elder_user:
        member_ids.add(int(elder_user["user_id"]))
    cursor.execute("SELECT family_user_id FROM user_elder_relation WHERE elder_id = %s", (order["elder_id"],))
    member_ids.update(int(row["family_user_id"]) for row in cursor.fetchall())
    for member_id in member_ids:
        cursor.execute("SELECT role FROM users WHERE user_id = %s", (member_id,))
        user = cursor.fetchone()
        if user:
            cursor.execute("""INSERT INTO conversation_members (conversation_id, user_id, role_in_conversation)
                              VALUES (%s, %s, %s)""", (conversation_id, member_id, user["role"]))
    cursor.execute("""INSERT INTO conversation_messages (conversation_id, sender_user_id, message_type, content)
                      VALUES (%s, NULL, 'system', '服务已接单，已开放服务沟通会话。')""", (conversation_id,))


def _create_return_route(cursor: Any, volunteer_id: int) -> dict[str, Any] | None:
    cursor.execute("""SELECT lng, lat, home_lng, home_lat FROM volunteer_location_state
                      WHERE volunteer_id = %s""", (volunteer_id,))
    volunteer = cursor.fetchone()
    if not volunteer or volunteer["home_lng"] is None or volunteer["home_lat"] is None:
        return None
    route = route_endpoints(float(volunteer["lng"]), float(volunteer["lat"]), float(volunteer["home_lng"]), float(volunteer["home_lat"]), _traffic_version(cursor))
    route.update({"progress": 0, "journey_type": "returning", "motion_seconds": _demo_motion_seconds(route.get("eta_minutes"), returning=True), "home_lng": float(volunteer["home_lng"]), "home_lat": float(volunteer["home_lat"])})
    cursor.execute("SELECT volunteer_id FROM volunteer_return_routes WHERE volunteer_id = %s", (volunteer_id,))
    if cursor.fetchone():
        cursor.execute("""UPDATE volunteer_return_routes SET route_json = %s, eta_minutes = %s, traffic_version = %s,
                          updated_at = CURRENT_TIMESTAMP WHERE volunteer_id = %s""",
                       (json.dumps(route, ensure_ascii=False), route["eta_minutes"], route["traffic_version"], volunteer_id))
    else:
        cursor.execute("""INSERT INTO volunteer_return_routes (volunteer_id, route_json, eta_minutes, traffic_version)
                          VALUES (%s, %s, %s, %s)""",
                       (volunteer_id, json.dumps(route, ensure_ascii=False), route["eta_minutes"], route["traffic_version"]))
    cursor.execute("UPDATE volunteer_location_state SET return_started_at = CURRENT_TIMESTAMP WHERE volunteer_id = %s", (volunteer_id,))
    return route


def _materialize_return_position(cursor: Any, volunteer_id: int) -> tuple[float, float] | None:
    """Persist a returning volunteer's exact current point before reassignment.

    Map polling is intentionally coarse, but assignment is an authoritative
    event.  Recompute elapsed return progress here so an SOS/new order created
    between polls starts from the point currently reached on the purple route,
    never from an old home/current-location snapshot.
    """
    cursor.execute("""SELECT route_json, eta_minutes, updated_at
                      FROM volunteer_return_routes WHERE volunteer_id = %s FOR UPDATE""", (volunteer_id,))
    saved = cursor.fetchone()
    if not saved:
        return None
    try:
        route = json.loads(saved["route_json"])
        path = route.get("path", [])
    except (TypeError, json.JSONDecodeError):
        return None
    if len(path) < 2:
        return None
    last = saved.get("updated_at")
    elapsed = max(0.0, (_now() - last).total_seconds()) if isinstance(last, dt.datetime) else 0.0
    progress = min(100.0, float(route.get("progress", 0)) + elapsed * _route_motion_rate(route, RETURN_PROGRESS_PER_SECOND))
    lng, lat = _point_on_route(path, progress / 100.0)
    route["progress"] = round(progress, 2)
    cursor.execute("""UPDATE volunteer_location_state SET lng = %s, lat = %s,
                      location_source = 'virtual', updated_at = CURRENT_TIMESTAMP WHERE volunteer_id = %s""",
                   (lng, lat, volunteer_id))
    cursor.execute("""UPDATE volunteer_return_routes SET route_json = %s, eta_minutes = %s,
                      updated_at = CURRENT_TIMESTAMP WHERE volunteer_id = %s""",
                   (json.dumps(route, ensure_ascii=False), max(0, round(int(saved["eta_minutes"]) * (100 - progress) / 100)), volunteer_id))
    return lng, lat


def _materialize_dispatch_position(cursor: Any, order_id: int, volunteer_id: int) -> tuple[float, float] | None:
    """Persist the exact outbound point before cancellation or release."""
    cursor.execute("""SELECT route_json, eta_minutes, replanned_at
                      FROM dispatch_routes WHERE order_id = %s AND volunteer_id = %s FOR UPDATE""",
                   (order_id, volunteer_id))
    saved = cursor.fetchone()
    if not saved:
        return None
    try:
        route = json.loads(saved["route_json"])
        path = route.get("path", [])
    except (TypeError, json.JSONDecodeError):
        return None
    if len(path) < 2:
        return None
    last = saved.get("replanned_at")
    elapsed = max(0.0, (_now() - last).total_seconds()) if isinstance(last, dt.datetime) else 0.0
    progress = min(100.0, float(route.get("progress", 0)) + elapsed * _route_motion_rate(route))
    lng, lat = _point_on_route(path, progress / 100.0)
    route["progress"] = round(progress, 2)
    cursor.execute("""UPDATE volunteer_location_state SET lng = %s, lat = %s,
                      location_source = 'virtual', updated_at = CURRENT_TIMESTAMP WHERE volunteer_id = %s""",
                   (lng, lat, volunteer_id))
    cursor.execute("""UPDATE dispatch_routes SET route_json = %s, eta_minutes = %s,
                      replanned_at = CURRENT_TIMESTAMP WHERE order_id = %s""",
                   (json.dumps(route, ensure_ascii=False), max(0, round(int(saved["eta_minutes"]) * (100 - progress) / 100)), order_id))
    return lng, lat


def _accept_candidate(cursor: Any, order: dict[str, Any], volunteer_id: int, automatic: bool = False) -> dict[str, Any] | None:
    """Commit one normal assignment with order and volunteer level locks."""
    # Lock the order even when this helper is called by automatic fallback or
    # administrator assignment.  The manual endpoint already holds this row,
    # but acquiring it here makes every assignment path safe across multiple
    # browser requests and multiple Flask workers.
    cursor.execute("SELECT status, volunteer_id FROM orders WHERE order_id = %s FOR UPDATE", (order["order_id"],))
    locked_order = cursor.fetchone()
    if not locked_order or locked_order["status"] != "pending" or locked_order["volunteer_id"] is not None:
        return None
    # Serialize assignment attempts per volunteer too.  A single person cannot
    # win two different orders from two tabs in the same instant.
    cursor.execute("SELECT user_id FROM users WHERE user_id = %s FOR UPDATE", (volunteer_id,))
    if not cursor.fetchone():
        return None
    cursor.execute("SELECT availability FROM volunteer_location_state WHERE volunteer_id = %s FOR UPDATE", (volunteer_id,))
    state = cursor.fetchone()
    if not state or state["availability"] not in ("idle", "returning"):
        return None
    if state["availability"] == "returning":
        _materialize_return_position(cursor, volunteer_id)
    cursor.execute("""SELECT order_id FROM orders WHERE volunteer_id = %s
                      AND status IN ('accepted', 'in_progress')""", (volunteer_id,))
    if cursor.fetchone():
        return None
    cursor.execute("UPDATE orders SET volunteer_id = %s, status = 'accepted' WHERE order_id = %s", (volunteer_id, order["order_id"]))
    cursor.execute("UPDATE dispatch_orders SET dispatch_state = 'accepted' WHERE order_id = %s", (order["order_id"],))
    cursor.execute("""UPDATE dispatch_candidates SET response_status = CASE WHEN volunteer_id = %s THEN 'accepted' ELSE response_status END,
                      responded_at = CURRENT_TIMESTAMP WHERE order_id = %s""", (volunteer_id, order["order_id"]))
    cursor.execute("""UPDATE dispatch_candidates SET response_status = 'expired', responded_at = CURRENT_TIMESTAMP
                      WHERE order_id = %s AND volunteer_id <> %s AND response_status IN ('waiting', 'invited')""",
                   (order["order_id"], volunteer_id))
    # Accepting reserves capacity but is not physical fatigue.  Fatigue and
    # today's completed-service count change only at service completion.
    cursor.execute("""UPDATE volunteer_location_state SET availability = 'en_route', return_started_at = NULL,
                      updated_at = CURRENT_TIMESTAMP WHERE volunteer_id = %s""", (volunteer_id,))
    cursor.execute("DELETE FROM volunteer_return_routes WHERE volunteer_id = %s", (volunteer_id,))
    route = _create_route(cursor, order, volunteer_id)
    _ensure_service_conversation(cursor, order, volunteer_id)
    mode = "自动接单" if automatic else "自主接单"
    _event(cursor, int(order["order_id"]), "candidate_auto_accepted" if automatic else "candidate_accepted",
           f"志愿者{mode}成功，已生成高德真实道路路线。", {"volunteer_id": volunteer_id, "automatic": automatic})
    return route


def _release_dispatch_order(cursor: Any, order: dict[str, Any], volunteer_id: int, event_type: str, reason: str) -> None:
    """Return a pre-service assignment to the queue and immediately re-rank it."""
    cursor.execute("""UPDATE dispatch_candidates SET response_status = 'declined', responded_at = CURRENT_TIMESTAMP
                      WHERE order_id = %s AND volunteer_id = %s""", (order["order_id"], volunteer_id))
    cursor.execute("""UPDATE dispatch_candidates SET response_status = 'waiting', responded_at = NULL
                      WHERE order_id = %s AND volunteer_id <> %s AND response_status = 'expired'""",
                   (order["order_id"], volunteer_id))
    cursor.execute("UPDATE orders SET volunteer_id = NULL, status = 'pending' WHERE order_id = %s", (order["order_id"],))
    cursor.execute("""UPDATE dispatch_orders SET dispatch_state = 'matching', last_expanded_at = CURRENT_TIMESTAMP
                      WHERE order_id = %s""", (order["order_id"],))
    _materialize_dispatch_position(cursor, int(order["order_id"]), volunteer_id)
    cursor.execute("DELETE FROM dispatch_routes WHERE order_id = %s", (order["order_id"],))
    return_route = _create_return_route(cursor, volunteer_id)
    cursor.execute("""UPDATE volunteer_location_state SET availability = %s, updated_at = CURRENT_TIMESTAMP
                      WHERE volunteer_id = %s""", ("returning" if return_route else "idle", volunteer_id))
    if order.get("urgency") != "sos":
        _set_dispatch_phase(cursor, order, "top1")
    _upsert_candidates(cursor, order)
    _invite_candidates(cursor, order, reason)
    _event(cursor, int(order["order_id"]), event_type, reason, {"volunteer_id": volunteer_id})


def _try_auto_accept(cursor: Any, order: dict[str, Any]) -> bool:
    """Fallback only: assign the highest-ranked volunteer who opted in."""
    # Re-rank from live coordinates.  Mid-service volunteers are excluded even
    # when auto-accept is on; returning (service finished) may accept immediately.
    _upsert_candidates(cursor, order)
    cursor.execute("""
        SELECT c.volunteer_id, p.availability FROM dispatch_candidates c
        JOIN volunteer_location_state p ON p.volunteer_id = c.volunteer_id
        WHERE c.order_id = %s AND c.eligible = TRUE AND c.response_status IN ('waiting', 'invited')
          AND p.auto_accept_enabled = TRUE AND p.availability IN ('idle', 'returning')
        ORDER BY c.candidate_rank NULLS LAST, c.total_score DESC
    """, (order["order_id"],))
    for candidate in cursor.fetchall():
        volunteer_id = int(candidate["volunteer_id"])
        if not _volunteer_ready_for_new_dispatch(cursor, volunteer_id, candidate.get("availability")):
            continue
        if _accept_candidate(cursor, order, volunteer_id, automatic=True) is not None:
            return True
    return False


def _advance_route_to_current_intersection(cursor: Any, order_id: int, volunteer_id: int) -> None:
    """Move an SOS responder to its nearest simulated route intersection before replanning."""
    cursor.execute("SELECT route_json, eta_minutes, replanned_at FROM dispatch_routes WHERE order_id = %s", (order_id,))
    saved = cursor.fetchone()
    if not saved:
        return
    try:
        path = json.loads(saved["route_json"]).get("path", [])
    except (TypeError, json.JSONDecodeError):
        return
    if len(path) < 3:
        return
    elapsed = 0.0
    if isinstance(saved.get("replanned_at"), dt.datetime):
        elapsed = max(0.0, (_now() - saved["replanned_at"]).total_seconds() / 60)
    eta = max(1, int(saved.get("eta_minutes") or 1))
    # Stop before the destination: a sudden traffic event re-routes from the
    # closest next intersection in the responder's current direction.
    progress = min(0.85, elapsed / eta)
    index = _clamp(max(1, round(progress * (len(path) - 1))), 1, len(path) - 2)
    lng, lat = path[index]
    cursor.execute("""UPDATE volunteer_location_state SET lng = %s, lat = %s, updated_at = CURRENT_TIMESTAMP
                      WHERE volunteer_id = %s""", (lng, lat, volunteer_id))


def _force_assign_sos(cursor: Any, order: dict[str, Any]) -> bool:
    candidates = _upsert_candidates(cursor, order)
    # SOS still cannot steal a volunteer who is mid-service / en route.
    # Returning volunteers (service finished) may be pulled from the live return point.
    available = [
        item for item in candidates
        if item["skill_ok"] and _volunteer_ready_for_new_dispatch(cursor, int(item["volunteer_id"]), item.get("availability"))
    ]
    if not available:
        cursor.execute("UPDATE dispatch_orders SET dispatch_state = 'admin_escalated' WHERE order_id = %s", (order["order_id"],))
        _event(cursor, int(order["order_id"]), "sos_admin_escalated", "SOS无可用且技能匹配的志愿者，已通知管理员人工介入。")
        return False
    # SOS uses ETA first: traffic-aware nearest eligible and idle volunteer.
    volunteer_id = None
    for candidate in sorted(available, key=lambda item: (item["eta_minutes"], item["distance_km"], -item["total_score"])):
        candidate_id = int(candidate["volunteer_id"])
        cursor.execute("SELECT user_id FROM users WHERE user_id = %s FOR UPDATE", (candidate_id,))
        if not cursor.fetchone():
            continue
        cursor.execute("SELECT availability FROM volunteer_location_state WHERE volunteer_id = %s FOR UPDATE", (candidate_id,))
        state = cursor.fetchone()
        if state and _volunteer_ready_for_new_dispatch(cursor, candidate_id, state.get("availability")):
            volunteer_id = candidate_id
            break
    if volunteer_id is None:
        cursor.execute("UPDATE dispatch_orders SET dispatch_state = 'admin_escalated' WHERE order_id = %s", (order["order_id"],))
        _event(cursor, int(order["order_id"]), "sos_contention_escalated", "SOS候选在并发锁校验中已被其他订单占用，转管理员介入。")
        return False
    cursor.execute("SELECT availability FROM volunteer_location_state WHERE volunteer_id = %s FOR UPDATE", (volunteer_id,))
    selected_state = cursor.fetchone()
    if selected_state and selected_state["availability"] == "returning":
        _materialize_return_position(cursor, volunteer_id)
    cursor.execute("UPDATE orders SET volunteer_id = %s, status = 'accepted' WHERE order_id = %s", (volunteer_id, order["order_id"]))
    cursor.execute("""UPDATE dispatch_orders SET dispatch_state = 'forced_assigned', forced_assignment = TRUE
                      WHERE order_id = %s""", (order["order_id"],))
    cursor.execute("""UPDATE dispatch_candidates SET response_status = CASE WHEN volunteer_id = %s THEN 'forced' ELSE response_status END,
                      invited_at = CURRENT_TIMESTAMP WHERE order_id = %s""", (volunteer_id, order["order_id"]))
    cursor.execute("""UPDATE dispatch_candidates SET response_status = 'expired', responded_at = CURRENT_TIMESTAMP
                      WHERE order_id = %s AND volunteer_id <> %s AND response_status IN ('waiting', 'invited')""",
                   (order["order_id"], volunteer_id))
    cursor.execute("""UPDATE volunteer_location_state SET availability = 'en_route', return_started_at = NULL,
                      updated_at = CURRENT_TIMESTAMP WHERE volunteer_id = %s""", (volunteer_id,))
    cursor.execute("DELETE FROM volunteer_return_routes WHERE volunteer_id = %s", (volunteer_id,))
    route = _create_route(cursor, order, volunteer_id)
    _ensure_service_conversation(cursor, order, volunteer_id)
    _event(cursor, int(order["order_id"]), "sos_forced_assigned", f"SOS强制派单给最近的技能匹配志愿者，预计{route['eta_minutes']}分钟到达。", {"volunteer_id": volunteer_id})
    return True


def _reset_daily_fatigue(cursor: Any) -> None:
    """Reset the fairness counters once per local calendar day.

    The marker lives in the shared state table, so the reset is performed only
    once even when several users open the board at the same time.
    """
    today = _now().date().isoformat()
    cursor.execute("SELECT state_value FROM dispatch_system_state WHERE state_key = 'fatigue_reset_date'")
    row = cursor.fetchone()
    if row and row["state_value"] == today:
        return
    cursor.execute("UPDATE volunteer_location_state SET fatigue_score = 0, assigned_today = 0, fatigue_updated_at = CURRENT_TIMESTAMP")
    if row:
        cursor.execute("UPDATE dispatch_system_state SET state_value = %s, updated_at = CURRENT_TIMESTAMP WHERE state_key = 'fatigue_reset_date'", (today,))
    else:
        cursor.execute("INSERT INTO dispatch_system_state (state_key, state_value) VALUES ('fatigue_reset_date', %s)", (today,))
    _event(cursor, None, "daily_fatigue_reset", f"{today} 00:00 后疲劳度与今日接单数已自动刷新。")


def _recover_fatigue(cursor: Any) -> None:
    """Restore four fatigue points per completed hour of rest.

    The timer is persisted in the database, so closing a browser cannot pause
    recovery or create a different score in another portal.
    """
    cursor.execute("""SELECT volunteer_id, fatigue_score, fatigue_updated_at
                      FROM volunteer_location_state WHERE fatigue_score > 0""")
    for row in cursor.fetchall():
        updated = row.get("fatigue_updated_at")
        if not isinstance(updated, dt.datetime):
            cursor.execute("UPDATE volunteer_location_state SET fatigue_updated_at = CURRENT_TIMESTAMP WHERE volunteer_id = %s", (row["volunteer_id"],))
            continue
        recovery = int(max(0, (_now() - updated).total_seconds()) // 3600) * 4
        if recovery:
            cursor.execute("""UPDATE volunteer_location_state
                              SET fatigue_score = GREATEST(0, fatigue_score - %s), fatigue_updated_at = CURRENT_TIMESTAMP
                              WHERE volunteer_id = %s""", (recovery, row["volunteer_id"]))


def _record_completed_service_fatigue(cursor: Any, volunteer_id: int, service_hours: float) -> None:
    """One completed hour costs four fatigue points plus a small service base."""
    increment = max(6, min(20, 4 + round(max(.5, service_hours) * 4)))
    cursor.execute("""UPDATE volunteer_location_state
                      SET fatigue_score = LEAST(100, fatigue_score + %s),
                          assigned_today = assigned_today + 1,
                          fatigue_updated_at = CURRENT_TIMESTAMP,
                          updated_at = CURRENT_TIMESTAMP
                      WHERE volunteer_id = %s""", (increment, volunteer_id))


def _advance_active_journeys(cursor: Any) -> None:
    """Advance virtual travel from persisted timestamps, never from a page timer.

    A portal can be closed or switched while a trip continues.  Each backend
    refresh catches the route up to the current wall-clock time, so every role
    observes the same progress instead of restarting from zero on remount.
    """
    cursor.execute("""
        SELECT r.order_id, r.volunteer_id, r.route_json, r.eta_minutes, r.replanned_at
        FROM dispatch_routes r JOIN orders o ON o.order_id = r.order_id
        WHERE o.status = 'accepted'
    """)
    for row in cursor.fetchall():
        last = row.get("replanned_at")
        elapsed = max(0.0, (_now() - last).total_seconds()) if isinstance(last, dt.datetime) else 0.0
        if elapsed < .5:
            continue
        try:
            route = json.loads(row["route_json"])
            path = route.get("path", [])
        except (TypeError, json.JSONDecodeError):
            continue
        if len(path) < 2:
            continue
        previous_progress = float(route.get("progress", 0))
        progress = min(100, previous_progress + elapsed * _route_motion_rate(route))
        if previous_progress >= 100:
            # The marker has already reached the road endpoint.  Keep the
            # route alive briefly so all clients can render that final point
            # before the shared service state changes.
            if not _arrival_visual_ready(route):
                cursor.execute("UPDATE dispatch_routes SET route_json = %s, replanned_at = CURRENT_TIMESTAMP WHERE order_id = %s",
                               (json.dumps(route, ensure_ascii=False), row["order_id"]))
                continue
            progress = 100
        elif progress <= previous_progress:
            continue
        lng, lat = _point_on_route(path, progress / 100)
        route["progress"] = round(progress, 2)
        if progress >= 100 and not _arrival_visual_ready(route):
            # Do not replace the vehicle with the service marker yet.  This
            # route remains at exactly 100% for the animation grace interval.
            cursor.execute("""UPDATE volunteer_location_state SET lng = %s, lat = %s, availability = 'en_route',
                              location_source = 'virtual', updated_at = CURRENT_TIMESTAMP WHERE volunteer_id = %s""",
                           (lng, lat, row["volunteer_id"]))
            cursor.execute("""UPDATE dispatch_routes SET route_json = %s, eta_minutes = 0, replanned_at = CURRENT_TIMESTAMP
                              WHERE order_id = %s""", (json.dumps(route, ensure_ascii=False), row["order_id"]))
            continue
        cursor.execute("""UPDATE volunteer_location_state SET lng = %s, lat = %s, availability = %s,
                          location_source = 'virtual', updated_at = CURRENT_TIMESTAMP WHERE volunteer_id = %s""",
                       (lng, lat, "serving" if progress >= 100 else "en_route", row["volunteer_id"]))
        cursor.execute("""UPDATE dispatch_routes SET route_json = %s, eta_minutes = %s, replanned_at = CURRENT_TIMESTAMP
                          WHERE order_id = %s""",
                       (json.dumps(route, ensure_ascii=False), max(1, round(int(row["eta_minutes"]) * (100 - progress) / 100)), row["order_id"]))
        if progress >= 100:
            cursor.execute("UPDATE orders SET status = 'in_progress' WHERE order_id = %s", (row["order_id"],))
            cursor.execute("UPDATE dispatch_orders SET dispatch_state = 'serving' WHERE order_id = %s", (row["order_id"],))
            # Keep a non-moving route snapshot while service is in progress.
            # It preserves the green/yellow/red road context for elder,
            # family, volunteer and admin, but progress > 100 tells the map
            # to render the normal serving marker at the elder's address
            # rather than another moving vehicle marker.
            route["progress"] = 101
            route["journey_type"] = "serving"
            cursor.execute("""UPDATE dispatch_routes SET route_json = %s, eta_minutes = 0,
                              replanned_at = CURRENT_TIMESTAMP WHERE order_id = %s""",
                           (json.dumps(route, ensure_ascii=False), row["order_id"]))
            _event(cursor, int(row["order_id"]), "journey_arrived", "按统一服务时间线已到达老人服务点，进入服务中。", {"volunteer_id": int(row["volunteer_id"])})

    cursor.execute("SELECT volunteer_id, route_json, eta_minutes, updated_at FROM volunteer_return_routes")
    for row in cursor.fetchall():
        last = row.get("updated_at")
        elapsed = max(0.0, (_now() - last).total_seconds()) if isinstance(last, dt.datetime) else 0.0
        if elapsed < .5:
            continue
        try:
            route = json.loads(row["route_json"])
            path = route.get("path", [])
        except (TypeError, json.JSONDecodeError):
            continue
        if len(path) < 2:
            continue
        previous_progress = float(route.get("progress", 0))
        progress = min(100, previous_progress + elapsed * _route_motion_rate(route, RETURN_PROGRESS_PER_SECOND))
        lng, lat = _point_on_route(path, progress / 100)
        if progress >= 100 and not _arrival_visual_ready(route):
            # Retain the purple return route at its endpoint for one shared
            # visual interval.  Otherwise the marker disappears and the home
            # marker is drawn in the same refresh, which looks like a jump.
            route["progress"] = 100
            cursor.execute("""UPDATE volunteer_return_routes SET route_json = %s, eta_minutes = 0, updated_at = CURRENT_TIMESTAMP
                              WHERE volunteer_id = %s""", (json.dumps(route, ensure_ascii=False), row["volunteer_id"]))
            cursor.execute("""UPDATE volunteer_location_state SET lng = %s, lat = %s, availability = 'returning',
                              location_source = 'virtual', updated_at = CURRENT_TIMESTAMP WHERE volunteer_id = %s""",
                           (lng, lat, row["volunteer_id"]))
            continue
        if progress >= 100:
            cursor.execute("DELETE FROM volunteer_return_routes WHERE volunteer_id = %s", (row["volunteer_id"],))
            cursor.execute("""UPDATE volunteer_location_state SET lng = %s, lat = %s, availability = 'idle', return_started_at = NULL,
                              location_source = 'virtual', updated_at = CURRENT_TIMESTAMP WHERE volunteer_id = %s""",
                           (lng, lat, row["volunteer_id"]))
        else:
            route["progress"] = round(progress, 2)
            cursor.execute("""UPDATE volunteer_return_routes SET route_json = %s, eta_minutes = %s, updated_at = CURRENT_TIMESTAMP
                              WHERE volunteer_id = %s""",
                           (json.dumps(route, ensure_ascii=False), max(1, round(int(row["eta_minutes"]) * (100 - progress) / 100)), row["volunteer_id"]))
            cursor.execute("""UPDATE volunteer_location_state SET lng = %s, lat = %s, availability = 'returning',
                              location_source = 'virtual', updated_at = CURRENT_TIMESTAMP WHERE volunteer_id = %s""",
                           (lng, lat, row["volunteer_id"]))

    # Legacy task-hall completion can leave a volunteer in ``en_route`` or
    # ``serving`` without an active order and without a return route.  Repair
    # that state once here so every completion eventually follows the same
    # return-home timeline.
    cursor.execute("""
        SELECT p.volunteer_id FROM volunteer_location_state p
        WHERE p.availability IN ('en_route', 'serving')
          AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.volunteer_id = p.volunteer_id
                          AND o.status IN ('accepted', 'in_progress'))
          AND NOT EXISTS (SELECT 1 FROM volunteer_return_routes rr WHERE rr.volunteer_id = p.volunteer_id)
    """)
    for row in cursor.fetchall():
        volunteer_id = int(row["volunteer_id"])
        route = _create_return_route(cursor, volunteer_id)
        cursor.execute("UPDATE volunteer_location_state SET availability = %s WHERE volunteer_id = %s",
                       ("returning" if route else "idle", volunteer_id))
        _event(cursor, None, "orphaned_journey_repaired", "检测到已完成服务的志愿者，已自动恢复返家路线。", {"volunteer_id": volunteer_id})


def _advance_dispatch_unthrottled(cursor: Any) -> None:
    _reset_daily_fatigue(cursor)
    _recover_fatigue(cursor)
    _advance_active_journeys(cursor)
    cursor.execute("""
        SELECT d.order_id FROM dispatch_orders d JOIN orders o ON o.order_id = d.order_id
        WHERE o.status = 'pending' AND d.dispatch_state IN ('matching', 'waiting_response', 'queued_waiting_capacity')
    """)
    for row in cursor.fetchall():
        order = _order_context(cursor, int(row["order_id"]))
        if not order:
            continue
        if order["urgency"] == "sos":
            _force_assign_sos(cursor, order)
            continue
        current_phase = str(order.get("dispatch_phase") or "top1")
        # A request advances from the persisted phase timer, never from its
        # database creation timestamp.  This prevents an old or restored
        # record from skipping the mandatory Top1 eight-second protection
        # window and jumping straight to automatic fallback.
        if current_phase == "fallback":
            _upsert_candidates(cursor, order)
            if _try_auto_accept(cursor, order):
                _event(cursor, int(order["order_id"]), "fallback_auto_assigned", "等到可用自动接单志愿者后，系统已完成兜底派单。")
            else:
                # Keep inviting eligible volunteers so the order does not become
                # a ghost recommendation that only the elder can see.
                _invite_candidates(cursor, order, "兜底等待中：继续向技能匹配志愿者开放人工抢单")
                if order.get("dispatch_state") != "queued_waiting_capacity":
                    cursor.execute("UPDATE dispatch_orders SET dispatch_state = 'queued_waiting_capacity' WHERE order_id = %s", (order["order_id"],))
                    _event(cursor, int(order["order_id"]), "fallback_waiting_capacity", "自动兜底暂未找到空闲且技能匹配的自动接单志愿者，订单继续排队等待容量释放，并保持人工可抢。")
            continue
        expires_at = order.get("phase_expires_at")
        if not isinstance(expires_at, dt.datetime):
            _set_dispatch_phase(cursor, order, "top1")
            _upsert_candidates(cursor, order)
            _invite_candidates(cursor, order, "补齐Top1专属确认计时")
            continue
        if _now() < expires_at:
            # Keep ranking tied to live volunteer coordinates (and the elder's
            # current pin), not the snapshot from when the order was created.
            _upsert_candidates(cursor, order)
            _invite_candidates(cursor, order, "按实时位置刷新本阶段候选")
            continue
        desired_phase = {"top1": "top3", "top3": "top10", "top10": "fallback"}.get(current_phase, "top1")
        _set_dispatch_phase(cursor, order, desired_phase)
        # Phase change: clear the previous invite set, then rebuild from the
        # latest positions before opening the next manual window.
        cursor.execute("""UPDATE dispatch_candidates SET response_status = 'waiting', invited_at = NULL
                          WHERE order_id = %s AND response_status = 'invited'""", (order["order_id"],))
        _upsert_candidates(cursor, order)
        if desired_phase == "fallback":
            if _try_auto_accept(cursor, order):
                _event(cursor, int(order["order_id"]), "fallback_auto_assigned", "35秒手动窗口结束，已自动兜底派单给最优已开启自动接单的志愿者。")
            else:
                _invite_candidates(cursor, order, "35秒窗口结束：无自动接单志愿者，改为开放人工抢单")
                cursor.execute("UPDATE dispatch_orders SET dispatch_state = 'queued_waiting_capacity' WHERE order_id = %s", (order["order_id"],))
                _event(cursor, int(order["order_id"]), "fallback_waiting_capacity", "35秒手动窗口结束，暂无空闲自动接单志愿者；订单保留在容量等待队列，并继续向匹配志愿者开放抢单。")
        else:
            _invite_candidates(cursor, order, "8秒专属窗口结束" if desired_phase == "top3" else "Top3窗口结束，扩大至Top10")


def advance_dispatch(cursor: Any) -> None:
    """Refresh shared matching at most once for concurrent portal polling."""
    global _last_advance_at
    now = time.monotonic()
    if now - _last_advance_at < DISPATCH_ADVANCE_COOLDOWN_SECONDS:
        return
    if not _advance_lock.acquire(blocking=False):
        return
    try:
        if time.monotonic() - _last_advance_at < DISPATCH_ADVANCE_COOLDOWN_SECONDS:
            return
        _last_advance_at = time.monotonic()
        _advance_dispatch_unthrottled(cursor)
    finally:
        _advance_lock.release()


def run_dispatch_clock_tick() -> None:
    """Advance the shared location clock without an HTTP request.

    This is the simulated equivalent of a production GPS ingestion worker:
    routes, current coordinates and dispatch phases remain live even if every
    map page is closed or users switch accounts.
    """
    conn = get_db_connection()
    if not conn:
        return
    try:
        with conn.cursor() as cursor:
            advance_dispatch(cursor)
        conn.commit()
    except Exception:
        conn.rollback()
    finally:
        conn.close()


def _admin_active_region(cursor: Any, user_id: int | None, requested_region: str | None = None) -> str:
    if not user_id:
        return _fallback_open_region()
    cursor.execute("SELECT region_adcode FROM admin_region_scope WHERE admin_user_id = %s ORDER BY region_adcode", (user_id,))
    scopes = [str(row["region_adcode"]) for row in cursor.fetchall()]
    if "*" in scopes:
        return requested_region if requested_region in REGION_CATALOG else _fallback_open_region()
    if requested_region in scopes and requested_region in REGION_CATALOG:
        return str(requested_region)
    return next((scope for scope in scopes if scope in REGION_CATALOG), _fallback_open_region())


def _admin_can_manage_region(cursor: Any, admin_user_id: int, region_adcode: str) -> bool:
    cursor.execute("""SELECT 1 FROM admin_region_scope
                      WHERE admin_user_id = %s AND region_adcode IN (%s, '*')
                      AND permission IN ('manage', 'overview')""", (admin_user_id, region_adcode))
    return bool(cursor.fetchone())


@dispatch_bp.route("/admin/regions", methods=["GET"])
def admin_regions():
    """Return only the districts an administrator may operate."""
    admin_user_id = request.args.get("admin_user_id", type=int)
    if not admin_user_id:
        return jsonify({"code": 400, "message": "missing administrator id"}), 400
    conn = get_db_connection()
    if not conn:
        return jsonify({"code": 500, "message": "database unavailable"}), 500
    try:
        with conn.cursor() as cursor:
            cursor.execute("SELECT region_adcode FROM admin_region_scope WHERE admin_user_id = %s", (admin_user_id,))
            scopes = {str(row["region_adcode"]) for row in cursor.fetchall()}
            codes = list(REGION_CATALOG) if "*" in scopes else [code for code in REGION_CATALOG if code in scopes]
            data = [{"adcode": code, "name": REGION_CATALOG[code]["name"]} for code in codes]
            return jsonify({"code": 200, "message": "ok", "data": data})
    finally:
        conn.close()


@dispatch_bp.route("/admin/region-catalog/children", methods=["GET"])
def admin_region_catalog_children():
    """Cascade picker: province / city / district children from AMap."""
    admin_user_id = request.args.get("admin_user_id", type=int)
    keywords = (request.args.get("keywords") or "中华人民共和国").strip()
    if not admin_user_id:
        return jsonify({"code": 400, "message": "缺少管理员 id"}), 400
    conn = get_db_connection()
    if not conn:
        return jsonify({"code": 500, "message": "database unavailable"}), 500
    try:
        with conn.cursor() as cursor:
            if not admin_is_root(cursor, admin_user_id):
                return jsonify({"code": 403, "message": "仅总管理员可浏览全国区划目录"}), 403
        children = fetch_district_children(keywords, subdistrict=1)
        return jsonify({"code": 200, "message": "ok", "data": children})
    except Exception as exc:  # noqa: BLE001
        return jsonify({"code": 500, "message": str(exc)}), 500
    finally:
        conn.close()


@dispatch_bp.route("/admin/regions/managed", methods=["GET"])
def admin_regions_managed():
    """List all stored regions for root admin management."""
    admin_user_id = request.args.get("admin_user_id", type=int)
    if not admin_user_id:
        return jsonify({"code": 400, "message": "缺少管理员 id"}), 400
    conn = get_db_connection()
    if not conn:
        return jsonify({"code": 500, "message": "database unavailable"}), 500
    try:
        with conn.cursor() as cursor:
            if not admin_is_root(cursor, admin_user_id):
                return jsonify({"code": 403, "message": "仅总管理员可管理区域"}), 403
            ensure_region_columns(cursor)
            cursor.execute(
                """SELECT adcode, name, city_name, province_name, region_level, active,
                          center_lng, center_lat,
                          CASE WHEN polygon_json IS NULL OR polygon_json = '' OR polygon_json = '[]'
                               THEN FALSE ELSE TRUE END AS has_polygon
                   FROM administrative_regions ORDER BY adcode"""
            )
            rows = cursor.fetchall()
            cursor.execute(
                """SELECT s.region_adcode, u.user_id, u.username, u.real_name
                   FROM admin_region_scope s
                   JOIN users u ON u.user_id = s.admin_user_id
                   WHERE s.region_adcode <> '*' AND s.permission IN ('manage', 'overview')
                   ORDER BY s.region_adcode, u.user_id"""
            )
            managers_by_region: dict[str, list[dict[str, Any]]] = {}
            for row in cursor.fetchall():
                managers_by_region.setdefault(str(row["region_adcode"]), []).append({
                    "user_id": int(row["user_id"]),
                    "username": row["username"],
                    "real_name": row["real_name"],
                })
            data = []
            for row in rows:
                adcode = str(row["adcode"])
                data.append({
                    "adcode": adcode,
                    "name": row["name"],
                    "city_name": row.get("city_name"),
                    "province_name": row.get("province_name") or "",
                    "region_level": row.get("region_level"),
                    "active": bool(row.get("active")),
                    "has_polygon": bool(row.get("has_polygon")),
                    "center_lng": float(row["center_lng"]) if row.get("center_lng") is not None else None,
                    "center_lat": float(row["center_lat"]) if row.get("center_lat") is not None else None,
                    "managers": managers_by_region.get(adcode, []),
                })
            return jsonify({"code": 200, "message": "ok", "data": data})
    finally:
        conn.close()


@dispatch_bp.route("/admin/candidate-managers", methods=["GET"])
def admin_candidate_managers():
    """List district-capable admin accounts for binding to a region."""
    admin_user_id = request.args.get("admin_user_id", type=int)
    if not admin_user_id:
        return jsonify({"code": 400, "message": "缺少管理员 id"}), 400
    conn = get_db_connection()
    if not conn:
        return jsonify({"code": 500, "message": "database unavailable"}), 500
    try:
        with conn.cursor() as cursor:
            if not admin_is_root(cursor, admin_user_id):
                return jsonify({"code": 403, "message": "仅总管理员可查看区管理员候选"}), 403
            cursor.execute(
                """SELECT u.user_id, u.username, u.real_name,
                          COALESCE(string_agg(s.region_adcode, ','), '') AS scopes
                   FROM users u
                   LEFT JOIN admin_region_scope s ON s.admin_user_id = u.user_id
                   WHERE u.role = 'admin'
                   GROUP BY u.user_id, u.username, u.real_name
                   ORDER BY u.user_id"""
            )
            data = []
            for row in cursor.fetchall():
                scopes = [code for code in str(row["scopes"] or "").split(",") if code]
                if "*" in scopes:
                    continue
                data.append({
                    "user_id": int(row["user_id"]),
                    "username": row["username"],
                    "real_name": row["real_name"],
                    "region_adcodes": scopes,
                })
            return jsonify({"code": 200, "message": "ok", "data": data})
    finally:
        conn.close()


@dispatch_bp.route("/admin/regions", methods=["POST"])
def admin_regions_create():
    """Root admin opens a district, pulls official polygon, and binds a district admin."""
    global MAP_BOUNDS
    data = request.get_json(silent=True) or {}
    admin_user_id = data.get("admin_user_id")
    adcode = str(data.get("adcode") or "").strip()
    province_name = str(data.get("province_name") or "").strip()
    city_name = str(data.get("city_name") or "").strip()
    manager_user_id = data.get("manager_user_id")
    district_admin = data.get("district_admin") if isinstance(data.get("district_admin"), dict) else None
    if not admin_user_id or not adcode:
        return jsonify({"code": 400, "message": "请提供 admin_user_id 与区县 adcode"}), 400
    if not manager_user_id and not district_admin:
        return jsonify({"code": 400, "message": "开通区县时必须绑定区管理员（已有账号或新建）"}), 400
    conn = get_db_connection()
    if not conn:
        return jsonify({"code": 500, "message": "database unavailable"}), 500
    try:
        with conn.cursor() as cursor:
            if not admin_is_root(cursor, int(admin_user_id)):
                return jsonify({"code": 403, "message": "仅总管理员可添加区域"}), 403
            detail = fetch_district_detail(adcode)
            level = detail.get("level") or ""
            if level not in ("district", "biz_area"):
                # Some municipalities return district under city search; still accept district-level adcodes ending pattern.
                if len(adcode) != 6:
                    return jsonify({"code": 400, "message": f"请选择区县级行政区（当前级别：{level or '未知'}）"}), 400
            upsert_region(
                cursor,
                adcode=detail["adcode"],
                name=detail["name"],
                city_name=city_name or detail.get("city_name") or detail["name"],
                province_name=province_name or detail.get("province_name") or "",
                region_level="district",
                bounds=detail["bounds"],
                center=detail["center"],
                polygons=detail["polygons"],
                active=True,
            )
            manager = _create_or_bind_district_admin(
                cursor,
                detail["adcode"],
                manager_user_id=int(manager_user_id) if manager_user_id else None,
                district_admin=district_admin,
            )
            conn.commit()
        refresh_runtime_catalog(REGION_CATALOG, conn)
        if DEFAULT_REGION_ADCODE in REGION_CATALOG:
            MAP_BOUNDS = REGION_CATALOG[DEFAULT_REGION_ADCODE]["bounds"]
        elif detail["adcode"] in REGION_CATALOG:
            MAP_BOUNDS = REGION_CATALOG[detail["adcode"]]["bounds"]
        return jsonify({
            "code": 200,
            "message": f"已开通区域 {detail['name']}，并绑定区管理员 {manager['real_name']}",
            "data": {
                "adcode": detail["adcode"],
                "name": detail["name"],
                "polygon_rings": len(detail["polygons"]),
                "manager": manager,
            },
        })
    except ValueError as exc:
        conn.rollback()
        return jsonify({"code": 400, "message": str(exc)}), 400
    except Exception as exc:  # noqa: BLE001
        conn.rollback()
        return jsonify({"code": 500, "message": str(exc)}), 500
    finally:
        conn.close()


@dispatch_bp.route("/admin/regions/<adcode>/managers", methods=["POST"])
def admin_regions_bind_manager(adcode: str):
    """Bind an additional district admin to an already opened region."""
    data = request.get_json(silent=True) or {}
    admin_user_id = data.get("admin_user_id")
    manager_user_id = data.get("manager_user_id")
    district_admin = data.get("district_admin") if isinstance(data.get("district_admin"), dict) else None
    if not admin_user_id:
        return jsonify({"code": 400, "message": "缺少 admin_user_id"}), 400
    if not manager_user_id and not district_admin:
        return jsonify({"code": 400, "message": "请指定已有管理员或新建区管理员"}), 400
    conn = get_db_connection()
    if not conn:
        return jsonify({"code": 500, "message": "database unavailable"}), 500
    try:
        with conn.cursor() as cursor:
            if not admin_is_root(cursor, int(admin_user_id)):
                return jsonify({"code": 403, "message": "仅总管理员可绑定区管理员"}), 403
            cursor.execute("SELECT adcode, name, active FROM administrative_regions WHERE adcode = %s", (adcode,))
            row = cursor.fetchone()
            if not row:
                return jsonify({"code": 404, "message": "区域不存在，请先开通"}), 404
            if not row.get("active"):
                return jsonify({"code": 409, "message": "区域已停用，请先启用再绑定管理员"}), 409
            manager = _create_or_bind_district_admin(
                cursor,
                adcode,
                manager_user_id=int(manager_user_id) if manager_user_id else None,
                district_admin=district_admin,
            )
            conn.commit()
            return jsonify({
                "code": 200,
                "message": f"已为 {row['name']} 绑定区管理员 {manager['real_name']}",
                "data": {"adcode": adcode, "manager": manager},
            })
    except ValueError as exc:
        conn.rollback()
        return jsonify({"code": 400, "message": str(exc)}), 400
    except Exception as exc:  # noqa: BLE001
        conn.rollback()
        return jsonify({"code": 500, "message": str(exc)}), 500
    finally:
        conn.close()


@dispatch_bp.route("/admin/regions/<adcode>/managers/<int:manager_user_id>", methods=["DELETE"])
def admin_regions_unbind_manager(adcode: str, manager_user_id: int):
    """Root admin removes a district-admin binding from one opened region."""
    admin_user_id = request.args.get("admin_user_id", type=int)
    if not admin_user_id:
        data = request.get_json(silent=True) or {}
        try:
            admin_user_id = int(data.get("admin_user_id"))
        except (TypeError, ValueError):
            admin_user_id = None
    if not admin_user_id:
        return jsonify({"code": 400, "message": "缺少 admin_user_id"}), 400
    conn = get_db_connection()
    if not conn:
        return jsonify({"code": 500, "message": "database unavailable"}), 500
    try:
        with conn.cursor() as cursor:
            if not admin_is_root(cursor, int(admin_user_id)):
                return jsonify({"code": 403, "message": "仅总管理员可解绑区管理员"}), 403
            cursor.execute("SELECT adcode, name FROM administrative_regions WHERE adcode = %s", (adcode,))
            region = cursor.fetchone()
            if not region:
                return jsonify({"code": 404, "message": "区域不存在"}), 404
            cursor.execute(
                """SELECT u.user_id, u.username, u.real_name, s.region_adcode
                   FROM admin_region_scope s
                   JOIN users u ON u.user_id = s.admin_user_id
                   WHERE s.admin_user_id = %s AND s.region_adcode = %s""",
                (manager_user_id, adcode),
            )
            binding = cursor.fetchone()
            if not binding:
                return jsonify({"code": 404, "message": "该管理员未绑定此区县"}), 404
            if str(binding["region_adcode"]) == "*":
                return jsonify({"code": 403, "message": "不能解绑总管理员全国权限"}), 403
            cursor.execute(
                "DELETE FROM admin_region_scope WHERE admin_user_id = %s AND region_adcode = %s",
                (manager_user_id, adcode),
            )
            conn.commit()
            return jsonify({
                "code": 200,
                "message": f"已从 {region['name']} 解绑区管理员 {binding['real_name']}",
                "data": {
                    "adcode": adcode,
                    "manager": {
                        "user_id": int(binding["user_id"]),
                        "username": binding["username"],
                        "real_name": binding["real_name"],
                    },
                },
            })
    except Exception as exc:  # noqa: BLE001
        conn.rollback()
        return jsonify({"code": 500, "message": str(exc)}), 500
    finally:
        conn.close()


@dispatch_bp.route("/admin/regions/<adcode>", methods=["PATCH"])
def admin_regions_patch(adcode: str):
    """Enable/disable a region, or refresh official polygon from AMap."""
    global MAP_BOUNDS
    data = request.get_json(silent=True) or {}
    admin_user_id = data.get("admin_user_id")
    if not admin_user_id:
        return jsonify({"code": 400, "message": "缺少 admin_user_id"}), 400
    conn = get_db_connection()
    if not conn:
        return jsonify({"code": 500, "message": "database unavailable"}), 500
    try:
        with conn.cursor() as cursor:
            if not admin_is_root(cursor, int(admin_user_id)):
                return jsonify({"code": 403, "message": "仅总管理员可修改区域"}), 403
            cursor.execute("SELECT adcode, name FROM administrative_regions WHERE adcode = %s", (adcode,))
            row = cursor.fetchone()
            if not row:
                return jsonify({"code": 404, "message": "区域不存在"}), 404
            if data.get("refresh_polygon"):
                detail = fetch_district_detail(adcode)
                upsert_region(
                    cursor,
                    adcode=detail["adcode"],
                    name=detail["name"] or row["name"],
                    city_name=detail.get("city_name") or detail["name"],
                    province_name=detail.get("province_name") or "",
                    region_level="district",
                    bounds=detail["bounds"],
                    center=detail["center"],
                    polygons=detail["polygons"],
                    active=True,
                )
            if "active" in data:
                cursor.execute(
                    "UPDATE administrative_regions SET active = %s WHERE adcode = %s",
                    (bool(data.get("active")), adcode),
                )
            conn.commit()
        refresh_runtime_catalog(REGION_CATALOG, conn)
        if DEFAULT_REGION_ADCODE in REGION_CATALOG:
            MAP_BOUNDS = REGION_CATALOG[DEFAULT_REGION_ADCODE]["bounds"]
        return jsonify({"code": 200, "message": "区域已更新"})
    except Exception as exc:  # noqa: BLE001
        conn.rollback()
        return jsonify({"code": 500, "message": str(exc)}), 500
    finally:
        conn.close()


def _overview(cursor: Any, user_id: int | None = None, requested_region: str | None = None) -> dict[str, Any]:
    advance_dispatch(cursor)
    version = _traffic_version(cursor)
    region_adcode = _admin_active_region(cursor, user_id, requested_region)
    cursor.execute("""
        SELECT p.volunteer_id, u.real_name, p.lng, p.lat, p.availability, p.fatigue_score,
               p.service_rating, p.assigned_today, p.auto_accept_enabled,
               COALESCE(string_agg(s.skill_tag, '|'), '') AS skills_text
        FROM volunteer_location_state p JOIN users u ON u.user_id = p.volunteer_id
        LEFT JOIN volunteer_skill_tags s ON s.volunteer_id = p.volunteer_id
        WHERE p.availability <> 'offline' AND p.service_region_adcode = %s
        GROUP BY p.volunteer_id, u.real_name, p.lng, p.lat, p.availability, p.fatigue_score, p.service_rating, p.assigned_today, p.auto_accept_enabled
        ORDER BY p.volunteer_id
    """, (region_adcode,))
    volunteers = [{
        "volunteer_id": int(row["volunteer_id"]), "name": row["real_name"], "lng": float(row["lng"]), "lat": float(row["lat"]),
        "availability": row["availability"], "fatigue": int(row["fatigue_score"]), "rating": float(row["service_rating"]),
        "assigned_today": int(row["assigned_today"]), "auto_accept_enabled": bool(row["auto_accept_enabled"]), "skills": [tag for tag in str(row.get("skills_text") or "").split("|") if tag],
    } for row in cursor.fetchall()]
    cursor.execute("""
        SELECT e.elder_id, e.name, l.lng, l.lat FROM elder_location_state l
        JOIN elders e ON e.elder_id = l.elder_id
        WHERE l.location_source <> 'hidden_demo' AND e.region_adcode = %s ORDER BY e.elder_id LIMIT 25
    """, (region_adcode,))
    elders = [{"elder_id": int(row["elder_id"]), "name": row["name"], "lng": float(row["lng"]), "lat": float(row["lat"])} for row in cursor.fetchall()]
    cursor.execute("""
        SELECT o.order_id, o.service_type, o.status, o.volunteer_id, o.notes, v.real_name AS volunteer_name, e.name AS elder_name,
               d.urgency, d.dispatch_state, d.search_stage, d.dispatch_phase, d.phase_expires_at,
               d.dispatch_version, d.forced_assignment, d.created_at,
               l.lng, l.lat
        FROM dispatch_orders d JOIN orders o ON o.order_id = d.order_id
        JOIN elders e ON e.elder_id = o.elder_id JOIN elder_location_state l ON l.elder_id = e.elder_id
        LEFT JOIN users v ON v.user_id = o.volunteer_id
        WHERE o.status IN ('pending', 'accepted', 'in_progress') AND o.region_adcode = %s
        ORDER BY d.created_at DESC LIMIT 30
    """, (region_adcode,))
    orders = [{
        "order_id": int(row["order_id"]), "service_type": row["service_type"], "status": row["status"],
        "volunteer_id": int(row["volunteer_id"]) if row["volunteer_id"] else None, "volunteer_name": row["volunteer_name"], "elder_name": row["elder_name"],
        "urgency": row["urgency"], "dispatch_state": row["dispatch_state"], "search_stage": int(row["search_stage"]),
        "dispatch_phase": row["dispatch_phase"], "phase_expires_at": _iso(row["phase_expires_at"]), "dispatch_version": int(row["dispatch_version"]),
        "forced_assignment": bool(row["forced_assignment"]), "created_at": _iso(row["created_at"]),
        "is_simulated": "沙盘" in str(row.get("notes") or ""),
        "lng": float(row["lng"]), "lat": float(row["lat"]),
    } for row in cursor.fetchall()]
    cursor.execute("""SELECT r.order_id, r.volunteer_id, r.route_json, r.eta_minutes, r.traffic_version, r.replanned_at
                      FROM dispatch_routes r JOIN orders o ON o.order_id = r.order_id
                      WHERE o.status IN ('accepted', 'in_progress') AND o.region_adcode = %s
                      ORDER BY r.replanned_at DESC LIMIT 20""", (region_adcode,))
    routes = []
    for row in cursor.fetchall():
        try:
            route = json.loads(row["route_json"])
        except (TypeError, json.JSONDecodeError):
            route = {"path": []}
        routes.append({"order_id": int(row["order_id"]), "volunteer_id": int(row["volunteer_id"]), "eta_minutes": int(row["eta_minutes"]), "traffic_version": int(row["traffic_version"]), "replanned_at": _iso(row["replanned_at"]), "motion_rate": _route_motion_rate(route), **route})
    # Return journeys are part of the real command map too.  Previously only
    # the volunteer portal received them, which made the commander view look
    # as if a completed volunteer had teleported home.
    cursor.execute("""SELECT r.volunteer_id, r.route_json, r.eta_minutes, r.traffic_version, r.updated_at
                      FROM volunteer_return_routes r JOIN volunteer_location_state p ON p.volunteer_id = r.volunteer_id
                      WHERE p.service_region_adcode = %s ORDER BY r.updated_at DESC LIMIT 20""", (region_adcode,))
    for row in cursor.fetchall():
        try:
            route = json.loads(row["route_json"])
        except (TypeError, json.JSONDecodeError):
            route = {"path": []}
        routes.append({"order_id": -int(row["volunteer_id"]), "volunteer_id": int(row["volunteer_id"]),
                       "eta_minutes": int(row["eta_minutes"]), "traffic_version": int(row["traffic_version"]),
                       "replanned_at": _iso(row["updated_at"]), "motion_rate": _route_motion_rate(route, RETURN_PROGRESS_PER_SECOND),
                       **route})
    routes_by_order = {int(route["order_id"]): route for route in routes}
    for order in orders:
        order["route"] = routes_by_order.get(int(order["order_id"]))
    cursor.execute("""
        SELECT c.order_id, c.volunteer_id, u.real_name AS volunteer_name, c.eligible, c.skill_match,
               c.distance_km, c.eta_minutes, c.total_score, c.candidate_rank, c.response_status,
               o.service_type, d.search_stage
        FROM dispatch_candidates c JOIN users u ON u.user_id = c.volunteer_id
        JOIN volunteer_location_state p ON p.volunteer_id = c.volunteer_id
        JOIN orders o ON o.order_id = c.order_id JOIN dispatch_orders d ON d.order_id = o.order_id
        WHERE o.status = 'pending' AND o.region_adcode = %s AND c.eligible = TRUE AND p.availability IN ('idle', 'returning')
          AND NOT EXISTS (SELECT 1 FROM orders active WHERE active.volunteer_id = c.volunteer_id
                          AND active.status IN ('accepted', 'in_progress'))
        ORDER BY c.order_id DESC, c.candidate_rank NULLS LAST LIMIT 80
    """, (region_adcode,))
    candidates = [{
        "order_id": int(row["order_id"]), "volunteer_id": int(row["volunteer_id"]), "volunteer_name": row["volunteer_name"],
        "eligible": bool(row["eligible"]), "skill_match": row["skill_match"], "distance_km": float(row["distance_km"]) if row["distance_km"] is not None else None,
        "eta_minutes": int(row["eta_minutes"]) if row["eta_minutes"] is not None else None,
        "total_score": float(row["total_score"]) if row["total_score"] is not None else None,
        "candidate_rank": int(row["candidate_rank"]) if row["candidate_rank"] is not None else None,
        "response_status": row["response_status"], "service_type": row["service_type"], "search_stage": int(row["search_stage"]),
    } for row in cursor.fetchall()]
    cursor.execute("""SELECT ev.event_id, ev.order_id, ev.event_type, ev.message, ev.created_at
                      FROM dispatch_events ev LEFT JOIN orders o ON o.order_id = ev.order_id
                      WHERE ev.order_id IS NULL OR o.region_adcode = %s
                      ORDER BY ev.event_id DESC LIMIT 30""", (region_adcode,))
    events = [{"event_id": int(row["event_id"]), "order_id": int(row["order_id"]) if row["order_id"] else None, "event_type": row["event_type"], "message": row["message"], "created_at": _iso(row["created_at"])} for row in cursor.fetchall()]
    cursor.execute("""SELECT o.status, d.dispatch_state, COUNT(*) AS count FROM dispatch_orders d JOIN orders o ON o.order_id = d.order_id
                      WHERE o.region_adcode = %s GROUP BY o.status, d.dispatch_state""", (region_adcode,))
    summary = {"pending": 0, "assigned": 0, "sos": 0, "admin_watch": 0, "idle_volunteers": sum(1 for v in volunteers if v["availability"] == "idle")}
    for row in cursor.fetchall():
        count = int(row["count"])
        if row["status"] == "pending": summary["pending"] += count
        if row["status"] in ("accepted", "in_progress"): summary["assigned"] += count
        if row["dispatch_state"] in ("admin_escalated", "queued_waiting_capacity") or row["dispatch_state"] == "matching" and row["status"] == "pending": summary["admin_watch"] += count
    summary["sos"] = sum(1 for order in orders if order["urgency"] == "sos")
    return {"bounds": _region_bounds(region_adcode), "region_adcode": region_adcode,
            "region_name": REGION_CATALOG[region_adcode]["name"], "grid_size": 1, "traffic_version": version, "traffic_cells": [],
            "volunteers": volunteers, "elders": elders, "orders": orders, "routes": routes, "candidates": candidates, "events": events,
            "summary": summary, "service_catalog": [{"code": code, **item, "skill_labels": [SKILL_LABELS[tag] for tag in item["skills"]]} for code, item in SERVICE_CATALOG.items()]}


def _tracking_shell(cursor: Any) -> dict[str, Any]:
    version = _traffic_version(cursor)
    return {
        "bounds": MAP_BOUNDS, "grid_size": 1, "traffic_version": version,
        "traffic_cells": [], "volunteers": [], "elders": [], "orders": [], "routes": [],
        "service_catalog": [{"code": code, **item, "skill_labels": [SKILL_LABELS[tag] for tag in item["skills"]]} for code, item in SERVICE_CATALOG.items()],
    }


def _set_tracking_region(payload: dict[str, Any], region_adcode: str | None) -> None:
    code = str(region_adcode or DEFAULT_REGION_ADCODE)
    if code not in REGION_CATALOG:
        code = DEFAULT_REGION_ADCODE
    payload["bounds"] = _region_bounds(code)
    payload["region_adcode"] = code
    payload["region_name"] = REGION_CATALOG[code]["name"]


def _tracking_payload(cursor: Any, role: str, user_id: int) -> dict[str, Any] | None:
    """Return only the points each portal is entitled to see.

    The dispatch board deliberately uses _overview(), while all user-facing
    tracking calls come through this narrower data path.
    """
    advance_dispatch(cursor)
    if role == "admin":
        return _overview(cursor, user_id)

    payload = _tracking_shell(cursor)
    active_statuses = ("accepted", "in_progress")
    if role == "elder":
        cursor.execute("""
            SELECT e.elder_id, e.name, e.address, e.region_adcode, l.lng, l.lat, l.location_source, l.is_home_fixed
            FROM elders e JOIN elder_location_state l ON l.elder_id = e.elder_id
            WHERE e.user_id = %s
        """, (user_id,))
        elder = cursor.fetchone()
        if not elder:
            return None
        _set_tracking_region(payload, elder.get("region_adcode"))
        payload["elders"] = [{
            "elder_id": int(elder["elder_id"]), "name": elder["name"], "address": elder["address"],
            "lng": float(elder["lng"]), "lat": float(elder["lat"]), "location_source": elder["location_source"],
            "is_home_fixed": bool(elder["is_home_fixed"]),
        }]
        cursor.execute("""
            SELECT o.order_id, o.service_type, o.status, o.volunteer_id, o.address AS order_address,
                   d.urgency, d.dispatch_state, d.search_stage, d.dispatch_phase, d.phase_expires_at, d.forced_assignment,
                   u.real_name AS volunteer_name, p.lng AS volunteer_lng, p.lat AS volunteer_lat, p.availability, p.service_rating,
                   COALESCE((SELECT string_agg(s.skill_tag, '|') FROM volunteer_skill_tags s
                             WHERE s.volunteer_id = o.volunteer_id), '') AS volunteer_skills_text
            FROM orders o JOIN dispatch_orders d ON d.order_id = o.order_id
            LEFT JOIN users u ON u.user_id = o.volunteer_id
            LEFT JOIN volunteer_location_state p ON p.volunteer_id = o.volunteer_id
            WHERE o.elder_id = %s AND o.status != 'cancelled' ORDER BY d.created_at DESC LIMIT 20
        """, (elder["elder_id"],))
        rows = cursor.fetchall()
        for row in rows:
            item = {
                "order_id": int(row["order_id"]), "service_type": row["service_type"], "status": row["status"],
                "volunteer_id": int(row["volunteer_id"]) if row["volunteer_id"] else None,
                "volunteer_name": row["volunteer_name"], "urgency": row["urgency"],
                "volunteer_availability": row["availability"] if row["volunteer_id"] else None,
                "volunteer_rating": float(row["service_rating"]) if row["volunteer_id"] else None,
                "volunteer_skills": [tag for tag in str(row.get("volunteer_skills_text") or "").split("|") if tag],
                "dispatch_state": row["dispatch_state"], "search_stage": int(row["search_stage"]),
                "dispatch_phase": row["dispatch_phase"], "phase_expires_at": _iso(row["phase_expires_at"]),
                "forced_assignment": bool(row["forced_assignment"]), "address": row["order_address"] or elder["address"],
            }
            if row["status"] in active_statuses and row["volunteer_id"]:
                volunteer = {
                    "volunteer_id": int(row["volunteer_id"]), "name": row["volunteer_name"],
                    "lng": float(row["volunteer_lng"]), "lat": float(row["volunteer_lat"]),
                    "availability": row["availability"], "fatigue": 0, "rating": float(row["service_rating"]), "assigned_today": 0,
                    "skills": [tag for tag in str(row.get("volunteer_skills_text") or "").split("|") if tag],
                }
                payload["volunteers"].append(volunteer)
                payload["routes"].extend([route for route in [_route_for_order(cursor, int(row["order_id"]))] if route])
                item["location_sharing_active"] = True
                item["amap_navigation_url"] = _amap_navigation_url(volunteer["lng"], volunteer["lat"], float(elder["lng"]), float(elder["lat"]), f"{elder['name']}服务点")
            elif row["status"] == "completed" and row["volunteer_id"] and row["availability"] == "returning":
                # Completion does not freeze the physical location.  Until the
                # volunteer reaches home, every authorised portal receives the
                # same persisted purple return journey and current coordinate.
                volunteer = {
                    "volunteer_id": int(row["volunteer_id"]), "name": row["volunteer_name"],
                    "lng": float(row["volunteer_lng"]), "lat": float(row["volunteer_lat"]),
                    "availability": "returning", "fatigue": 0, "rating": float(row["service_rating"]), "assigned_today": 0,
                    "skills": [tag for tag in str(row.get("volunteer_skills_text") or "").split("|") if tag],
                }
                payload["volunteers"].append(volunteer)
                payload["routes"].extend([route for route in [_return_route_for_volunteer(cursor, int(row["volunteer_id"]))] if route])
                item["location_sharing_active"] = True
            else:
                item["location_sharing_active"] = False
            payload["orders"].append(item)
        # While a normal request is still pending, show the top skill-matched
        # candidate as a recommendation marker.  This is not an assigned route:
        # the marker stays fixed until someone actually accepts.
        cursor.execute("""
            SELECT c.volunteer_id, u.real_name, p.lng, p.lat, p.availability,
                   p.service_rating, c.response_status,
                   ROW_NUMBER() OVER (PARTITION BY c.order_id ORDER BY c.candidate_rank NULLS LAST, c.total_score DESC) AS rank_no
            FROM dispatch_candidates c
            JOIN orders o ON o.order_id = c.order_id
            JOIN volunteer_location_state p ON p.volunteer_id = c.volunteer_id
            JOIN users u ON u.user_id = c.volunteer_id
            WHERE o.elder_id = %s AND o.status = 'pending' AND c.eligible = TRUE
              AND c.response_status IN ('invited', 'waiting')
        """, (elder["elder_id"],))
        existing_volunteers = {int(item["volunteer_id"]) for item in payload["volunteers"]}
        showing_recommendation = False
        for candidate in cursor.fetchall():
            volunteer_id = int(candidate["volunteer_id"])
            if int(candidate["rank_no"]) != 1 or volunteer_id in existing_volunteers:
                continue
            payload["volunteers"].append({
                "volunteer_id": volunteer_id, "name": candidate["real_name"],
                "lng": float(candidate["lng"]), "lat": float(candidate["lat"]),
                "availability": candidate["availability"], "fatigue": 0,
                "rating": float(candidate["service_rating"]), "assigned_today": 0,
                "skills": [], "is_dispatch_candidate": True,
            })
            existing_volunteers.add(volunteer_id)
            showing_recommendation = True
        if showing_recommendation:
            payload["privacy_message"] = "地图上的志愿者是系统推荐人选（位置为参考，尚未接单，所以不会移动）。对方确认接单后才会显示出发路线。"
        else:
            payload["privacy_message"] = "服务完成后，志愿者实时位置与路线已停止向老人端共享。"
        return payload

    if role == "volunteer":
        cursor.execute("""
            SELECT p.volunteer_id, p.service_region_adcode, u.real_name, p.lng, p.lat, p.availability, p.fatigue_score, p.service_rating,
                   p.assigned_today, p.location_source, p.home_lng, p.home_lat, p.auto_accept_enabled,
                   COALESCE((SELECT string_agg(s.skill_tag, '|') FROM volunteer_skill_tags s
                             WHERE s.volunteer_id = p.volunteer_id), '') AS skills_text
            FROM volunteer_location_state p JOIN users u ON u.user_id = p.volunteer_id
            WHERE p.volunteer_id = %s
        """, (user_id,))
        volunteer = cursor.fetchone()
        if not volunteer:
            return None
        _set_tracking_region(payload, volunteer.get("service_region_adcode"))
        own = {
            "volunteer_id": int(volunteer["volunteer_id"]), "name": volunteer["real_name"], "lng": float(volunteer["lng"]),
            "lat": float(volunteer["lat"]), "availability": volunteer["availability"], "fatigue": int(volunteer["fatigue_score"]),
            "rating": float(volunteer["service_rating"]), "assigned_today": int(volunteer["assigned_today"]),
            "skills": [tag for tag in str(volunteer.get("skills_text") or "").split("|") if tag],
            "location_source": volunteer["location_source"], "home_lng": float(volunteer["home_lng"]) if volunteer["home_lng"] is not None else None,
            "home_lat": float(volunteer["home_lat"]) if volunteer["home_lat"] is not None else None,
            "auto_accept_enabled": bool(volunteer["auto_accept_enabled"]),
        }
        payload["volunteers"] = [own]
        # Tell the volunteer explicitly when a background auto-chain has won
        # an order.  Without this, the assignment existed only as an event in
        # the admin log and looked like the return journey simply stopped.
        cursor.execute("""
            SELECT o.order_id, o.service_type, e.name AS elder_name, o.address,
                   d.urgency, el.lng, el.lat
            FROM orders o JOIN dispatch_orders d ON d.order_id = o.order_id
            JOIN elders e ON e.elder_id = o.elder_id
            JOIN elder_location_state el ON el.elder_id = e.elder_id
            WHERE o.volunteer_id = %s AND o.status IN ('accepted', 'in_progress')
              AND EXISTS (SELECT 1 FROM dispatch_events ev WHERE ev.order_id = o.order_id
                          AND ev.event_type = 'candidate_auto_accepted')
            ORDER BY o.order_id DESC LIMIT 1
        """, (user_id,))
        auto_assignment = cursor.fetchone()
        if auto_assignment:
            payload["auto_assignment"] = {
                "order_id": int(auto_assignment["order_id"]), "service_type": auto_assignment["service_type"],
                "elder_name": auto_assignment["elder_name"], "address": auto_assignment["address"],
                "urgency": auto_assignment["urgency"], "lng": float(auto_assignment["lng"]), "lat": float(auto_assignment["lat"]),
            }
        preview = _next_assignment_preview(cursor, user_id)
        if preview:
            payload["next_assignment_preview"] = preview
        cursor.execute("SELECT route_json, eta_minutes, traffic_version, updated_at FROM volunteer_return_routes WHERE volunteer_id = %s", (user_id,))
        returning = cursor.fetchone()
        if returning:
            try:
                return_route = json.loads(returning["route_json"])
            except (TypeError, json.JSONDecodeError):
                return_route = {"path": []}
            payload["return_route"] = {"order_id": -int(user_id), "volunteer_id": int(user_id), "eta_minutes": int(returning["eta_minutes"]), "traffic_version": int(returning["traffic_version"]), "replanned_at": _iso(returning["updated_at"]), "motion_rate": _route_motion_rate(return_route, RETURN_PROGRESS_PER_SECOND), **return_route}
            payload["routes"].append(payload["return_route"])
        cursor.execute("""
            SELECT DISTINCT o.order_id, o.service_type, o.status, o.volunteer_id, o.address AS order_address,
                   e.elder_id, e.name AS elder_name, e.address AS elder_address, l.lng, l.lat,
                   d.urgency, d.dispatch_state, d.search_stage, d.forced_assignment
            FROM orders o JOIN dispatch_orders d ON d.order_id = o.order_id
            JOIN elders e ON e.elder_id = o.elder_id JOIN elder_location_state l ON l.elder_id = e.elder_id
            LEFT JOIN dispatch_candidates c ON c.order_id = o.order_id AND c.volunteer_id = %s
            WHERE o.status IN ('pending', 'accepted', 'in_progress')
              AND ((c.response_status IN ('invited', 'forced', 'accepted')) OR o.volunteer_id = %s)
              AND (o.volunteer_id = %s OR NOT EXISTS (
                    SELECT 1 FROM orders own
                    WHERE own.volunteer_id = %s AND own.status IN ('accepted', 'in_progress')
              ))
            ORDER BY o.order_id DESC
        """, (user_id, user_id, user_id, user_id))
        seen_elders: set[int] = set()
        for row in cursor.fetchall():
            elder_id = int(row["elder_id"])
            if elder_id not in seen_elders:
                payload["elders"].append({"elder_id": elder_id, "name": row["elder_name"], "address": row["elder_address"], "lng": float(row["lng"]), "lat": float(row["lat"])})
                seen_elders.add(elder_id)
            item = {
                "order_id": int(row["order_id"]), "service_type": row["service_type"], "status": row["status"],
                "volunteer_id": int(row["volunteer_id"]) if row["volunteer_id"] else None,
                "elder_name": row["elder_name"], "urgency": row["urgency"], "dispatch_state": row["dispatch_state"],
                "search_stage": int(row["search_stage"]), "forced_assignment": bool(row["forced_assignment"]),
                "lng": float(row["lng"]), "lat": float(row["lat"]), "address": row["order_address"] or row["elder_address"],
                "amap_marker_url": _amap_marker_url(float(row["lng"]), float(row["lat"]), f"{row['elder_name']}服务点"),
            }
            if int(row["volunteer_id"] or 0) == user_id and row["status"] in active_statuses:
                route = _route_for_order(cursor, int(row["order_id"]))
                if route:
                    payload["routes"].append(route)
                item["amap_navigation_url"] = _amap_navigation_url(own["lng"], own["lat"], item["lng"], item["lat"], f"{row['elder_name']}服务点")
            payload["orders"].append(item)
        payload["privacy_message"] = "仅展示已推荐给您或已指派给您的服务地点，不展示其他老人位置。"
        return payload

    if role == "family":
        cursor.execute("""
            SELECT DISTINCT e.elder_id, e.name, e.address, e.region_adcode, l.lng, l.lat, l.location_source, l.is_home_fixed
            FROM user_elder_relation rel JOIN elders e ON e.elder_id = rel.elder_id
            JOIN elder_location_state l ON l.elder_id = e.elder_id
            WHERE rel.family_user_id = %s
        """, (user_id,))
        elder_rows = cursor.fetchall()
        if not elder_rows:
            return None
        _set_tracking_region(payload, elder_rows[0].get("region_adcode"))
        payload["elders"] = [{
            "elder_id": int(row["elder_id"]), "name": row["name"], "address": row["address"],
            "lng": float(row["lng"]), "lat": float(row["lat"]), "location_source": row["location_source"], "is_home_fixed": bool(row["is_home_fixed"]),
        } for row in elder_rows]
        elder_by_id = {int(row["elder_id"]): row for row in elder_rows}
        cursor.execute("""
            SELECT o.order_id, o.elder_id, o.service_type, o.status, o.volunteer_id, o.address AS order_address,
                   d.urgency, d.dispatch_state, d.search_stage, d.forced_assignment,
                   u.real_name AS volunteer_name, p.lng AS volunteer_lng, p.lat AS volunteer_lat, p.availability
            FROM user_elder_relation rel JOIN orders o ON o.elder_id = rel.elder_id
            JOIN dispatch_orders d ON d.order_id = o.order_id
            LEFT JOIN users u ON u.user_id = o.volunteer_id
            LEFT JOIN volunteer_location_state p ON p.volunteer_id = o.volunteer_id
            WHERE rel.family_user_id = %s ORDER BY o.order_id DESC LIMIT 30
        """, (user_id,))
        for row in cursor.fetchall():
            elder = elder_by_id[int(row["elder_id"])]
            item = {
                "order_id": int(row["order_id"]), "service_type": row["service_type"], "status": row["status"],
                "volunteer_id": int(row["volunteer_id"]) if row["volunteer_id"] else None, "volunteer_name": row["volunteer_name"],
                "volunteer_availability": row["availability"] if row["volunteer_id"] else None,
                "elder_name": elder["name"], "urgency": row["urgency"], "dispatch_state": row["dispatch_state"],
                "search_stage": int(row["search_stage"]), "forced_assignment": bool(row["forced_assignment"]),
                "address": row["order_address"] or elder["address"],
            }
            if row["status"] in active_statuses and row["volunteer_id"]:
                volunteer = {"volunteer_id": int(row["volunteer_id"]), "name": row["volunteer_name"], "lng": float(row["volunteer_lng"]), "lat": float(row["volunteer_lat"]), "availability": row["availability"], "fatigue": 0, "rating": 0, "assigned_today": 0, "skills": []}
                payload["volunteers"].append(volunteer)
                payload["routes"].extend([route for route in [_route_for_order(cursor, int(row["order_id"]))] if route])
                item["location_sharing_active"] = True
                item["amap_navigation_url"] = _amap_navigation_url(volunteer["lng"], volunteer["lat"], float(elder["lng"]), float(elder["lat"]), f"{elder['name']}服务点")
            elif row["status"] == "completed" and row["volunteer_id"] and row["availability"] == "returning":
                volunteer = {"volunteer_id": int(row["volunteer_id"]), "name": row["volunteer_name"], "lng": float(row["volunteer_lng"]), "lat": float(row["volunteer_lat"]), "availability": "returning", "fatigue": 0, "rating": 0, "assigned_today": 0, "skills": []}
                payload["volunteers"].append(volunteer)
                payload["routes"].extend([route for route in [_return_route_for_volunteer(cursor, int(row["volunteer_id"]))] if route])
                item["location_sharing_active"] = True
            else:
                item["location_sharing_active"] = False
            payload["orders"].append(item)
        payload["privacy_message"] = "家属可查看绑定老人的固定/授权位置；志愿者位置仅在已接单或服务中共享，服务结束立即锁定。"
        return payload
    return None


@dispatch_bp.route("/overview", methods=["GET"])
def overview():
    conn = get_db_connection()
    if not conn:
        return jsonify({"code": 500, "message": "数据库连接失败"}), 500
    try:
        with conn.cursor() as cursor:
            payload = _overview(cursor, request.args.get("user_id", type=int), request.args.get("region_adcode"))
            conn.commit()
            return jsonify({"code": 200, "message": "共享调度地图已更新", "data": payload})
    except Exception as exc:
        conn.rollback()
        return jsonify({"code": 500, "message": f"调度看板加载失败: {exc}"}), 500
    finally:
        conn.close()


@dispatch_bp.route("/tracking", methods=["GET"])
def tracking():
    role = request.args.get("role", "")
    user_id = request.args.get("user_id", type=int)
    if role not in ("elder", "volunteer", "family", "admin") or not user_id:
        return jsonify({"code": 400, "message": "缺少合法的角色或用户编号"}), 400
    conn = get_db_connection()
    if not conn:
        return jsonify({"code": 500, "message": "数据库连接失败"}), 500
    try:
        with conn.cursor() as cursor:
            payload = _tracking_payload(cursor, role, user_id)
            if payload is None:
                return jsonify({"code": 404, "message": "当前账号没有可追踪的授权档案"}), 404
            conn.commit()
            return jsonify({"code": 200, "message": "实时位置已按当前账号权限刷新", "data": payload})
    except Exception as exc:
        conn.rollback()
        return jsonify({"code": 500, "message": f"实时位置加载失败: {exc}"}), 500
    finally:
        conn.close()


@dispatch_bp.route("/locations/elder", methods=["POST"])
def update_elder_location():
    data = request.get_json() or {}
    user_id = data.get("user_id")
    if not user_id:
        return jsonify({"code": 400, "message": "缺少老人账号"}), 400
    source = _location_source(data.get("source"))
    address = str(data.get("address") or "").strip()
    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute("SELECT elder_id, region_adcode FROM elders WHERE user_id = %s", (user_id,))
            elder = cursor.fetchone()
            if not elder:
                return jsonify({"code": 404, "message": "当前账号没有老人档案"}), 404
            resolved_region = _region_for_point(data.get("lng"), data.get("lat"))
            if not resolved_region:
                return jsonify({"code": 400, "message": "该定位不在已开通的服务区县内，请联系总管理员开通后再使用"}), 400
            point = _valid_region_point(data.get("lng"), data.get("lat"), resolved_region)
            if not point:
                return jsonify({"code": 400, "message": "定位必须位于所属服务区县范围内"}), 400
            elder_id = int(elder["elder_id"])
            previous_region = str(elder.get("region_adcode") or DEFAULT_REGION_ADCODE)
            if resolved_region != previous_region:
                cursor.execute("""SELECT 1 FROM orders WHERE elder_id = %s
                                  AND status IN ('pending', 'accepted', 'in_progress') LIMIT 1""", (elder_id,))
                if cursor.fetchone():
                    return jsonify({"code": 409, "message": "当前有未关闭订单，完成或取消后才能变更所属区县"}), 409
            cursor.execute("SELECT elder_id FROM elder_location_state WHERE elder_id = %s", (elder_id,))
            values = (point[0], point[1], source, source == "fixed_home", elder_id)
            if cursor.fetchone():
                cursor.execute("""UPDATE elder_location_state SET lng = %s, lat = %s, location_source = %s,
                                  is_home_fixed = %s, updated_at = CURRENT_TIMESTAMP WHERE elder_id = %s""", values)
            else:
                cursor.execute("""INSERT INTO elder_location_state (elder_id, lng, lat, location_source, is_home_fixed)
                                  VALUES (%s, %s, %s, %s, %s)""", (elder_id, point[0], point[1], source, source == "fixed_home"))
            if address:
                cursor.execute("UPDATE elders SET address = %s, region_adcode = %s WHERE elder_id = %s", (address, resolved_region, elder_id))
            elif resolved_region != previous_region:
                cursor.execute("UPDATE elders SET region_adcode = %s WHERE elder_id = %s", (resolved_region, elder_id))
            _event(cursor, None, "elder_location_updated", "老人服务位置已更新", {"elder_id": elder_id, "source": source})
            conn.commit()
            return jsonify({"code": 200, "message": "服务位置已保存，后续派单将使用此位置", "data": {"lng": point[0], "lat": point[1], "source": source}})
    except Exception as exc:
        conn.rollback()
        return jsonify({"code": 500, "message": f"保存老人位置失败: {exc}"}), 500
    finally:
        conn.close()


@dispatch_bp.route("/locations/volunteer", methods=["POST"])
def update_volunteer_location():
    data = request.get_json() or {}
    volunteer_id = data.get("volunteer_id")
    if not volunteer_id:
        return jsonify({"code": 400, "message": "缺少志愿者编号"}), 400
    source = _location_source(data.get("source"))
    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute("SELECT volunteer_id, service_region_adcode, availability FROM volunteer_location_state WHERE volunteer_id = %s", (volunteer_id,))
            volunteer = cursor.fetchone()
            if not volunteer:
                return jsonify({"code": 404, "message": "当前账号没有志愿者定位档案"}), 404
            point = _valid_region_point(data.get("lng"), data.get("lat"), volunteer.get("service_region_adcode"))
            if not point:
                if not is_active_region(volunteer.get("service_region_adcode"), REGION_CATALOG):
                    return jsonify({"code": 400, "message": "您所属服务区县尚未开通或已停用，暂无法更新定位"}), 400
                return jsonify({"code": 400, "message": "定位必须位于所属服务区县范围内"}), 400
            cursor.execute("""UPDATE volunteer_location_state SET lng = %s, lat = %s, location_source = %s,
                              updated_at = CURRENT_TIMESTAMP WHERE volunteer_id = %s""", (point[0], point[1], source, volunteer_id))
            _event(cursor, None, "volunteer_location_updated", "志愿者位置已更新", {"volunteer_id": int(volunteer_id), "source": source})
            conn.commit()
            return jsonify({"code": 200, "message": "当前位置已更新", "data": {"lng": point[0], "lat": point[1], "source": source}})
    except Exception as exc:
        conn.rollback()
        return jsonify({"code": 500, "message": f"保存志愿者位置失败: {exc}"}), 500
    finally:
        conn.close()


@dispatch_bp.route("/volunteer/preferences", methods=["POST"])
def update_volunteer_preferences():
    data = request.get_json() or {}
    volunteer_id = data.get("volunteer_id")
    if not volunteer_id:
        return jsonify({"code": 400, "message": "缺少志愿者编号"}), 400
    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute("SELECT volunteer_id, service_region_adcode FROM volunteer_location_state WHERE volunteer_id = %s", (volunteer_id,))
            volunteer = cursor.fetchone()
            if not volunteer:
                return jsonify({"code": 404, "message": "当前账号没有志愿者定位档案"}), 404
            resolved_region = _region_for_point(data.get("home_lng"), data.get("home_lat")) if data.get("home_lng") is not None else volunteer.get("service_region_adcode")
            if data.get("home_lng") is not None and not resolved_region:
                return jsonify({"code": 400, "message": "家庭位置不在已开通的服务区县内，请联系总管理员开通后再设置"}), 400
            if resolved_region and not is_active_region(resolved_region, REGION_CATALOG):
                return jsonify({"code": 400, "message": "目标服务区县尚未开通或已停用"}), 400
            home = _valid_region_point(data.get("home_lng"), data.get("home_lat"), resolved_region) if data.get("home_lng") is not None else None
            if data.get("home_lng") is not None and not home:
                return jsonify({"code": 400, "message": "家庭虚拟位置必须位于所属服务区县范围内"}), 400
            auto_accept = bool(data.get("auto_accept_enabled"))
            previous_region = str(volunteer.get("service_region_adcode") or DEFAULT_REGION_ADCODE)
            if resolved_region != previous_region:
                cursor.execute("""SELECT 1 FROM orders WHERE volunteer_id = %s
                                  AND status IN ('accepted', 'in_progress') LIMIT 1""", (volunteer_id,))
                if cursor.fetchone():
                    return jsonify({"code": 409, "message": "当前有进行中服务，结束后才能变更服务区县"}), 409
            if home:
                cursor.execute("""UPDATE volunteer_location_state SET home_lng = %s, home_lat = %s,
                                  service_region_adcode = %s, auto_accept_enabled = %s, updated_at = CURRENT_TIMESTAMP WHERE volunteer_id = %s""",
                               (home[0], home[1], resolved_region, auto_accept, volunteer_id))
            else:
                cursor.execute("""UPDATE volunteer_location_state SET auto_accept_enabled = %s,
                                  updated_at = CURRENT_TIMESTAMP WHERE volunteer_id = %s""", (auto_accept, volunteer_id))
            _event(cursor, None, "volunteer_dispatch_preferences_updated", "志愿者已更新虚拟出发地与自动接单设置", {"volunteer_id": int(volunteer_id), "auto_accept": auto_accept})
            conn.commit()
            return jsonify({"code": 200, "message": "虚拟出发地和自动接单设置已保存", "data": {"auto_accept_enabled": auto_accept, "home_lng": home[0] if home else None, "home_lat": home[1] if home else None}})
    except Exception as exc:
        conn.rollback()
        return jsonify({"code": 500, "message": f"保存志愿者偏好失败: {exc}"}), 500
    finally:
        conn.close()


@dispatch_bp.route("/volunteer/return/move", methods=["POST"])
def move_return_route():
    data = request.get_json() or {}
    volunteer_id = data.get("volunteer_id")
    if not volunteer_id:
        return jsonify({"code": 400, "message": "缺少志愿者编号"}), 400
    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute("SELECT route_json, eta_minutes FROM volunteer_return_routes WHERE volunteer_id = %s", (volunteer_id,))
            saved = cursor.fetchone()
            if not saved:
                return jsonify({"code": 409, "message": "当前没有返家路线"}), 409
            route = json.loads(saved["route_json"])
            path = route.get("path", [])
            if len(path) < 2:
                return jsonify({"code": 409, "message": "返家路线数据无效"}), 409
            progress = min(100, max(0, int(route.get("progress", 0)) + int(data.get("step", 20))))
            browser_point = _valid_baoshan_point(data.get("lng"), data.get("lat"))
            if browser_point:
                lng, lat = browser_point
            else:
                start, end = path[0], path[-1]
                ratio = progress / 100
                lng, lat = start[0] + (end[0] - start[0]) * ratio, start[1] + (end[1] - start[1]) * ratio
            route["progress"] = progress
            cursor.execute("""UPDATE volunteer_location_state SET lng = %s, lat = %s, location_source = 'virtual',
                              availability = %s, updated_at = CURRENT_TIMESTAMP WHERE volunteer_id = %s""",
                           (lng, lat, "idle" if progress >= 100 else "returning", volunteer_id))
            if progress >= 100:
                cursor.execute("DELETE FROM volunteer_return_routes WHERE volunteer_id = %s", (volunteer_id,))
                message = "已回到虚拟出发地，现在空闲可接单"
            else:
                cursor.execute("""UPDATE volunteer_return_routes SET route_json = %s, eta_minutes = %s,
                                  updated_at = CURRENT_TIMESTAMP WHERE volunteer_id = %s""",
                               (json.dumps(route, ensure_ascii=False), max(1, round(int(saved["eta_minutes"]) * (100 - progress) / 100)), volunteer_id))
                message = f"返家路线已推进至 {progress}%；途中仍可参与智能匹配"
            _event(cursor, None, "volunteer_returning_moved", message, {"volunteer_id": int(volunteer_id), "progress": progress})
            conn.commit()
            return jsonify({"code": 200, "message": message, "data": {"lng": lng, "lat": lat, "progress": progress}})
    except Exception as exc:
        conn.rollback()
        return jsonify({"code": 500, "message": f"推进返家路线失败: {exc}"}), 500
    finally:
        conn.close()


@dispatch_bp.route("/elder/orders", methods=["GET"])
def elder_orders():
    user_id = request.args.get("user_id", type=int)
    if not user_id:
        return jsonify({"code": 400, "message": "缺少老人账号"}), 400
    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            advance_dispatch(cursor)
            cursor.execute("""
                SELECT o.order_id, o.service_type, o.status, o.notes, o.volunteer_id, d.urgency,
                       d.dispatch_state, d.search_stage, d.forced_assignment, u.real_name AS volunteer_name,
                       r.route_json, r.eta_minutes
                FROM orders o JOIN elders e ON e.elder_id = o.elder_id
                JOIN dispatch_orders d ON d.order_id = o.order_id
                LEFT JOIN users u ON u.user_id = o.volunteer_id LEFT JOIN dispatch_routes r ON r.order_id = o.order_id
                WHERE e.user_id = %s ORDER BY d.created_at DESC LIMIT 20
            """, (user_id,))
            items = []
            for row in cursor.fetchall():
                item = dict(row)
                item["order_id"] = int(item["order_id"])
                item["volunteer_id"] = int(item["volunteer_id"]) if item["volunteer_id"] else None
                item["forced_assignment"] = bool(item["forced_assignment"])
                item["eta_minutes"] = int(item["eta_minutes"]) if item["eta_minutes"] else None
                item["route"] = json.loads(item.pop("route_json")) if item.get("route_json") else None
                items.append(item)
            conn.commit()
            return jsonify({"code": 200, "message": "老人调度订单获取成功", "data": items})
    finally:
        conn.close()


def create_smart_order_for_elder(
    cursor: Any,
    *,
    elder_id: int,
    created_by: int,
    service_type: str,
    service_hours: float | int | None = None,
    service_time: str | None = None,
    notes: str = "",
    address: str | None = None,
    urgent: bool = False,
    proxy_created_by: int | None = None,
    proxy_reason: str | None = None,
    manual_only: bool = False,
) -> tuple[int, str]:
    """Create one order through the authoritative local dispatch engine.

    Elder, family and administrator submissions all use this function.  It is
    deliberately not a task-hall insert: candidates, phase windows, routes
    and later manual intervention therefore stay on one shared timeline.
    """
    if service_type not in SERVICE_CATALOG:
        raise ValueError("unsupported service type")
    cursor.execute("SELECT elder_id, region_adcode FROM elders WHERE elder_id = %s", (elder_id,))
    elder = cursor.fetchone()
    if not elder:
        raise ValueError("elder profile not found")
    catalog = SERVICE_CATALOG[service_type]
    is_sos = bool(urgent) or bool(catalog.get("urgent"))
    region_adcode = str(elder.get("region_adcode") or DEFAULT_REGION_ADCODE)
    if not is_active_region(region_adcode, REGION_CATALOG):
        raise ValueError("老人所属区县尚未开通或已停用，无法下单")
    cursor.execute("""
        INSERT INTO orders
            (elder_id, created_by, service_type, service_time, service_hours, address, notes, status,
             region_adcode, proxy_created_by, proxy_reason)
        VALUES (%s, %s, %s, COALESCE(%s::timestamp, CURRENT_TIMESTAMP), %s, %s, %s, 'pending', %s, %s, %s)
        RETURNING order_id
    """, (elder_id, created_by, service_type, service_time, service_hours or catalog["hours"], address, notes,
           region_adcode, proxy_created_by, proxy_reason))
    order_id = int(cursor.fetchone()["order_id"])
    cursor.execute("""
        INSERT INTO dispatch_orders
            (order_id, urgency, required_skills, dispatch_state, forced_assignment, region_adcode,
             dispatch_phase, phase_started_at, phase_expires_at, dispatch_version)
        VALUES (%s, %s, %s, 'matching', %s, %s, %s, CURRENT_TIMESTAMP,
                CASE WHEN %s THEN NULL ELSE CURRENT_TIMESTAMP + (%s * INTERVAL '1 second') END, 1)
    """, (order_id, "sos" if is_sos else "normal", json.dumps(catalog["skills"]), is_sos, region_adcode,
           "fallback" if is_sos else "top1", is_sos, TOP1_WINDOW_SECONDS))
    order = _order_context(cursor, order_id)
    if is_sos:
        if manual_only:
            _upsert_candidates(cursor, order)
            cursor.execute("UPDATE dispatch_orders SET dispatch_state = 'admin_escalated' WHERE order_id = %s", (order_id,))
            _event(cursor, order_id, "sos_admin_manual_dispatch", "管理员已启动 SOS 志愿服务，等待从技能匹配候选中人工指定。",
                   {"region_adcode": region_adcode, "proxy_created_by": proxy_created_by})
            return order_id, "SOS 志愿服务已进入管理员人工派单"
        _event(cursor, order_id, "sos_service_created", "创建了带具体内容的 SOS 紧急服务调度。",
               {"region_adcode": region_adcode, "proxy_created_by": proxy_created_by})
        _force_assign_sos(cursor, order)
        return order_id, "SOS紧急服务已进入本区强制调度"
    _upsert_candidates(cursor, order)
    if not _invite_candidates(cursor, order, "代下单" if proxy_created_by else "老人下单"):
        cursor.execute("UPDATE dispatch_orders SET dispatch_state = 'queued_waiting_capacity' WHERE order_id = %s", (order_id,))
    _event(cursor, order_id, "smart_order_created", "服务请求已进入本区智能调度队列。",
           {"region_adcode": region_adcode, "proxy_created_by": proxy_created_by, "proxy_reason": proxy_reason})
    return order_id, "服务请求已进入智能推荐队列"


@dispatch_bp.route("/admin/incidents/<int:incident_id>/start-manual-sos-service", methods=["POST"])
def start_manual_sos_service(incident_id: int):
    """Convert an active SOS incident to a scoped administrator manual dispatch."""
    data = request.get_json() or {}
    admin_user_id = data.get("admin_user_id")
    if not admin_user_id:
        return jsonify({"code": 400, "message": "缺少管理员身份"}), 400
    conn = get_db_connection()
    if not conn:
        return jsonify({"code": 500, "message": "数据库连接失败"}), 500
    try:
        with conn.cursor() as cursor:
            cursor.execute("""SELECT incident_id, elder_id, region_adcode, description, linked_order_id, status
                              FROM emergency_incidents WHERE incident_id = %s FOR UPDATE""", (incident_id,))
            incident = cursor.fetchone()
            if not incident:
                return jsonify({"code": 404, "message": "紧急事件不存在"}), 404
            if incident["status"] == "resolved":
                return jsonify({"code": 409, "message": "已关闭的紧急事件不能启动志愿服务"}), 409
            if not _admin_can_manage_region(cursor, int(admin_user_id), str(incident["region_adcode"])):
                return jsonify({"code": 403, "message": "您无权处理该区县紧急事件"}), 403
            if incident.get("linked_order_id"):
                order_id = int(incident["linked_order_id"])
            else:
                order_id, _ = create_smart_order_for_elder(
                    cursor, elder_id=int(incident["elder_id"]), created_by=int(admin_user_id),
                    service_type="SOS紧急救助", notes=str(incident.get("description") or "紧急求助"),
                    urgent=True, proxy_created_by=int(admin_user_id), proxy_reason="管理员接警后启动人工 SOS 志愿服务",
                    manual_only=True,
                )
                cursor.execute("UPDATE emergency_incidents SET linked_order_id = %s, status = 'dispatching' WHERE incident_id = %s",
                               (order_id, incident_id))
                cursor.execute("""INSERT INTO conversation_messages (conversation_id, sender_user_id, message_type, content)
                                  SELECT conversation_id, %s, 'system', '管理员已启动本区 SOS 志愿服务，正在从技能匹配候选中人工派单。'
                                  FROM conversations WHERE incident_id = %s AND conversation_type = 'sos'""",
                               (int(admin_user_id), incident_id))
            order = _order_context(cursor, order_id)
            _upsert_candidates(cursor, order)
            cursor.execute("""SELECT c.volunteer_id, u.real_name AS volunteer_name, c.distance_km, c.eta_minutes,
                                      c.total_score, c.skill_match
                              FROM dispatch_candidates c JOIN users u ON u.user_id = c.volunteer_id
                              WHERE c.order_id = %s AND c.eligible = TRUE ORDER BY c.candidate_rank ASC LIMIT 8""", (order_id,))
            candidates = cursor.fetchall()
            conn.commit()
            return jsonify({"code": 200, "message": "SOS 志愿服务已启动，请在调度看板选择技能匹配志愿者派单",
                            "data": {"order_id": order_id, "candidates": candidates}})
    except Exception as exc:
        conn.rollback()
        return jsonify({"code": 500, "message": f"启动 SOS 志愿服务失败: {exc}"}), 500
    finally:
        conn.close()


@dispatch_bp.route("/orders", methods=["POST"])
def create_dispatch_order():
    data = request.get_json() or {}
    user_id = data.get("user_id")
    service_type = data.get("service_type")
    urgent = bool(data.get("urgent")) or service_type == "SOS紧急救助"
    if not user_id or service_type not in SERVICE_CATALOG:
        return jsonify({"code": 400, "message": "请选择受支持的服务类型"}), 400
    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute("SELECT elder_id, region_adcode FROM elders WHERE user_id = %s", (user_id,))
            elder = cursor.fetchone()
            if not elder:
                return jsonify({"code": 404, "message": "当前账号没有老人档案"}), 404
            region_adcode = str(elder.get("region_adcode") or DEFAULT_REGION_ADCODE)
            if not is_active_region(region_adcode, REGION_CATALOG):
                return jsonify({"code": 400, "message": "老人所属区县尚未开通或已停用，无法下单"}), 400
            catalog = SERVICE_CATALOG[service_type]
            service_time = data.get("service_time") or _now().strftime("%Y-%m-%d %H:%M:%S")
            cursor.execute("""
                INSERT INTO orders (elder_id, created_by, service_type, service_time, service_hours, notes, status, region_adcode)
                VALUES (%s, %s, %s, %s, %s, %s, 'pending', %s) RETURNING order_id
            """, (elder["elder_id"], user_id, service_type, service_time, data.get("service_hours") or catalog["hours"], data.get("notes") or "", region_adcode))
            order_id = int(cursor.fetchone()["order_id"])
            cursor.execute("""
                INSERT INTO dispatch_orders
                    (order_id, urgency, required_skills, dispatch_state, forced_assignment,
                     dispatch_phase, phase_started_at, phase_expires_at, dispatch_version)
                VALUES (%s, %s, %s, 'matching', %s, %s, CURRENT_TIMESTAMP,
                        CASE WHEN %s THEN NULL ELSE CURRENT_TIMESTAMP + (%s * INTERVAL '1 second') END, 1)
            """, (order_id, "sos" if urgent else "normal", json.dumps(catalog["skills"]), urgent,
                  "fallback" if urgent else "top1", urgent, TOP1_WINDOW_SECONDS))
            cursor.execute("UPDATE dispatch_orders SET region_adcode = %s WHERE order_id = %s",
                           (region_adcode, order_id))
            order = _order_context(cursor, order_id)
            if urgent:
                _event(cursor, order_id, "sos_created", "老人发起SOS，开始强制派单。")
                _force_assign_sos(cursor, order)
            else:
                _upsert_candidates(cursor, order)
                auto_assigned = _invite_candidates(cursor, order, "老人发起服务请求")
                if not auto_assigned:
                    cursor.execute("UPDATE dispatch_orders SET dispatch_state = 'waiting_response' WHERE order_id = %s", (order_id,))
                    _event(cursor, order_id, "order_created", f"已建立{service_type}请求，按技能硬过滤后开始智能推荐。")
            conn.commit()
            return jsonify({"code": 200, "message": "SOS已强制派单" if urgent else "请求已进入智能推荐队列", "data": {"order_id": order_id}})
    except Exception as exc:
        conn.rollback()
        return jsonify({"code": 500, "message": f"创建调度请求失败: {exc}"}), 500
    finally:
        conn.close()


@dispatch_bp.route("/admin/orders/<int:order_id>/manual-assign", methods=["POST"])
def admin_manual_assign_order(order_id: int):
    """Restricted human fallback for an exceptional local dispatch order."""
    data = request.get_json() or {}
    admin_user_id = data.get("admin_user_id")
    volunteer_id = data.get("volunteer_id")
    reason = str(data.get("reason") or "").strip()
    if not admin_user_id or not volunteer_id or not reason:
        return jsonify({"code": 400, "message": "管理员、候选志愿者和人工派单原因均不能为空"}), 400
    conn = get_db_connection()
    if not conn:
        return jsonify({"code": 500, "message": "数据库连接失败"}), 500
    try:
        with conn.cursor() as cursor:
            order = _order_context(cursor, order_id)
            if not order or order["status"] != "pending":
                return jsonify({"code": 409, "message": "该订单当前不可人工派单"}), 409
            if not _admin_can_manage_region(cursor, int(admin_user_id), str(order["region_adcode"])):
                return jsonify({"code": 403, "message": "您无权处理该区县订单"}), 403
            if str(order.get("dispatch_state")) not in ("admin_escalated", "queued_waiting_capacity", "fallback", "matching", "waiting_response"):
                return jsonify({"code": 409, "message": "该订单尚未进入可人工介入状态"}), 409
            _upsert_candidates(cursor, order)
            cursor.execute("""
                SELECT c.volunteer_id
                FROM dispatch_candidates c JOIN volunteer_location_state p ON p.volunteer_id = c.volunteer_id
                WHERE c.order_id = %s AND c.volunteer_id = %s AND c.eligible = TRUE
                  AND p.service_region_adcode = %s AND p.availability IN ('idle', 'returning')
                  AND NOT EXISTS (SELECT 1 FROM orders active WHERE active.volunteer_id = p.volunteer_id
                                  AND active.status IN ('accepted', 'in_progress'))
            """, (order_id, volunteer_id, order["region_adcode"]))
            if not cursor.fetchone():
                return jsonify({"code": 409, "message": "该志愿者不满足本区、技能或空闲条件"}), 409
            route = _accept_candidate(cursor, order, int(volunteer_id), automatic=False)
            if not route:
                return jsonify({"code": 409, "message": "并发校验未通过，候选志愿者可能刚被其他订单占用"}), 409
            _event(cursor, order_id, "admin_manual_assigned", "管理员人工介入派单成功。",
                   {"admin_user_id": int(admin_user_id), "volunteer_id": int(volunteer_id), "reason": reason,
                    "region_adcode": order["region_adcode"]})
            conn.commit()
            return jsonify({"code": 200, "message": "人工派单成功，路线已从志愿者当前实时位置生成", "data": {"route": route}})
    except Exception as exc:
        conn.rollback()
        return jsonify({"code": 500, "message": f"人工派单失败: {exc}"}), 500
    finally:
        conn.close()


@dispatch_bp.route("/volunteer/feed", methods=["GET"])
def volunteer_feed():
    volunteer_id = request.args.get("volunteer_id", type=int)
    if not volunteer_id:
        return jsonify({"code": 400, "message": "缺少志愿者账号"}), 400
    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            advance_dispatch(cursor)
            cursor.execute("""
                SELECT c.order_id, c.candidate_rank, c.distance_km, c.eta_minutes, c.distance_score,
                       c.traffic_score, c.fatigue_score, c.rating_score, c.total_score, c.response_status,
                       o.service_type, o.status, d.urgency, d.forced_assignment, d.dispatch_phase, e.name AS elder_name,
                       e.address AS elder_address, el.lng AS elder_lng, el.lat AS elder_lat,
                       d.required_skills, r.route_json
                FROM orders o JOIN dispatch_orders d ON d.order_id = o.order_id
                LEFT JOIN dispatch_candidates c ON c.order_id = o.order_id AND c.volunteer_id = %s
                JOIN elders e ON e.elder_id = o.elder_id
                JOIN elder_location_state el ON el.elder_id = e.elder_id
                LEFT JOIN dispatch_routes r ON r.order_id = o.order_id
                WHERE ((o.status = 'pending' AND c.eligible = TRUE AND c.response_status IN ('invited', 'forced')
                        AND NOT EXISTS (SELECT 1 FROM orders own WHERE own.volunteer_id = %s
                                        AND own.status IN ('accepted', 'in_progress')))
                       OR (o.volunteer_id = %s AND o.status IN ('accepted', 'in_progress')))
                ORDER BY d.urgency DESC, c.total_score DESC
            """, (volunteer_id, volunteer_id, volunteer_id))
            tasks = []
            for row in cursor.fetchall():
                item = dict(row)
                for key in ("order_id", "candidate_rank", "eta_minutes"):
                    if item.get(key) is not None:
                        item[key] = int(item[key])
                for key in ("distance_km", "distance_score", "traffic_score", "fatigue_score", "rating_score", "total_score"):
                    if item.get(key) is not None:
                        item[key] = float(item[key])
                item["forced_assignment"] = bool(item["forced_assignment"])
                # Older orders accepted by the former task-hall endpoint had
                # no candidate row.  They are still the volunteer's active
                # assignment, so normalize them as accepted for auto-depart.
                if not item.get("response_status") and item.get("status") in ("accepted", "in_progress"):
                    item["response_status"] = "accepted"
                item["required_skills"] = json.loads(item["required_skills"])
                item["required_skill_labels"] = [SKILL_LABELS.get(tag, tag) for tag in item["required_skills"]]
                item["route"] = json.loads(item.pop("route_json")) if item.get("route_json") else None
                item["lng"] = float(item.pop("elder_lng"))
                item["lat"] = float(item.pop("elder_lat"))
                item["address"] = item.pop("elder_address")
                item["amap_marker_url"] = _amap_marker_url(item["lng"], item["lat"], f"{item['elder_name']}服务点")
                tasks.append(item)
            cursor.execute("""SELECT availability, fatigue_score, service_rating, assigned_today, location_source, home_lng, home_lat,
                              auto_accept_enabled FROM volunteer_location_state WHERE volunteer_id = %s""", (volunteer_id,))
            state = cursor.fetchone() or {"availability": "idle", "fatigue_score": 0, "service_rating": 0, "assigned_today": 0,
                                           "location_source": "simulated", "home_lng": None, "home_lat": None, "auto_accept_enabled": False}
            # Automatic mode is a 35-second fallback, not an override of the
            # protected manual windows.  An opted-in volunteer can therefore
            # still see and confirm a Top1/Top3/Top10 offer; only after those
            # windows expire may the system accept on the volunteer's behalf.
            # Finished work is deliberately not mixed into the live candidate
            # list: it is an auditable history, while cancelled assignments
            # must disappear from this volunteer's view entirely.
            cursor.execute("""
                SELECT o.order_id, o.service_type, e.name AS elder_name, o.address,
                       MAX(ev.created_at) AS completed_at
                FROM orders o JOIN elders e ON e.elder_id = o.elder_id
                LEFT JOIN dispatch_events ev ON ev.order_id = o.order_id AND ev.event_type = 'service_completed'
                WHERE o.volunteer_id = %s AND o.status = 'completed'
                GROUP BY o.order_id, o.service_type, e.name, o.address
                ORDER BY MAX(ev.created_at) DESC NULLS LAST, o.order_id DESC
                LIMIT 20
            """, (volunteer_id,))
            completed_tasks = [{
                "order_id": int(row["order_id"]), "service_type": row["service_type"],
                "elder_name": row["elder_name"], "address": row["address"],
                "completed_at": _iso(row["completed_at"]),
            } for row in cursor.fetchall()]
            preview = _next_assignment_preview(cursor, volunteer_id)
            conn.commit()
            return jsonify({"code": 200, "message": "智能推荐已更新", "data": {"tasks": tasks, "state": state, "completed_tasks": completed_tasks, "next_assignment_preview": preview}})
    finally:
        conn.close()


def _mark_sos_service_completed(cursor: Any, order_id: int, source: str) -> None:
    """Move a linked safety SOS to an auditable post-service confirmation state."""
    cursor.execute("""SELECT incident_id FROM emergency_incidents
                      WHERE linked_order_id = %s AND status <> 'resolved' FOR UPDATE""", (order_id,))
    incident = cursor.fetchone()
    if not incident:
        return
    incident_id = int(incident["incident_id"])
    cursor.execute("UPDATE emergency_incidents SET status = 'awaiting_admin_close' WHERE incident_id = %s", (incident_id,))
    cursor.execute("""INSERT INTO conversation_messages (conversation_id, sender_user_id, message_type, content)
                      SELECT conversation_id, NULL, 'system', '志愿服务已完成，等待管理员确认风险已解除并关闭 SOS 事件。'
                      FROM conversations WHERE incident_id = %s AND conversation_type = 'sos'""", (incident_id,))
    _event(cursor, order_id, "sos_service_completed_pending_close", "SOS 关联志愿服务已完成，已通知管理员确认处置结果后关闭事件。",
           {"incident_id": incident_id, "completion_source": source})


@dispatch_bp.route("/orders/<int:order_id>/respond", methods=["POST"])
def respond_dispatch_order(order_id: int):
    data = request.get_json() or {}
    volunteer_id, action = data.get("volunteer_id"), data.get("action")
    if not volunteer_id or action not in ("accept", "decline", "start", "simulate_move", "complete", "cancel"):
        return jsonify({"code": 400, "message": "响应参数不完整"}), 400
    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute("SELECT order_id FROM orders WHERE order_id = %s FOR UPDATE", (order_id,))
            if not cursor.fetchone():
                return jsonify({"code": 404, "message": "订单不存在"}), 404
            order = _order_context(cursor, order_id)
            if not order:
                return jsonify({"code": 404, "message": "不是智能调度订单"}), 404
            if action == "cancel":
                if int(order.get("volunteer_id") or 0) != int(volunteer_id):
                    return jsonify({"code": 403, "message": "仅当前接单志愿者可以取消"}), 403
                if bool(order["forced_assignment"]):
                    return jsonify({"code": 403, "message": "SOS 强制派单不能在线取消，请联系管理员申诉"}), 403
                if order["status"] != "accepted":
                    return jsonify({"code": 409, "message": "仅未开始服务的订单可以取消；服务中请先完成服务"}), 409
                _release_dispatch_order(cursor, order, int(volunteer_id), "volunteer_assignment_cancelled", "志愿者出发前取消，系统已立即重新计算下一位最优候选。")
                conn.commit()
                return jsonify({"code": 200, "message": "已取消接单，系统正在向下一位技能匹配志愿者重新派单"})
            if action in ("start", "simulate_move"):
                if int(order.get("volunteer_id") or 0) != int(volunteer_id):
                    return jsonify({"code": 403, "message": "仅指派的志愿者可以更新出发状态与位置"}), 403
                if order["status"] not in ("accepted", "in_progress"):
                    return jsonify({"code": 409, "message": "请先接单后再更新行程"}), 409
                if action == "start":
                    cursor.execute("UPDATE orders SET status = 'in_progress' WHERE order_id = %s", (order_id,))
                    cursor.execute("UPDATE dispatch_orders SET dispatch_state = 'serving' WHERE order_id = %s", (order_id,))
                    # A manual "arrived" click is an explicit confirmation
                    # that the volunteer is at the elder's home.  Snap the
                    # persisted shared coordinate to that address, not the
                    # previous virtual-road point, so elder/family/admin all
                    # render the same stationary service marker.
                    cursor.execute("""UPDATE volunteer_location_state
                                      SET lng = %s, lat = %s, availability = 'serving', location_source = 'virtual', updated_at = CURRENT_TIMESTAMP
                                      WHERE volunteer_id = %s""", (order["elder_lng"], order["elder_lat"], volunteer_id))
                    route = _route_for_order(cursor, order_id)
                    if route:
                        route["progress"] = 101
                        route["journey_type"] = "serving"
                        cursor.execute("""UPDATE dispatch_routes SET route_json = %s, eta_minutes = 0,
                                          replanned_at = CURRENT_TIMESTAMP WHERE order_id = %s""",
                                       (json.dumps(route, ensure_ascii=False), order_id))
                    _event(cursor, order_id, "service_started", "志愿者已到达并开始服务，位置将持续向老人和绑定家属共享。", {"volunteer_id": volunteer_id})
                    conn.commit()
                    return jsonify({"code": 200, "message": "已开始服务，家属端正在同步状态"})
                route = _route_for_order(cursor, order_id)
                if not route or len(route.get("path", [])) < 2:
                    return jsonify({"code": 409, "message": "路线尚未生成，请稍后再试"}), 409
                progress = min(95, max(0, int(route.get("progress", 0)) + int(data.get("step", 15))))
                path = route["path"]
                browser_point = _valid_baoshan_point(data.get("lng"), data.get("lat"))
                if browser_point:
                    # The client supplies a point sampled from AMap.Driving.
                    lng, lat = browser_point
                else:
                    start, end = path[0], path[-1]
                    ratio = progress / 100
                    lng, lat = start[0] + (end[0] - start[0]) * ratio, start[1] + (end[1] - start[1]) * ratio
                route["progress"] = progress
                cursor.execute("""UPDATE volunteer_location_state SET lng = %s, lat = %s, location_source = 'virtual',
                                  availability = 'en_route', updated_at = CURRENT_TIMESTAMP WHERE volunteer_id = %s""",
                               (lng, lat, volunteer_id))
                cursor.execute("""UPDATE dispatch_routes SET route_json = %s, eta_minutes = %s, replanned_at = CURRENT_TIMESTAMP
                                  WHERE order_id = %s""",
                               (json.dumps(route, ensure_ascii=False), max(1, round(int(route["eta_minutes"]) * (100 - progress) / 100)), order_id))
                _event(cursor, order_id, "virtual_location_advanced", "志愿者沿高德真实道路路线推进", {"volunteer_id": volunteer_id, "progress": progress})
                conn.commit()
                return jsonify({"code": 200, "message": f"已沿路线推进到 {progress}%", "data": {"lng": lng, "lat": lat, "progress": progress}})
            if action == "complete":
                if int(order.get("volunteer_id") or 0) != int(volunteer_id):
                    return jsonify({"code": 403, "message": "仅指派志愿者可以完成任务"}), 403
                if order["status"] != "in_progress":
                    return jsonify({"code": 409, "message": "请先点击到达并开始服务，再完成订单"}), 409
                cursor.execute("UPDATE orders SET status = 'completed' WHERE order_id = %s", (order_id,))
                cursor.execute("UPDATE dispatch_orders SET dispatch_state = 'completed' WHERE order_id = %s", (order_id,))
                _mark_sos_service_completed(cursor, order_id, "volunteer")
                hours = float(order.get("service_hours") or 1)
                cursor.execute("SELECT review_id FROM volunteer_hour_reviews WHERE order_id = %s", (order_id,))
                if cursor.fetchone():
                    cursor.execute("""UPDATE volunteer_hour_reviews SET expected_hours = %s, declared_hours = %s,
                                      max_auto_hours = %s, review_status = 'pending_family', approved_hours = NULL,
                                      review_note = NULL, reviewed_at = NULL WHERE order_id = %s""",
                                   (hours, hours, hours * 1.5, order_id))
                else:
                    cursor.execute("""INSERT INTO volunteer_hour_reviews
                                      (order_id, volunteer_id, expected_hours, declared_hours, max_auto_hours, review_status, approved_hours)
                                      VALUES (%s, %s, %s, %s, %s, 'pending_family', NULL)""",
                                   (order_id, volunteer_id, hours, hours, hours * 1.5))
                # The inbound route has reached its endpoint. Remove it before
                # publishing the return route so the map keeps one continuous
                # marker at the elder's location instead of two stale markers.
                cursor.execute("DELETE FROM dispatch_routes WHERE order_id = %s", (order_id,))
                return_route = _create_return_route(cursor, int(volunteer_id))
                _record_completed_service_fatigue(cursor, int(volunteer_id), hours)
                cursor.execute("UPDATE volunteer_location_state SET availability = %s WHERE volunteer_id = %s",
                               ("returning" if return_route else "idle", volunteer_id))
                _event(cursor, order_id, "service_completed", "志愿服务已完成，家属端已锁定志愿者位置；志愿者可按虚拟路线返家并在途中继续接单。")
                if return_route:
                    _event(cursor, order_id, "return_journey_started", "已生成紫色返家路线；20秒返程展示后将自动扫描下一单。", {"volunteer_id": volunteer_id, "auto_scan_after_seconds": RETURN_AUTO_DISPATCH_GRACE_SECONDS})
                cursor.execute("SELECT auto_accept_enabled FROM volunteer_location_state WHERE volunteer_id = %s", (volunteer_id,))
                auto_state = cursor.fetchone()
                if auto_state and auto_state["auto_accept_enabled"]:
                    _event(cursor, order_id, "auto_chain_scan", "已开启自动接单：服务结束后立即扫描下一位技能与距离最匹配的老人请求。", {"volunteer_id": volunteer_id})
                    # Do not scan inside this completion transaction.  The
                    # persisted return_started_at gate makes the next normal
                    # refresh pick up the chain only after the visible purple
                    # return route has been shown for its full grace window.
                conn.commit()
                return jsonify({"code": 200, "message": "任务已完成，家属端的位置共享已停止", "data": {"return_route": return_route}})
            cursor.execute("SELECT response_status, eligible FROM dispatch_candidates WHERE order_id = %s AND volunteer_id = %s", (order_id, volunteer_id))
            candidate = cursor.fetchone()
            if not candidate or not candidate["eligible"]:
                return jsonify({"code": 403, "message": "你不满足该服务的硬技能要求，不能接单"}), 403
            if action == "decline" and bool(order["forced_assignment"]):
                return jsonify({"code": 403, "message": "SOS强制派单不可在线拒绝；如有特殊原因请在事后申诉"}), 403
            if action == "decline":
                cursor.execute("""UPDATE dispatch_candidates SET response_status = 'declined', responded_at = CURRENT_TIMESTAMP
                                  WHERE order_id = %s AND volunteer_id = %s""", (order_id, volunteer_id))
                _event(cursor, order_id, "candidate_declined", "志愿者拒绝推荐，系统继续推送下一位候选。", {"volunteer_id": volunteer_id})
                _invite_candidates(cursor, order, "候选志愿者拒绝")
                conn.commit()
                return jsonify({"code": 200, "message": "已记录拒绝，已向下一位候选推送"})
            if order["status"] != "pending":
                return jsonify({"code": 409, "message": "订单已被其他志愿者接取"}), 409
            if candidate["response_status"] not in ("invited", "forced"):
                return jsonify({"code": 403, "message": "当前订单尚未向你开放"}), 403
            route = _accept_candidate(cursor, order, int(volunteer_id))
            if route is None:
                conn.rollback()
                return jsonify({"code": 409, "message": "接单未成功：你已有进行中的服务，或该订单刚被其他志愿者抢到"}), 409
            conn.commit()
            return jsonify({"code": 200, "message": "接单成功，路线已生成", "data": route})
    except Exception as exc:
        conn.rollback()
        return jsonify({"code": 500, "message": f"处理接单响应失败: {exc}"}), 500
    finally:
        conn.close()


@dispatch_bp.route("/orders/<int:order_id>/cancel", methods=["POST"])
def cancel_dispatch_order(order_id: int):
    """Allow the requesting elder to cancel before service starts."""
    data = request.get_json() or {}
    user_id = data.get("user_id")
    if not user_id:
        return jsonify({"code": 400, "message": "缺少老人账号"}), 400
    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute("SELECT order_id FROM orders WHERE order_id = %s FOR UPDATE", (order_id,))
            if not cursor.fetchone():
                return jsonify({"code": 404, "message": "订单不存在"}), 404
            order = _order_context(cursor, order_id)
            if not order:
                return jsonify({"code": 404, "message": "不是智能调度订单"}), 404
            cursor.execute("SELECT elder_id FROM elders WHERE user_id = %s", (user_id,))
            elder = cursor.fetchone()
            if not elder or int(elder["elder_id"]) != int(order["elder_id"]):
                return jsonify({"code": 403, "message": "无权取消该订单"}), 403
            if order["status"] not in ("pending", "accepted"):
                return jsonify({"code": 409, "message": "服务已开始或已结束，不能取消"}), 409
            volunteer_id = int(order.get("volunteer_id") or 0)
            if volunteer_id:
                # Freeze the exact current point on the outbound road route
                # before removing it; the return route must start here, not
                # from the last polling sample or the volunteer's home.
                _materialize_dispatch_position(cursor, order_id, volunteer_id)
                cursor.execute("DELETE FROM dispatch_routes WHERE order_id = %s", (order_id,))
                return_route = _create_return_route(cursor, volunteer_id)
                cursor.execute("""UPDATE volunteer_location_state SET availability = %s, updated_at = CURRENT_TIMESTAMP
                                  WHERE volunteer_id = %s""", ("returning" if return_route else "idle", volunteer_id))
            cursor.execute("UPDATE orders SET status = 'cancelled' WHERE order_id = %s", (order_id,))
            cursor.execute("UPDATE dispatch_orders SET dispatch_state = 'cancelled' WHERE order_id = %s", (order_id,))
            cursor.execute("""UPDATE dispatch_candidates SET response_status = 'expired', responded_at = CURRENT_TIMESTAMP
                              WHERE order_id = %s AND response_status IN ('waiting', 'invited', 'forced')""", (order_id,))
            _event(cursor, order_id, "elder_order_cancelled", "老人已取消服务请求，已停止后续调度。", {"elder_user_id": int(user_id)})
            conn.commit()
            return jsonify({"code": 200, "message": "订单已取消"})
    except Exception as exc:
        conn.rollback()
        return jsonify({"code": 500, "message": f"取消订单失败: {exc}"}), 500
    finally:
        conn.close()


@dispatch_bp.route("/orders/<int:order_id>/elder-complete", methods=["POST"])
def elder_complete_dispatch_order(order_id: int):
    """Let the requesting elder confirm an in-progress service is finished."""
    data = request.get_json() or {}
    user_id = data.get("user_id")
    if not user_id:
        return jsonify({"code": 400, "message": "缺少老人账号"}), 400
    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute("SELECT order_id FROM orders WHERE order_id = %s FOR UPDATE", (order_id,))
            if not cursor.fetchone():
                return jsonify({"code": 404, "message": "订单不存在"}), 404
            order = _order_context(cursor, order_id)
            if not order:
                return jsonify({"code": 404, "message": "不是智能调度订单"}), 404
            cursor.execute("SELECT elder_id FROM elders WHERE user_id = %s", (user_id,))
            elder = cursor.fetchone()
            if not elder or int(elder["elder_id"]) != int(order["elder_id"]):
                return jsonify({"code": 403, "message": "无权确认该订单"}), 403
            if order["status"] != "in_progress" or not order.get("volunteer_id"):
                return jsonify({"code": 409, "message": "仅服务中的订单可由老人确认完成"}), 409

            volunteer_id = int(order["volunteer_id"])
            hours = float(order.get("service_hours") or 1)
            cursor.execute("UPDATE orders SET status = 'completed' WHERE order_id = %s", (order_id,))
            cursor.execute("UPDATE dispatch_orders SET dispatch_state = 'completed' WHERE order_id = %s", (order_id,))
            _mark_sos_service_completed(cursor, order_id, "elder")
            cursor.execute("SELECT review_id FROM volunteer_hour_reviews WHERE order_id = %s", (order_id,))
            if cursor.fetchone():
                cursor.execute("""UPDATE volunteer_hour_reviews SET expected_hours = %s, declared_hours = %s,
                                  max_auto_hours = %s, review_status = 'pending_family', approved_hours = NULL,
                                  review_note = NULL, reviewed_at = NULL WHERE order_id = %s""",
                               (hours, hours, hours * 1.5, order_id))
            else:
                cursor.execute("""INSERT INTO volunteer_hour_reviews
                                  (order_id, volunteer_id, expected_hours, declared_hours, max_auto_hours, review_status, approved_hours)
                                  VALUES (%s, %s, %s, %s, %s, 'pending_family', NULL)""",
                               (order_id, volunteer_id, hours, hours, hours * 1.5))
            cursor.execute("DELETE FROM dispatch_routes WHERE order_id = %s", (order_id,))
            return_route = _create_return_route(cursor, volunteer_id)
            _record_completed_service_fatigue(cursor, volunteer_id, hours)
            cursor.execute("UPDATE volunteer_location_state SET availability = %s WHERE volunteer_id = %s",
                           ("returning" if return_route else "idle", volunteer_id))
            _event(cursor, order_id, "elder_confirmed_completion", "老人已确认服务完成；家属端已停止位置共享，等待家属审核志愿时长。", {"elder_user_id": int(user_id), "volunteer_id": volunteer_id})
            if return_route:
                _event(cursor, order_id, "return_journey_started", "已生成紫色返家路线；返程展示后可继续自动匹配下一单。", {"volunteer_id": volunteer_id})
            conn.commit()
            return jsonify({"code": 200, "message": "已确认服务完成，志愿者正在返家，家属可审核服务时长", "data": {"return_route": return_route}})
    except Exception as exc:
        conn.rollback()
        return jsonify({"code": 500, "message": f"确认服务完成失败: {exc}"}), 500
    finally:
        conn.close()


@dispatch_bp.route("/routes/<int:order_id>/geometry", methods=["POST"])
def persist_amap_route_geometry(order_id: int):
    """Persist one browser-resolved AMap polyline for all portals to reuse."""
    data = request.get_json() or {}
    raw_path = data.get("path") or []
    if not isinstance(raw_path, list):
        return jsonify({"code": 400, "message": "路线坐标格式不正确"}), 400
    path: list[list[float]] = []
    for point in raw_path[:360]:
        valid = _valid_baoshan_point(point[0] if isinstance(point, (list, tuple)) and len(point) >= 2 else None,
                                     point[1] if isinstance(point, (list, tuple)) and len(point) >= 2 else None)
        if valid and (not path or valid != tuple(path[-1])):
            path.append([valid[0], valid[1]])
    if len(path) < 2:
        return jsonify({"code": 400, "message": "有效路线坐标不足"}), 400
    raw_segments = data.get("traffic_segments") or []
    segments = []
    if isinstance(raw_segments, list):
        for segment in raw_segments[:18]:
            if not isinstance(segment, dict):
                continue
            section = []
            for point in (segment.get("path") or [])[:100]:
                valid = _valid_baoshan_point(point[0] if isinstance(point, (list, tuple)) and len(point) >= 2 else None,
                                             point[1] if isinstance(point, (list, tuple)) and len(point) >= 2 else None)
                if valid:
                    section.append([valid[0], valid[1]])
            if len(section) >= 2:
                segments.append({"path": section, "status": str(segment.get("status") or "")})
    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            if order_id < 0:
                volunteer_id = int(data.get("volunteer_id") or -order_id)
                cursor.execute("SELECT route_json FROM volunteer_return_routes WHERE volunteer_id = %s FOR UPDATE", (volunteer_id,))
                row = cursor.fetchone()
                if not row:
                    return jsonify({"code": 404, "message": "返家路线不存在"}), 404
                route = json.loads(row["route_json"])
                route.update({"path": path, "traffic_segments": segments, "geometry_source": "amap"})
                cursor.execute("UPDATE volunteer_return_routes SET route_json = %s, updated_at = CURRENT_TIMESTAMP WHERE volunteer_id = %s",
                               (json.dumps(route, ensure_ascii=False), volunteer_id))
            else:
                cursor.execute("SELECT route_json FROM dispatch_routes WHERE order_id = %s FOR UPDATE", (order_id,))
                row = cursor.fetchone()
                if not row:
                    return jsonify({"code": 404, "message": "服务路线不存在"}), 404
                route = json.loads(row["route_json"])
                route.update({"path": path, "traffic_segments": segments, "geometry_source": "amap"})
                cursor.execute("UPDATE dispatch_routes SET route_json = %s, replanned_at = CURRENT_TIMESTAMP WHERE order_id = %s",
                               (json.dumps(route, ensure_ascii=False), order_id))
            conn.commit()
            return jsonify({"code": 200, "message": "高德道路几何已共享"})
    except Exception as exc:
        conn.rollback()
        return jsonify({"code": 500, "message": f"保存路线失败: {exc}"}), 500
    finally:
        conn.close()


@dispatch_bp.route("/traffic/perturb", methods=["POST"])
def perturb_traffic():
    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            version = _traffic_version(cursor) + 1
            cursor.execute("""UPDATE dispatch_system_state SET state_value = %s, updated_at = CURRENT_TIMESTAMP
                              WHERE state_key = 'traffic_version'""", (str(version),))
            cursor.execute("""
                SELECT d.order_id FROM dispatch_orders d JOIN orders o ON o.order_id = d.order_id
                WHERE d.urgency = 'sos' AND o.status IN ('accepted', 'in_progress')
            """)
            rerouted = 0
            for row in cursor.fetchall():
                order = _order_context(cursor, int(row["order_id"]))
                if order and order.get("volunteer_id"):
                    _advance_route_to_current_intersection(cursor, int(order["order_id"]), int(order["volunteer_id"]))
                    route = _create_route(cursor, order, int(order["volunteer_id"]))
                    _event(cursor, int(order["order_id"]), "sos_rerouted", f"路况突变，SOS按最新路况重新规划，ETA {route['eta_minutes']}分钟。")
                    rerouted += 1
            _event(cursor, None, "traffic_perturbed", "共享路况版本已更新，所有新订单使用同一张最新交通网格。", {"traffic_version": version, "sos_rerouted": rerouted})
            conn.commit()
            return jsonify({"code": 200, "message": "路况突变已模拟，SOS路线已重规划", "data": {"traffic_version": version, "rerouted": rerouted}})
    finally:
        conn.close()


@dispatch_bp.route("/simulation/burst", methods=["POST"])
def simulation_burst():
    data = request.get_json() or {}
    count = max(1, min(int(data.get("count", 2)), 6))
    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute("""SELECT e.elder_id, e.user_id FROM elders e
                              JOIN elder_location_state l ON l.elder_id = e.elder_id
                              WHERE l.location_source <> 'hidden_demo' ORDER BY e.elder_id LIMIT 25""")
            elders = cursor.fetchall()
            if not elders:
                return jsonify({"code": 400, "message": "没有可用于模拟的老人档案"}), 400
            codes = [code for code in SERVICE_CATALOG if code != "SOS紧急救助"]
            created = []
            for index in range(count):
                elder = elders[(index * 7 + random.randint(0, len(elders) - 1)) % len(elders)]
                code = codes[index % len(codes)]
                urgent = (count >= 2 and index == 0) or (count == 1 and random.random() < 0.18)
                service = "SOS紧急救助" if urgent else code
                definition = SERVICE_CATALOG[service]
                cursor.execute("""INSERT INTO orders (elder_id, created_by, service_type, service_time, service_hours, notes, status)
                                  VALUES (%s, %s, %s, CURRENT_TIMESTAMP, %s, %s, 'pending') RETURNING order_id""",
                               (elder["elder_id"], elder["user_id"], service, definition["hours"], "并发调度沙盘自动生成"))
                order_id = int(cursor.fetchone()["order_id"])
                cursor.execute("""INSERT INTO dispatch_orders (order_id, urgency, required_skills, dispatch_state, forced_assignment)
                                  VALUES (%s, %s, %s, 'matching', %s)""",
                               (order_id, "sos" if urgent else "normal", json.dumps(definition["skills"]), urgent))
                order = _order_context(cursor, order_id)
                if urgent:
                    _event(cursor, order_id, "simulation_sos", "并发沙盘生成SOS订单。")
                    _force_assign_sos(cursor, order)
                else:
                    _upsert_candidates(cursor, order)
                    if not _invite_candidates(cursor, order, "并发沙盘"):
                        cursor.execute("UPDATE dispatch_orders SET dispatch_state = 'waiting_response' WHERE order_id = %s", (order_id,))
                created.append(order_id)
            _event(cursor, None, "simulation_burst", f"已生成{count}个并发老人请求，包含{sum(1 for x in created if x)}个队列任务。", {"order_ids": created})
            conn.commit()
            return jsonify({"code": 200, "message": f"已生成{count}个并发模拟请求", "data": {"order_ids": created}})
    except Exception as exc:
        conn.rollback()
        return jsonify({"code": 500, "message": f"生成并发模拟失败: {exc}"}), 500
    finally:
        conn.close()


@dispatch_bp.route("/simulation/tick", methods=["POST"])
def simulation_tick():
    """Advance a compact sandbox scenario quickly enough to be visible in a demo."""
    data = request.get_json() or {}
    step = max(1, min(int(data.get("step", 3)), 30))
    sandbox_note = "并发调度沙盘自动生成"
    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute("""
                SELECT o.order_id, o.volunteer_id, o.status, r.route_json
                FROM orders o JOIN dispatch_routes r ON r.order_id = o.order_id
                WHERE o.notes = %s AND o.status IN ('accepted', 'in_progress')
                ORDER BY o.order_id
            """, (sandbox_note,))
            active = cursor.fetchall()
            moved = started = completed = 0
            for row in active:
                order_id, volunteer_id = int(row["order_id"]), int(row["volunteer_id"])
                if row["status"] == "in_progress":
                    service_route = json.loads(row["route_json"])
                    service_ticks = int(service_route.get("service_ticks", 0)) + 1
                    if service_ticks < 4:
                        service_route["service_ticks"] = service_ticks
                        cursor.execute("UPDATE dispatch_routes SET route_json = %s, replanned_at = CURRENT_TIMESTAMP WHERE order_id = %s",
                                       (json.dumps(service_route, ensure_ascii=False), order_id))
                        _event(cursor, order_id, "simulation_service_progress", f"沙盘服务进行中：第{service_ticks}/3个可视化节拍。", {"service_ticks": service_ticks})
                        continue
                    cursor.execute("UPDATE orders SET status = 'completed' WHERE order_id = %s", (order_id,))
                    cursor.execute("UPDATE dispatch_orders SET dispatch_state = 'completed' WHERE order_id = %s", (order_id,))
                    _create_return_route(cursor, volunteer_id)
                    _record_completed_service_fatigue(cursor, volunteer_id, 1)
                    cursor.execute("UPDATE volunteer_location_state SET availability = 'returning' WHERE volunteer_id = %s", (volunteer_id,))
                    _event(cursor, order_id, "simulation_service_completed", "沙盘服务完成，志愿者进入返家/下一单自动匹配状态。")
                    completed += 1
                    continue
                route = json.loads(row["route_json"])
                path = route.get("path", [])
                if len(path) < 2:
                    continue
                progress = min(100, int(route.get("progress", 0)) + step)
                start, end = path[0], path[-1]
                ratio = progress / 100
                lng = start[0] + (end[0] - start[0]) * ratio
                lat = start[1] + (end[1] - start[1]) * ratio
                route["progress"] = progress
                cursor.execute("""UPDATE volunteer_location_state SET lng = %s, lat = %s, availability = %s,
                                  location_source = 'virtual', updated_at = CURRENT_TIMESTAMP WHERE volunteer_id = %s""",
                               (lng, lat, "serving" if progress >= 100 else "en_route", volunteer_id))
                cursor.execute("""UPDATE dispatch_routes SET route_json = %s, eta_minutes = %s,
                                  replanned_at = CURRENT_TIMESTAMP WHERE order_id = %s""",
                               (json.dumps(route, ensure_ascii=False), max(1, round(int(route["eta_minutes"]) * (100 - progress) / 100)), order_id))
                moved += 1
                if progress >= 100:
                    cursor.execute("UPDATE orders SET status = 'in_progress' WHERE order_id = %s", (order_id,))
                    cursor.execute("UPDATE dispatch_orders SET dispatch_state = 'serving' WHERE order_id = %s", (order_id,))
                    _event(cursor, order_id, "simulation_arrived", "沙盘志愿者沿路线到达，进入服务阶段。", {"progress": progress})
                    started += 1
            if completed:
                advance_dispatch(cursor)
            conn.commit()
            return jsonify({"code": 200, "message": "沙盘位置已推进", "data": {"moved": moved, "started": started, "completed": completed}})
    except Exception as exc:
        conn.rollback()
        return jsonify({"code": 500, "message": f"推进沙盘失败: {exc}"}), 500
    finally:
        conn.close()


@dispatch_bp.route("/simulation/reset", methods=["POST"])
def simulation_reset():
    """Remove only orders created by the admin dispatch sandbox, never real requests."""
    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute("""
                SELECT order_id, volunteer_id FROM orders
                WHERE notes = '并发调度沙盘自动生成'
            """)
            rows = cursor.fetchall()
            volunteer_ids = {int(row["volunteer_id"]) for row in rows if row.get("volunteer_id")}
            order_ids = [int(row["order_id"]) for row in rows]
            if order_ids:
                cursor.execute("DELETE FROM orders WHERE notes = '并发调度沙盘自动生成'")
            for volunteer_id in volunteer_ids:
                cursor.execute("""UPDATE volunteer_location_state SET availability = 'idle',
                                  updated_at = CURRENT_TIMESTAMP WHERE volunteer_id = %s""", (volunteer_id,))
            cursor.execute("SELECT volunteer_id FROM volunteer_location_state ORDER BY volunteer_id LIMIT 8")
            demo_roster = [int(row["volunteer_id"]) for row in cursor.fetchall()]
            if demo_roster:
                cursor.execute("UPDATE volunteer_location_state SET availability = 'offline' WHERE volunteer_id NOT IN %s", (tuple(demo_roster),))
            cursor.execute("DELETE FROM dispatch_events WHERE event_type IN ('simulation_burst', 'simulation_sos')")
            _event(cursor, None, "simulation_reset", f"已重置{len(order_ids)}个沙盘订单；真实订单未受影响。")
            conn.commit()
            return jsonify({"code": 200, "message": "沙盘订单已重置，真实订单未改动", "data": {"removed": len(order_ids)}})
    except Exception as exc:
        conn.rollback()
        return jsonify({"code": 500, "message": f"重置沙盘失败: {exc}"}), 500
    finally:
        conn.close()
