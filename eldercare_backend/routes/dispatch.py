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
    amap_web_key,
    canonicalize_active_adcode,
    enrich_missing_polygons,
    ensure_region_columns,
    fetch_district_children,
    fetch_district_detail,
    geocode_address,
    is_active_region,
    refresh_runtime_catalog,
    reverse_geocode,
    resolve_region_adcode,
    upsert_region,
)


dispatch_bp = Blueprint("dispatch", __name__)

# Built-in demo districts (seed only). Runtime catalog is reloaded from DB and
# prefers official AMap polygons when available.
SEED_REGIONS: dict[str, dict[str, Any]] = {
    "310113": {
        "name": "宝山区", "city": "上海市", "province": "上海市", "level": "district",
        "bounds": {"west": 121.405, "east": 121.535, "south": 31.325, "north": 31.455},
        "center": (121.458, 31.382), "polygons": [],
    },
    "310115": {
        "name": "浦东新区", "city": "上海市", "province": "上海市", "level": "district",
        "bounds": {"west": 121.500, "east": 121.700, "south": 31.120, "north": 31.320},
        "center": (121.572, 31.218), "polygons": [],
    },
    "110105": {
        "name": "朝阳区", "city": "北京市", "province": "北京市", "level": "district",
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
FALLBACK_REFRESH_SECONDS = 30
EXCELLENT_RATING_MIN = 4.0
PRIORITY_SOS = 0
PRIORITY_ESCALATED = 1
PRIORITY_NORMAL = 2
_advance_lock = threading.Lock()
_last_advance_at = 0.0

SERVICE_CATALOG = {
    "陪同就医": {"label": "陪同就医", "skills": ["medical_support"], "hours": 2, "urgent": False},
    "陪同复诊": {"label": "陪同复诊", "skills": ["medical_support"], "hours": 2, "urgent": False},
    "代买药品": {"label": "代买药品", "skills": ["medical_support", "errand"], "hours": 1, "urgent": False},
    "代购物资": {"label": "代购物资", "skills": ["errand"], "hours": 1, "urgent": False},
    "代买物资": {"label": "代购物资", "skills": ["errand"], "hours": 1, "urgent": False},  # family UI alias
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

# Family/legacy aliases keep working for create APIs, but must not appear twice in UI lists.
_SERVICE_CATALOG_UI_SKIP = {"代买物资"}


def _public_service_catalog() -> list[dict[str, Any]]:
    return [
        {
            "code": code,
            **item,
            "skill_labels": [SKILL_LABELS[tag] for tag in item["skills"]],
        }
        for code, item in SERVICE_CATALOG.items()
        if code not in _SERVICE_CATALOG_UI_SKIP
    ]


def _normalize_required_skills(
    selected: list[str] | None,
    fallback: list[str],
    *,
    urgent: bool = False,
) -> list[str]:
    """Elder/admin may pick volunteer skill tags; SOS always keeps emergency_response."""
    cleaned: list[str] = []
    for tag in selected or []:
        code = str(tag).strip()
        if code in SKILL_LABELS and code not in cleaned:
            cleaned.append(code)
    if not cleaned:
        cleaned = [tag for tag in fallback if tag in SKILL_LABELS] or list(fallback)
    if urgent and "emergency_response" not in cleaned:
        cleaned.insert(0, "emergency_response")
    return cleaned


def _now() -> dt.datetime:
    # openGauss in the project Docker container stores its TIMESTAMP values in
    # UTC.  Using the Windows local (Asia/Shanghai) clock here made every
    # route appear eight hours old on the next refresh, completing a newly
    # created return route immediately and sending the next task from home.
    # Keep all persisted journey arithmetic on the same naive UTC timeline.
    return dt.datetime.now(dt.timezone.utc).replace(tzinfo=None)


def _shanghai_now() -> dt.datetime:
    """Wall-clock in Asia/Shanghai as naive local time (no tzinfo).

    Must stay naive: service_time from the UI/DB is naive, and comparing
    aware vs naive raises TypeError and aborts order creation.
    """
    return (
        dt.datetime.now(dt.timezone.utc)
        .astimezone(dt.timezone(dt.timedelta(hours=8)))
        .replace(tzinfo=None)
    )


def _ensure_naive(value: Any) -> dt.datetime | None:
    """Normalize DB/driver datetimes to naive for safe comparisons."""
    if not isinstance(value, dt.datetime):
        return None
    if value.tzinfo is not None:
        return value.astimezone(dt.timezone.utc).replace(tzinfo=None)
    return value


def _iso(value: Any) -> str | None:
    """Format timestamps for the UI in Asia/Shanghai (UTC+8).

    Journey math still uses naive UTC via `_now()`; only the displayed string
    is shifted so volunteers/admins see the same local clock they expect.
    """
    if isinstance(value, dt.datetime):
        aware = value.replace(tzinfo=dt.timezone.utc) if value.tzinfo is None else value.astimezone(dt.timezone.utc)
        local = aware.astimezone(dt.timezone(dt.timedelta(hours=8)))
        return local.strftime("%Y-%m-%d %H:%M:%S")
    if isinstance(value, dt.date):
        return value.isoformat()
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
    # Keep full precision here. `_distance_km` is rounded for UI display, and
    # rounding every short polyline segment made the simulated vehicle pause
    # on zero-length segments and then jump across the next non-zero segment.
    lengths = []
    for a, b in zip(points, points[1:]):
        mean_lat = math.radians((a[1] + b[1]) / 2)
        lat_km = (b[1] - a[1]) * 111.0
        lng_km = (b[0] - a[0]) * 111.0 * math.cos(mean_lat)
        lengths.append(math.hypot(lat_km, lng_km))
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


def _journey_stamp(value: dt.datetime | None = None) -> str:
    """Naive UTC stamp for journey hand-off math (never use display `_iso` here)."""
    stamp = value or _now()
    if stamp.tzinfo is not None:
        stamp = stamp.astimezone(dt.timezone.utc).replace(tzinfo=None)
    return stamp.strftime("%Y-%m-%d %H:%M:%S")


def _parse_journey_stamp(raw: Any) -> dt.datetime | None:
    if isinstance(raw, dt.datetime):
        return raw.replace(tzinfo=None) if raw.tzinfo is None else raw.astimezone(dt.timezone.utc).replace(tzinfo=None)
    text = str(raw or "").strip()
    if not text:
        return None
    try:
        stamped = dt.datetime.fromisoformat(text.replace("Z", ""))
    except (TypeError, ValueError):
        return None
    if stamped.tzinfo is not None:
        stamped = stamped.astimezone(dt.timezone.utc).replace(tzinfo=None)
    # A prior bug stored Asia/Shanghai display strings via `_iso`. Those read as
    # ~8 hours in the future against UTC `_now()` and permanently blocked
    # returning→idle / en_route→serving. Treat clearly-future stamps as Shanghai.
    if (stamped - _now()).total_seconds() > 60:
        stamped = stamped - dt.timedelta(hours=8)
    return stamped


def _arrival_visual_ready(route: dict[str, Any], grace_seconds: float = 1.0) -> bool:
    """Give every portal time to animate the final road segment before state changes.

    Without this one-second persisted hand-off, the request that advances a route to
    100% also changes it to ``serving`` (or deletes a return route).  The map
    receives only the final state and appears to teleport the volunteer.
    """
    pending_since = route.get("arrival_pending_since")
    if not pending_since:
        route["arrival_pending_since"] = _journey_stamp()
        return False
    stamped = _parse_journey_stamp(pending_since)
    if stamped is None:
        route["arrival_pending_since"] = _journey_stamp()
        return False
    # Rewrite any recovered Shanghai stamp so later ticks stay on UTC.
    route["arrival_pending_since"] = _journey_stamp(stamped)
    return (_now() - stamped).total_seconds() >= grace_seconds


def route_endpoints(start_lng: float, start_lat: float, end_lng: float, end_lat: float, version: int) -> dict[str, Any]:
    """Return route endpoints only; AMap.Driving renders the real road path."""
    distance = _distance_km(start_lng, start_lat, end_lng, end_lat)
    eta_minutes = max(2, round(distance / 28 * 60))
    return {
        "path": [[round(start_lng, 6), round(start_lat, 6)], [round(end_lng, 6), round(end_lat, 6)]],
        "eta_minutes": eta_minutes, "distance_km": distance, "traffic_version": version,
        "motion_seconds": _demo_motion_seconds(eta_minutes),
        "route_provider": "amap_web_driving",
        "navigation_mode": "driving",
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
            _add_column_if_missing(cursor, "emergency_incidents", "assigned_admin_id", "INT NULL REFERENCES users(user_id) ON DELETE SET NULL")
            _add_column_if_missing(cursor, "emergency_incidents", "service_address", "TEXT NULL")
            _add_column_if_missing(cursor, "emergency_incidents", "service_lng", "NUMERIC(10,6)")
            _add_column_if_missing(cursor, "emergency_incidents", "service_lat", "NUMERIC(10,6)")
            _add_column_if_missing(cursor, "emergency_incidents", "location_mode", "VARCHAR(16)")
            cursor.execute("CREATE INDEX IF NOT EXISTS idx_alerts_emergency_incident ON alerts(emergency_incident_id)")
            # These tables are referenced by the legacy-data cleanup below, so
            # create them first when upgrading an existing pre-dispatch volume.
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
            _ensure_column(cursor, "conversations", "upgraded_to_sos", "BOOLEAN NOT NULL DEFAULT FALSE")
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS conversation_members (
                    conversation_id INT NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
                    user_id INT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
                    role_in_conversation VARCHAR(24) NOT NULL,
                    last_read_at TIMESTAMP NULL,
                    PRIMARY KEY (conversation_id, user_id)
                )
            """)
            _ensure_column(cursor, "conversation_members", "can_speak", "BOOLEAN NOT NULL DEFAULT TRUE")
            _ensure_column(cursor, "conversation_members", "hidden_at", "TIMESTAMP NULL")
            # Backfill desk owner for open SOS, then prune extra district admins so
            # load-balancing is exclusive (one district desk owner per incident).
            cursor.execute(
                """
                UPDATE emergency_incidents ei
                   SET assigned_admin_id = (
                       SELECT en.recipient_user_id
                       FROM emergency_notifications en
                       JOIN users u ON u.user_id = en.recipient_user_id AND u.role = 'admin'
                       JOIN admin_region_scope ars
                         ON ars.admin_user_id = en.recipient_user_id
                        AND ars.region_adcode = ei.region_adcode
                       WHERE en.incident_id = ei.incident_id
                       ORDER BY en.recipient_user_id ASC
                       LIMIT 1
                   )
                 WHERE ei.assigned_admin_id IS NULL
                   AND COALESCE(ei.status, 'reported') <> 'resolved'
                """
            )
            cursor.execute(
                """
                DELETE FROM emergency_notifications en
                 USING emergency_incidents ei, users u
                 WHERE en.incident_id = ei.incident_id
                   AND en.recipient_user_id = u.user_id
                   AND u.role = 'admin'
                   AND ei.assigned_admin_id IS NOT NULL
                   AND en.recipient_user_id <> ei.assigned_admin_id
                   AND NOT EXISTS (
                       SELECT 1 FROM admin_region_scope root
                        WHERE root.admin_user_id = u.user_id AND root.region_adcode = '*'
                   )
                """
            )
            cursor.execute(
                """
                DELETE FROM conversation_members cm
                 USING conversations c, emergency_incidents ei, users u
                 WHERE cm.conversation_id = c.conversation_id
                   AND c.incident_id = ei.incident_id
                   AND c.conversation_type = 'sos'
                   AND cm.user_id = u.user_id
                   AND u.role = 'admin'
                   AND ei.assigned_admin_id IS NOT NULL
                   AND cm.user_id <> ei.assigned_admin_id
                   AND COALESCE(ei.status, 'reported') <> 'resolved'
                   AND NOT EXISTS (
                       SELECT 1 FROM admin_region_scope root
                        WHERE root.admin_user_id = u.user_id AND root.region_adcode = '*'
                   )
                """
            )
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
                CREATE TABLE IF NOT EXISTS donation_records (
                    donation_id SERIAL PRIMARY KEY,
                    donor_name VARCHAR(80) NOT NULL,
                    contact VARCHAR(120),
                    amount NUMERIC(10,2) NOT NULL CHECK (amount > 0),
                    payment_method VARCHAR(20) NOT NULL
                        CHECK (payment_method IN ('wechat', 'alipay')),
                    payment_status VARCHAR(20) NOT NULL DEFAULT 'success',
                    transaction_no VARCHAR(64) NOT NULL UNIQUE,
                    message VARCHAR(500),
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
                CREATE TABLE IF NOT EXISTS elder_addresses (
                    address_id SERIAL PRIMARY KEY,
                    elder_id INT NOT NULL REFERENCES elders(elder_id) ON DELETE CASCADE,
                    label VARCHAR(40) NOT NULL DEFAULT '家',
                    province_name VARCHAR(80) NOT NULL,
                    city_name VARCHAR(80) NOT NULL,
                    district_name VARCHAR(80) NOT NULL,
                    region_adcode VARCHAR(12) NOT NULL,
                    detail_address VARCHAR(255) NOT NULL,
                    full_address VARCHAR(500) NOT NULL,
                    lng NUMERIC(10,6) NOT NULL,
                    lat NUMERIC(10,6) NOT NULL,
                    is_current BOOLEAN NOT NULL DEFAULT FALSE,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE (elder_id, full_address)
                )
            """)
            cursor.execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS uq_elder_current_address "
                "ON elder_addresses(elder_id) WHERE is_current = TRUE"
            )
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
            _ensure_column(cursor, "orders", "service_lng", "NUMERIC(10,6)")
            _ensure_column(cursor, "orders", "service_lat", "NUMERIC(10,6)")
            _ensure_column(cursor, "orders", "proxy_created_by", "INT NULL")
            _ensure_column(cursor, "orders", "proxy_reason", "TEXT NULL")
            _ensure_column(cursor, "dispatch_orders", "region_adcode", "VARCHAR(12) NOT NULL DEFAULT '310113'")
            _ensure_column(cursor, "dispatch_orders", "dispatch_phase", "VARCHAR(24) NOT NULL DEFAULT 'top1'")
            _ensure_column(cursor, "dispatch_orders", "phase_started_at", "TIMESTAMP NULL")
            _ensure_column(cursor, "dispatch_orders", "phase_expires_at", "TIMESTAMP NULL")
            _ensure_column(cursor, "dispatch_orders", "dispatch_version", "INT NOT NULL DEFAULT 1")
            _ensure_column(cursor, "dispatch_orders", "priority_tier", f"INT NOT NULL DEFAULT {PRIORITY_NORMAL}")
            _ensure_column(cursor, "dispatch_orders", "last_expanded_at", "TIMESTAMP NULL")
            # Replace legacy fictional seed labels with public, map-searchable
            # Baoshan service points without touching user-edited addresses.
            seed_address_replacements = {
                "幸福小区1栋301室": "上海市宝山区锦秋路699弄112号1号楼101室",
                "阳光花园3栋502室": "上海市宝山区殷高路21弄5号1号楼102室",
                "和平路18号院2单元": "上海市宝山区新二路183弄57号1号楼103室",
                "翠苑小区5栋101室": "上海市宝山区国权北路828弄139号1号楼104室",
                "银杏苑7栋203室": "上海市宝山区盘古路528号1号楼201室",
            }
            for old_address, real_address in seed_address_replacements.items():
                cursor.execute(
                    "UPDATE elders SET address = %s WHERE address = %s",
                    (real_address, old_address),
                )
                cursor.execute(
                    "UPDATE orders SET address = %s WHERE address = %s",
                    (real_address, old_address),
                )
            cursor.execute("""
                INSERT INTO elder_addresses
                    (elder_id, label, province_name, city_name, district_name,
                     region_adcode, detail_address, full_address, lng, lat, is_current)
                SELECT e.elder_id, '家',
                       COALESCE(ar.province_name, '上海市'),
                       COALESCE(ar.city_name, '上海市'),
                       COALESCE(ar.name, '宝山区'),
                       e.region_adcode, e.address, e.address,
                       loc.lng, loc.lat, TRUE
                FROM elders e
                JOIN elder_location_state loc ON loc.elder_id = e.elder_id
                LEFT JOIN administrative_regions ar ON ar.adcode = e.region_adcode
                WHERE NOT EXISTS (
                    SELECT 1 FROM elder_addresses ea WHERE ea.elder_id = e.elder_id
                )
            """)
            # Older demo records stopped at a community/building address. Give
            # every elder a deterministic room number so upgraded and fresh
            # databases show the same complete address throughout the product.
            cursor.execute("""
                SELECT elder_id, address
                FROM elders
                WHERE address IS NOT NULL AND address <> ''
                ORDER BY elder_id
            """)
            for elder_address_row in cursor.fetchall():
                elder_id = int(elder_address_row["elder_id"])
                current_address = str(elder_address_row["address"])
                if "室" in current_address:
                    continue
                building_no = ((elder_id - 1) // 8) % 12 + 1
                floor_no = ((elder_id - 1) // 4) % 18 + 1
                door_no = (elder_id - 1) % 4 + 1
                room_suffix = f"{building_no}号楼{floor_no * 100 + door_no}室"
                completed_address = f"{current_address}{room_suffix}"
                cursor.execute(
                    "UPDATE elders SET address = %s WHERE elder_id = %s",
                    (completed_address, elder_id),
                )
                cursor.execute(
                    """
                    UPDATE elder_addresses
                    SET detail_address = CASE
                            WHEN detail_address IS NULL OR detail_address = '' THEN %s
                            WHEN POSITION('室' IN detail_address) = 0
                                THEN detail_address || %s
                            ELSE detail_address
                        END,
                        full_address = CASE
                            WHEN POSITION('室' IN full_address) = 0
                                THEN full_address || %s
                            ELSE full_address
                        END
                    WHERE elder_id = %s AND is_current = TRUE
                    """,
                    (completed_address, room_suffix, room_suffix, elder_id),
                )
                cursor.execute(
                    """
                    UPDATE orders
                    SET address = address || %s
                    WHERE elder_id = %s
                      AND address IS NOT NULL
                      AND POSITION('室' IN address) = 0
                    """,
                    (room_suffix, elder_id),
                )

            # Complete any saved non-current addresses too. Their coordinates
            # remain unchanged because apartment numbers do not affect the map
            # anchor for the building/community.
            cursor.execute("""
                SELECT address_id, elder_id, detail_address, full_address
                FROM elder_addresses
                ORDER BY address_id
            """)
            for saved_address_row in cursor.fetchall():
                address_id = int(saved_address_row["address_id"])
                elder_id = int(saved_address_row["elder_id"])
                detail_address = saved_address_row.get("detail_address")
                full_address = saved_address_row.get("full_address")
                if not full_address or "室" in full_address:
                    continue
                building_no = ((elder_id - 1) // 8) % 12 + 1
                floor_no = ((address_id - 1) // 4) % 18 + 1
                door_no = (address_id - 1) % 4 + 1
                room_suffix = f"{building_no}号楼{floor_no * 100 + door_no}室"
                completed_detail = str(detail_address or full_address)
                if "室" not in completed_detail:
                    completed_detail = f"{completed_detail}{room_suffix}"
                cursor.execute(
                    """
                    UPDATE elder_addresses
                    SET detail_address = %s,
                        full_address = %s
                    WHERE address_id = %s
                    """,
                    (completed_detail, f"{full_address}{room_suffix}", address_id),
                )
            cursor.execute("""UPDATE dispatch_orders SET dispatch_phase = COALESCE(dispatch_phase, 'top1'),
                              phase_started_at = COALESCE(phase_started_at, created_at, CURRENT_TIMESTAMP),
                              dispatch_version = COALESCE(dispatch_version, 1),
                              priority_tier = COALESCE(priority_tier, CASE WHEN urgency = 'sos' THEN 0 ELSE 2 END),
                              last_expanded_at = COALESCE(last_expanded_at, phase_started_at, created_at, CURRENT_TIMESTAMP)""")
            # Version 2 measures completed work rather than accepting a card.
            # Clear only the inherited counters once so historical demo clicks
            # do not bias today's new dispatch ranking.
            cursor.execute("SELECT state_key FROM dispatch_system_state WHERE state_key = 'fatigue_model_v2_initialized'")
            if not cursor.fetchone():
                cursor.execute("""UPDATE volunteer_location_state
                                  SET fatigue_score = 0, assigned_today = 0, fatigue_updated_at = CURRENT_TIMESTAMP""")
                cursor.execute("INSERT INTO dispatch_system_state (state_key, state_value) VALUES ('fatigue_model_v2_initialized', '1')")
            # Historical init_demo_data.sql left some orders stuck in
            # accepted/in_progress while the volunteer location stayed idle.
            # Those rows permanently exclude the volunteer from Top1–Top10.
            cursor.execute("SELECT state_key FROM dispatch_system_state WHERE state_key = 'stale_seed_orders_cleared_v1'")
            if not cursor.fetchone():
                cursor.execute("""
                    UPDATE orders o
                    SET status = 'completed'
                    FROM volunteer_location_state p
                    WHERE o.volunteer_id = p.volunteer_id
                      AND o.status IN ('accepted', 'in_progress')
                      AND p.availability = 'idle'
                      AND NOT EXISTS (
                          SELECT 1 FROM dispatch_routes r
                          WHERE r.order_id = o.order_id AND r.volunteer_id = o.volunteer_id
                      )
                """)
                cursor.execute(
                    "INSERT INTO dispatch_system_state (state_key, state_value) VALUES ('stale_seed_orders_cleared_v1', '1')"
                )
            # init_demo_data.sql April 2026 rows (pending/accepted/in_progress) are
            # not intelligent-dispatch orders.  Left alone they can occupy volunteers
            # or appear as stale hall traffic; neutralize once.
            cursor.execute("SELECT state_key FROM dispatch_system_state WHERE state_key = 'april_demo_seed_orders_cleared_v1'")
            if not cursor.fetchone():
                cursor.execute(
                    """
                    UPDATE orders
                    SET status = 'cancelled',
                        notes = COALESCE(notes, '') || ' [已归档：历史演示种子单，不影响现网调度]'
                    WHERE status IN ('pending', 'accepted', 'in_progress')
                      AND created_at < TIMESTAMP '2026-05-01 00:00:00'
                      AND NOT EXISTS (
                          SELECT 1 FROM dispatch_orders d WHERE d.order_id = orders.order_id
                      )
                    """
                )
                cursor.execute(
                    "INSERT INTO dispatch_system_state (state_key, state_value) VALUES ('april_demo_seed_orders_cleared_v1', '1')"
                )
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
                                      (adcode, name, city_name, province_name, region_level, bounds_json, active)
                                      VALUES (%s, %s, %s, %s, %s, %s, TRUE)""",
                                   (adcode, region["name"], region["city"], region.get("province") or region["city"],
                                    region["level"], json.dumps(region["bounds"])))
                else:
                    # Keep seed districts under the correct province/city tree even if
                    # an earlier AMap enrich wrote blank province / district-as-city.
                    cursor.execute(
                        """UPDATE administrative_regions
                           SET name = %s, city_name = %s, province_name = %s, region_level = %s
                           WHERE adcode = %s""",
                        (region["name"], region["city"], region.get("province") or region["city"],
                         region["level"], adcode),
                    )
            # Repair any active districts that still lack province/city hierarchy.
            cursor.execute(
                """SELECT adcode, name, city_name, province_name FROM administrative_regions
                   WHERE active = TRUE AND (province_name IS NULL OR province_name = ''
                         OR city_name IS NULL OR city_name = '' OR city_name = name)"""
            )
            from region_service import infer_province_city
            for row in cursor.fetchall():
                province, city = infer_province_city(str(row["adcode"]), str(row.get("name") or ""))
                if not province and not city:
                    continue
                cursor.execute(
                    """UPDATE administrative_regions
                       SET province_name = CASE WHEN province_name IS NULL OR province_name = '' THEN %s ELSE province_name END,
                           city_name = CASE WHEN city_name IS NULL OR city_name = '' OR city_name = name THEN %s ELSE city_name END
                       WHERE adcode = %s""",
                    (province or row.get("province_name") or "", city or row.get("city_name") or "", row["adcode"]),
                )
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
    """Idempotently backfill the SQL-defined Baoshan demo into legacy volumes.

    Fresh databases receive every account and profile from init_demo_data.sql.
    This routine remains only so an existing volume can be upgraded safely.
    """
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
    # Publicly listed Baoshan communities/buildings. Demo elders reuse real
    # map-searchable service points instead of invented road names.
    baoshan_demo_addresses = [
        "上海市宝山区锦秋路699弄",
        "上海市宝山区纬地路88弄",
        "上海市宝山区聚丰园路628弄",
        "上海市宝山区真金路1039弄",
        "上海市宝山区华灵路1885弄",
        "上海市宝山区殷高路21弄",
        "上海市宝山区高境路477弄",
        "上海市宝山区新二路999弄",
        "上海市宝山区逸仙路1321弄",
        "上海市宝山区三门路489弄",
        "上海市宝山区国权北路828弄",
        "上海市宝山区盘古路528号",
    ]

    def _demo_room_address(base_address: str, serial: int) -> str:
        if "室" in base_address:
            return base_address
        building_no = ((serial - 1) // 8) % 12 + 1
        floor_no = ((serial - 1) // 4) % 18 + 1
        door_no = (serial - 1) % 4 + 1
        return f"{base_address}{building_no}号楼{floor_no * 100 + door_no}室"
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
                """, (
                    user_id,
                    name,
                    68 + index % 22,
                    "女" if index % 2 else "男",
                    _demo_room_address(
                        baoshan_demo_addresses[(index - 1) % len(baoshan_demo_addresses)],
                        index,
                    ),
                ))
                elder_ids.append(int(cursor.fetchone()["elder_id"]))
            elder_ids = elder_ids[:25]
            for index, elder_id in enumerate(elder_ids):
                ring = 0 if index < 12 else 1 if index < 20 else 2
                lng, lat = _demo_point(index + 5, ring)
                location_source = "simulated"
                cursor.execute(
                    "SELECT elder_id, location_source FROM elder_location_state WHERE elder_id = %s",
                    (elder_id,),
                )
                existing_location = cursor.fetchone()
                # The five named seed elders use their real public address as
                # the coordinate source. Geocoding is best-effort so a missing
                # Web Key or temporary AMap outage can never block startup.
                if (
                    index < 5
                    and amap_web_key()
                    and (
                        not existing_location
                        or str(existing_location.get("location_source") or "simulated") in ("simulated", "hidden_demo")
                    )
                ):
                    cursor.execute("SELECT address, region_adcode FROM elders WHERE elder_id = %s", (elder_id,))
                    named_elder = cursor.fetchone() or {}
                    try:
                        resolved = geocode_address(
                            str(named_elder.get("address") or ""),
                            str(named_elder.get("region_adcode") or DEFAULT_REGION_ADCODE),
                        )
                        if str(resolved.get("adcode") or "") == str(named_elder.get("region_adcode") or DEFAULT_REGION_ADCODE):
                            lng, lat = float(resolved["lng"]), float(resolved["lat"])
                            location_source = "amap_geocode"
                    except Exception as exc:  # noqa: BLE001
                        print(f"seed elder address geocode skipped for {elder_id}: {exc}")
                if not existing_location:
                    cursor.execute(
                        """INSERT INTO elder_location_state
                           (elder_id, lng, lat, location_source, is_home_fixed)
                           VALUES (%s, %s, %s, %s, TRUE)""",
                        (elder_id, lng, lat, location_source),
                    )
                else:
                    cursor.execute(
                        """UPDATE elder_location_state
                           SET lng = %s, lat = %s, location_source = %s,
                               is_home_fixed = TRUE, updated_at = CURRENT_TIMESTAMP
                           WHERE elder_id = %s
                             AND location_source IN ('simulated', 'hidden_demo')""",
                        (lng, lat, location_source, elder_id),
                    )
                cursor.execute("SELECT address, region_adcode FROM elders WHERE elder_id = %s", (elder_id,))
                elder_row = cursor.fetchone() or {}
                if "友邻路" in str(elder_row.get("address") or ""):
                    replacement = _demo_room_address(
                        baoshan_demo_addresses[index % len(baoshan_demo_addresses)],
                        index + 1,
                    )
                    cursor.execute("UPDATE elders SET address = %s WHERE elder_id = %s", (replacement, elder_id))
                    cursor.execute(
                        """UPDATE elder_addresses
                           SET detail_address = %s, full_address = %s
                           WHERE elder_id = %s""",
                        (replacement, replacement, elder_id),
                    )
                    elder_row["address"] = replacement
                if location_source == "amap_geocode":
                    cursor.execute(
                        """UPDATE elder_addresses
                           SET lng = %s, lat = %s
                           WHERE elder_id = %s AND is_current = TRUE""",
                        (lng, lat, elder_id),
                    )
                cursor.execute("SELECT 1 FROM elder_addresses WHERE elder_id = %s", (elder_id,))
                if not cursor.fetchone():
                    address = str(elder_row.get("address") or "上海市宝山区")
                    cursor.execute(
                        """INSERT INTO elder_addresses
                           (elder_id, label, province_name, city_name, district_name,
                            region_adcode, detail_address, full_address, lng, lat, is_current)
                           VALUES (%s, '家', '上海市', '上海市', '宝山区',
                                   %s, %s, %s, %s, %s, TRUE)""",
                        (
                            elder_id,
                            str(elder_row.get("region_adcode") or DEFAULT_REGION_ADCODE),
                            address,
                            address,
                            lng,
                            lat,
                        ),
                    )
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
    """Idempotently backfill the SQL-defined regional demos into legacy volumes."""
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
                ("浦东张阿姨", "上海市浦东新区张江路665号1号楼101室"),
                ("浦东陈伯伯", "上海市浦东新区祖冲之路2305号1号楼102室"),
                ("浦东李奶奶", "上海市浦东新区金科路2889号1号楼103室"),
                ("浦东王大爷", "上海市浦东新区世纪大道100号1号楼104室"),
                ("浦东周阿姨", "上海市浦东新区杨高南路729号1号楼201室"),
                ("浦东孙爷爷", "上海市浦东新区浦东南路1111号1号楼202室"),
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
                ("朝阳赵阿姨", "北京市朝阳区望京街10号1号楼101室"),
                ("朝阳刘伯伯", "北京市朝阳区阜通东大街6号1号楼102室"),
                ("朝阳孙奶奶", "北京市朝阳区朝阳北路101号1号楼103室"),
                ("朝阳吴大爷", "北京市朝阳区建国路93号1号楼104室"),
                ("朝阳钱阿姨", "北京市朝阳区酒仙桥路10号1号楼201室"),
                ("朝阳冯爷爷", "北京市朝阳区北苑路170号1号楼202室"),
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
                                          VALUES (%s, %s, %s, %s, %s, %s, 'idle', %s, %s, 0, FALSE)""",
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
                    region_info = REGION_CATALOG.get(region_adcode) or {}
                    province_name = str(region_info.get("province_name") or ("北京市" if region_adcode.startswith("11") else "上海市"))
                    city_name = str(region_info.get("city_name") or province_name)
                    district_name = str(region_info.get("name") or scenario["prefix"])
                    cursor.execute(
                        "SELECT address_id FROM elder_addresses WHERE elder_id = %s AND is_current = TRUE",
                        (elder_id,),
                    )
                    current_address = cursor.fetchone()
                    if current_address:
                        cursor.execute(
                            """
                            UPDATE elder_addresses
                            SET province_name = %s, city_name = %s, district_name = %s,
                                region_adcode = %s, detail_address = %s, full_address = %s,
                                lng = %s, lat = %s
                            WHERE address_id = %s
                            """,
                            (
                                province_name,
                                city_name,
                                district_name,
                                region_adcode,
                                address,
                                address,
                                lng,
                                lat,
                                current_address["address_id"],
                            ),
                        )
                    else:
                        cursor.execute(
                            """
                            INSERT INTO elder_addresses
                                (elder_id, label, province_name, city_name, district_name,
                                 region_adcode, detail_address, full_address, lng, lat, is_current)
                            VALUES (%s, '家', %s, %s, %s, %s, %s, %s, %s, %s, TRUE)
                            """,
                            (
                                elder_id,
                                province_name,
                                city_name,
                                district_name,
                                region_adcode,
                                address,
                                address,
                                lng,
                                lat,
                            ),
                        )
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


def _volunteer_current_region(lng: Any, lat: Any) -> str | None:
    """District used for grab/match: where the volunteer is standing now."""
    return _region_for_point(lng, lat)


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
        raise ValueError("该管理员已绑定当前区县，请勿重复绑定")
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

    raise ValueError("区域管理不再新建管理员，请先准备已有管理员账号后再绑定")


def _valid_baoshan_point(lng: Any, lat: Any) -> tuple[float, float] | None:
    """Backward-compatible helper for the existing Baoshan-only sandbox APIs."""
    return _valid_region_point(lng, lat, DEFAULT_REGION_ADCODE)


def _location_source(value: Any) -> str:
    allowed = {
        "fixed_home",
        "browser_gps",
        "browser_live",
        "virtual",
        "simulated",
        "address_book",
        "amap_geocode",
        "home_default",
    }
    text = str(value or "").strip()
    if text == "browser_live":
        return "browser_gps"
    return text if text in allowed else "virtual"


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
    progress = max(0.0, min(100.0, float(route.get("progress") or 0)))
    remaining_ratio = (100.0 - progress) / 100.0
    base_distance = max(0.0, float(route.get("distance_km") or 0))
    base_eta = max(0, int(route.get("eta_minutes") or row["eta_minutes"] or 0))
    remaining_distance = round(base_distance * remaining_ratio, 3)
    remaining_eta = 0 if progress >= 100 else max(1, int(math.ceil(base_eta * remaining_ratio)))
    # Route JSON contains the original planning ETA. Put live fields after it
    # so a stale value cannot overwrite what elder/family tracking displays.
    result = {
        **route,
        "order_id": order_id,
        "volunteer_id": int(row["volunteer_id"]),
        "eta_minutes": remaining_eta,
        "remaining_eta_minutes": remaining_eta,
        "remaining_distance_km": remaining_distance,
        "traffic_version": int(row["traffic_version"]),
        "replanned_at": _iso(row["replanned_at"]),
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
    progress = max(0.0, min(100.0, float(route.get("progress") or 0)))
    remaining_ratio = (100.0 - progress) / 100.0
    base_distance = max(0.0, float(route.get("distance_km") or 0))
    base_eta = max(0, int(route.get("eta_minutes") or row["eta_minutes"] or 0))
    remaining_distance = round(base_distance * remaining_ratio, 3)
    remaining_eta = 0 if progress >= 100 else max(1, int(math.ceil(base_eta * remaining_ratio)))
    return {
        **route,
        "order_id": -int(volunteer_id),
        "volunteer_id": int(volunteer_id),
        "eta_minutes": remaining_eta,
        "remaining_eta_minutes": remaining_eta,
        "remaining_distance_km": remaining_distance,
        "traffic_version": int(row["traffic_version"]),
        "replanned_at": _iso(row["updated_at"]),
        "motion_rate": _route_motion_rate(route, RETURN_PROGRESS_PER_SECOND),
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
        SELECT o.order_id, o.elder_id, o.service_type, o.service_hours, o.service_time, o.status, o.volunteer_id,
               o.address, o.service_lng, o.service_lat,
               COALESCE(o.region_adcode, e.region_adcode, '310113') AS region_adcode,
               d.urgency, d.required_skills, d.dispatch_state, d.search_stage, d.dispatch_phase,
               d.phase_started_at, d.phase_expires_at, d.dispatch_version, d.last_expanded_at,
               d.priority_tier, d.forced_assignment, d.created_at, e.name AS elder_name,
               COALESCE(o.service_lng, el.lng) AS elder_lng,
               COALESCE(o.service_lat, el.lat) AS elder_lat
        FROM orders o
        JOIN dispatch_orders d ON d.order_id = o.order_id
        JOIN elders e ON e.elder_id = o.elder_id
        JOIN elder_location_state el ON el.elder_id = o.elder_id
        WHERE o.order_id = %s
    """, (order_id,))
    return cursor.fetchone()


SCHEDULE_IMMEDIATE_GRACE_SECONDS = 0


def _as_naive_shanghai(value: Any) -> dt.datetime | None:
    """Parse stored/posted service_time as Asia/Shanghai wall-clock (naive)."""
    if isinstance(value, dt.datetime):
        if value.tzinfo is not None:
            return value.astimezone(dt.timezone(dt.timedelta(hours=8))).replace(tzinfo=None)
        return value
    text = str(value or "").strip().replace("T", " ")
    if not text:
        return None
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"):
        try:
            return dt.datetime.strptime(text[:19] if fmt.endswith("%S") else text[:16], fmt)
        except ValueError:
            continue
    return None


def _appointment_is_future(service_time: Any) -> bool:
    when = _as_naive_shanghai(service_time)
    if not when:
        return False
    cutoff = _shanghai_now() + dt.timedelta(seconds=SCHEDULE_IMMEDIATE_GRACE_SECONDS)
    return when > cutoff


def _service_time_text(service_time: Any) -> str | None:
    """Format appointment wall-clock without applying a second UTC+8 shift."""
    when = _as_naive_shanghai(service_time)
    if when:
        return when.strftime("%Y-%m-%d %H:%M:%S")
    return str(service_time) if service_time is not None else None


def _park_order_as_scheduled(cursor: Any, order_id: int, service_time: Any) -> None:
    when = _as_naive_shanghai(service_time)
    label = when.strftime("%Y-%m-%d %H:%M") if when else "约定时间"
    cursor.execute(
        """UPDATE dispatch_orders
              SET dispatch_state = 'scheduled',
                  dispatch_phase = 'scheduled',
                  search_stage = 1,
                  phase_started_at = NULL,
                  phase_expires_at = NULL,
                  last_expanded_at = CURRENT_TIMESTAMP
            WHERE order_id = %s""",
        (order_id,),
    )
    cursor.execute(
        """UPDATE dispatch_candidates
              SET response_status = 'waiting', invited_at = NULL
            WHERE order_id = %s AND response_status = 'invited'""",
        (order_id,),
    )
    _event(
        cursor,
        order_id,
        "order_scheduled",
        f"已预约服务时间 {label}。到点后系统才会开始 Top1→Top3→Top10 找人。",
        {"service_time": label},
    )


def _activate_scheduled_order(cursor: Any, order: dict[str, Any]) -> None:
    """Appointment reached: open the normal Top1 window."""
    order_id = int(order["order_id"])
    cursor.execute(
        """UPDATE dispatch_orders
              SET dispatch_state = 'matching',
                  last_expanded_at = CURRENT_TIMESTAMP
            WHERE order_id = %s""",
        (order_id,),
    )
    order = _order_context(cursor, order_id) or order
    _set_dispatch_phase(cursor, order, "top1")
    order = _order_context(cursor, order_id) or order
    _upsert_candidates(cursor, order)
    if not _invite_candidates(cursor, order, "预约时间已到，开始找人"):
        cursor.execute(
            "UPDATE dispatch_orders SET dispatch_state = 'queued_waiting_capacity' WHERE order_id = %s",
            (order_id,),
        )
    _event(cursor, order_id, "scheduled_dispatch_started", "预约时间已到，已开始智能找人。")


def _mark_order_escalated_queue(cursor: Any, order_id: int) -> None:
    """Promote a normal pending order into P1 accelerated queue (no admin desk)."""
    cursor.execute(
        """UPDATE dispatch_orders
           SET dispatch_state = 'queued_waiting_capacity',
               priority_tier = LEAST(COALESCE(priority_tier, %s), %s),
               last_expanded_at = CURRENT_TIMESTAMP
           WHERE order_id = %s""",
        (PRIORITY_NORMAL, PRIORITY_ESCALATED, order_id),
    )


def _excellent_assign_candidates(cursor: Any, order_id: int, limit: int = 10) -> list[dict[str, Any]]:
    """Top N pool for SOS admin confirm: skill + auto_accept + idle/returning + rating.

    Always unique by volunteer_id (one person never appears twice).
    """
    cursor.execute(
        """
        SELECT c.volunteer_id, u.real_name AS volunteer_name, c.distance_km, c.eta_minutes,
               c.total_score, c.skill_match, c.candidate_rank, p.availability,
               p.auto_accept_enabled, p.service_rating
        FROM dispatch_candidates c
        JOIN users u ON u.user_id = c.volunteer_id
        JOIN volunteer_location_state p ON p.volunteer_id = c.volunteer_id
        WHERE c.order_id = %s AND c.eligible = TRUE
          AND p.auto_accept_enabled = TRUE
          AND p.availability IN ('idle', 'returning')
          AND p.service_rating >= %s
          AND NOT EXISTS (
              SELECT 1 FROM orders active
              WHERE active.volunteer_id = p.volunteer_id
                AND active.status IN ('accepted', 'in_progress')
          )
        ORDER BY c.candidate_rank ASC NULLS LAST, c.total_score DESC
        LIMIT %s
        """,
        (order_id, EXCELLENT_RATING_MIN, max(limit * 3, limit)),
    )
    seen: set[int] = set()
    unique: list[dict[str, Any]] = []
    for row in cursor.fetchall():
        vid = int(row["volunteer_id"])
        if vid in seen:
            continue
        seen.add(vid)
        unique.append({
            "volunteer_id": vid,
            "volunteer_name": row["volunteer_name"],
            "distance_km": float(row["distance_km"]) if row.get("distance_km") is not None else None,
            "eta_minutes": int(row["eta_minutes"]) if row.get("eta_minutes") is not None else None,
            "total_score": float(row["total_score"]) if row.get("total_score") is not None else None,
            "skill_match": row.get("skill_match"),
            "candidate_rank": int(row["candidate_rank"]) if row.get("candidate_rank") is not None else None,
            "availability": row.get("availability"),
            "auto_accept_enabled": bool(row.get("auto_accept_enabled")),
            "service_rating": float(row["service_rating"]) if row.get("service_rating") is not None else None,
        })
        if len(unique) >= limit:
            break
    return unique


def _split_recommended_alternates(candidates: list[dict[str, Any]]) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    """Top1 once; everyone else as alternates. Single-volunteer → alternates=[]."""
    if not candidates:
        return None, []
    return candidates[0], candidates[1:]


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
    order_region = str(order.get("region_adcode") or "")
    # Match by where the volunteer is standing now (opened district), not only
    # the registered service_region_adcode. Returning volunteers are projected
    # onto their live return polyline first so distance/ETA stay physical.
    cursor.execute("""SELECT volunteer_id FROM volunteer_location_state
                      WHERE availability = 'returning'""")
    for returning in cursor.fetchall():
        _materialize_return_position(cursor, int(returning["volunteer_id"]))
    cursor.execute("""
        SELECT p.volunteer_id, p.lng, p.lat, p.availability, p.fatigue_score,
               p.service_rating, p.assigned_today, p.auto_accept_enabled, u.real_name,
               COALESCE(string_agg(s.skill_tag, '|'), '') AS skill_tags_text
        FROM volunteer_location_state p
        JOIN users u ON u.user_id = p.volunteer_id
        JOIN volunteers_profile vp
          ON vp.user_id = p.volunteer_id AND vp.audit_status = 'approved'
        JOIN volunteer_skill_tags s
          ON s.volunteer_id = p.volunteer_id AND s.verified = TRUE
        WHERE u.role = 'volunteer'
          AND p.availability IN ('idle', 'returning')
          AND p.fatigue_score < 85
          AND NOT EXISTS (SELECT 1 FROM orders active WHERE active.volunteer_id = p.volunteer_id
                          AND active.status IN ('accepted', 'in_progress'))
        GROUP BY p.volunteer_id, p.lng, p.lat, p.availability, p.fatigue_score,
                 p.service_rating, p.assigned_today, p.auto_accept_enabled, u.real_name
        ORDER BY p.volunteer_id
    """)
    candidates = []
    for volunteer in cursor.fetchall():
        current_region = _volunteer_current_region(volunteer.get("lng"), volunteer.get("lat"))
        if not current_region or current_region != order_region:
            continue
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
    standing_region = _volunteer_current_region(origin_lng, origin_lat)
    if not standing_region:
        return None
    cursor.execute("""
        SELECT o.order_id, o.service_type, o.address, d.urgency, d.required_skills,
               e.name AS elder_name, e.personality_bio, e.address AS elder_address,
               COALESCE(o.service_lng, el.lng) AS lng,
               COALESCE(o.service_lat, el.lat) AS lat
        FROM orders o JOIN dispatch_orders d ON d.order_id = o.order_id
        JOIN elders e ON e.elder_id = o.elder_id
        JOIN elder_location_state el ON el.elder_id = o.elder_id
        WHERE o.status = 'pending' AND o.region_adcode = %s
        ORDER BY (d.urgency = 'sos') DESC, d.created_at ASC
        LIMIT 40
    """, (standing_region,))
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
            "distance_km": round(distance, 2),
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
            # Skill mismatch must never stay visible in the grab list.
            cursor.execute(
                """UPDATE dispatch_candidates
                   SET eligible = FALSE, skill_match = '技能不符'
                   WHERE order_id = %s AND volunteer_id = %s""",
                (order["order_id"], item["volunteer_id"]),
            )
            cursor.execute(
                """UPDATE dispatch_candidates
                   SET response_status = 'waiting', invited_at = NULL
                   WHERE order_id = %s AND volunteer_id = %s AND response_status = 'invited'""",
                (order["order_id"], item["volunteer_id"]),
            )
            continue
        cursor.execute(
            "SELECT response_status FROM dispatch_candidates WHERE order_id = %s AND volunteer_id = %s",
            (order["order_id"], item["volunteer_id"]),
        )
        existing = cursor.fetchone()
        # Mid-service reject must not re-enter this order's core queue.
        if existing and str(existing.get("response_status") or "") == "rejected":
            continue
        eligible_rank += 1
        values = (
            order["order_id"], item["volunteer_id"], True, "精确匹配",
            item["distance_km"], item["eta_minutes"], item["distance_score"], item["traffic_score"],
            item["fatigue_component"], item["rating_component"], item["total_score"], eligible_rank,
        )
        if existing:
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


def _other_soft_hold(
    cursor: Any,
    volunteer_id: int,
    order_id: int,
) -> dict[str, Any] | None:
    """Another pending invite currently offering this volunteer (any priority).

    Also treats waiting SOS capacity as a virtual P0 soft-hold so normal Top1–
    Top10 / fallback cannot invite or grab an auto-accept volunteer that SOS
    still needs.
    """
    cursor.execute(
        """
        SELECT c.order_id, d.urgency, COALESCE(d.priority_tier, 2) AS priority_tier,
               d.dispatch_phase, d.created_at
        FROM dispatch_candidates c
        JOIN dispatch_orders d ON d.order_id = c.order_id
        JOIN orders o ON o.order_id = c.order_id
        WHERE c.volunteer_id = %s
          AND c.order_id <> %s
          AND c.response_status IN ('invited', 'forced')
          AND o.status = 'pending'
        ORDER BY COALESCE(d.priority_tier, 2) ASC, d.created_at ASC, c.order_id ASC
        LIMIT 1
        """,
        (volunteer_id, order_id),
    )
    row = cursor.fetchone()
    invite_hold = dict(row) if row else None
    sos_hold = _waiting_sos_capacity_hold(cursor, volunteer_id, order_id)
    if not invite_hold:
        return sos_hold
    if not sos_hold:
        return invite_hold
    invite_rank = _priority_rank(invite_hold.get("urgency"), invite_hold.get("priority_tier"))
    sos_rank = _priority_rank(sos_hold.get("urgency"), sos_hold.get("priority_tier"))
    return sos_hold if sos_rank <= invite_rank else invite_hold


def _waiting_sos_capacity_hold(
    cursor: Any,
    volunteer_id: int,
    exclude_order_id: int | None = None,
) -> dict[str, Any] | None:
    """Reserve excellent auto-accept capacity for the oldest waiting SOS in-region.

    Waiting SOS has no invite row until force-assign succeeds. Without this
    virtual hold, P2 Top1–Top10 and P1 fallback can drain the same people.
    """
    cursor.execute(
        """
        SELECT availability, auto_accept_enabled, service_rating, service_region_adcode, lng, lat
        FROM volunteer_location_state
        WHERE volunteer_id = %s
        """,
        (volunteer_id,),
    )
    state = cursor.fetchone()
    if not state or not bool(state.get("auto_accept_enabled")):
        return None
    if float(state.get("service_rating") or 0) < EXCELLENT_RATING_MIN:
        return None
    if not _volunteer_ready_for_new_dispatch(cursor, volunteer_id, state.get("availability")):
        return None
    region = _volunteer_current_region(state.get("lng"), state.get("lat")) or ""
    if not region:
        return None
    cursor.execute(
        """
        SELECT skill_tag FROM volunteer_skill_tags WHERE volunteer_id = %s
        """,
        (volunteer_id,),
    )
    skills = {str(row["skill_tag"]) for row in cursor.fetchall()}
    cursor.execute(
        """
        SELECT d.order_id, d.urgency, COALESCE(d.priority_tier, %s) AS priority_tier,
               d.dispatch_phase, d.created_at, d.required_skills
        FROM dispatch_orders d
        JOIN orders o ON o.order_id = d.order_id
        WHERE o.status = 'pending'
          AND d.urgency = 'sos'
          AND d.dispatch_state IN (
                'matching', 'waiting_response', 'queued_waiting_capacity', 'admin_escalated'
              )
          AND COALESCE(o.region_adcode, %s) = %s
          AND (%s IS NULL OR d.order_id <> %s)
        ORDER BY d.created_at ASC, d.order_id ASC
        LIMIT 12
        """,
        (PRIORITY_SOS, region, region, exclude_order_id, exclude_order_id),
    )
    for sos in cursor.fetchall():
        sos_id = int(sos["order_id"])
        cursor.execute(
            """
            SELECT response_status FROM dispatch_candidates
            WHERE order_id = %s AND volunteer_id = %s
            """,
            (sos_id, volunteer_id),
        )
        cand = cursor.fetchone()
        if cand and str(cand.get("response_status") or "") == "rejected":
            continue
        try:
            required = set(json.loads(sos.get("required_skills") or "[]"))
        except (TypeError, json.JSONDecodeError):
            required = set()
        if required and not required.issubset(skills):
            continue
        return {
            "order_id": sos_id,
            "urgency": "sos",
            "priority_tier": PRIORITY_SOS,
            "dispatch_phase": sos.get("dispatch_phase"),
            "created_at": sos.get("created_at"),
        }
    return None


def _priority_rank(urgency: str | None, priority_tier: Any) -> int:
    """Lower number = more urgent. SOS always outranks normal tiers."""
    if str(urgency or "") == "sos":
        return PRIORITY_SOS
    if priority_tier is None:
        return PRIORITY_NORMAL
    return int(priority_tier)


def _cross_tier_soft_hold_action(
    order: dict[str, Any],
    holder: dict[str, Any],
) -> str:
    """Same priority tier: coexist (race at accept). Cross-tier only: skip or preempt.

    Returns: 'ignore' | 'skip' | 'preempt'
    """
    my_rank = _priority_rank(order.get("urgency"), order.get("priority_tier"))
    hold_rank = _priority_rank(holder.get("urgency"), holder.get("priority_tier"))
    if my_rank == hold_rank:
        # Same P0/P1/P2 band: do not soft-skip. Top1/Top3/Top10 are per-order
        # expansion phases, not inter-order priority; accept FOR UPDATE decides.
        return "ignore"
    if my_rank < hold_rank:
        return "preempt"
    return "skip"


def _release_soft_hold_for_preempt(
    cursor: Any,
    volunteer_id: int,
    winner_order_id: int,
    holder: dict[str, Any],
) -> None:
    """Drop a lower-priority invite so the winner can soft-hold this volunteer."""
    held_order_id = int(holder["order_id"])
    cursor.execute(
        """UPDATE dispatch_candidates
           SET response_status = 'waiting', invited_at = NULL
           WHERE order_id = %s AND volunteer_id = %s AND response_status IN ('invited', 'forced')""",
        (held_order_id, volunteer_id),
    )
    _event(
        cursor,
        held_order_id,
        "candidate_soft_hold_preempted",
        f"志愿者已被更高优先级订单 #{winner_order_id} 软占用，本单邀请已撤回并顺延下一位。",
        {"volunteer_id": volunteer_id, "winner_order_id": winner_order_id, "held_phase": holder.get("dispatch_phase")},
    )


def _invite_candidates(cursor: Any, order: dict[str, Any], reason: str = "") -> bool:
    """Open / expand the manual grab window with sticky invites.

    Once a volunteer has been invited in Top1/Top3/Top10/fallback, a later
    ranking drop must NOT revoke their grab right.  Phase expansion only adds
    more seats up to the new cap; refresh only prunes people who are no longer
    free / eligible / blocked by a higher-priority soft-hold.
    """
    phase = str(order.get("dispatch_phase") or "top1")
    stage, cap, _, label = _phase_settings(phase)
    if cap is None:
        return False
    order_id = int(order["order_id"])

    # 1) Keep sticky invites; only drop people who can no longer take the job.
    cursor.execute(
        """
        SELECT c.volunteer_id, p.availability, c.eligible, c.response_status
        FROM dispatch_candidates c
        JOIN volunteer_location_state p ON p.volunteer_id = c.volunteer_id
        WHERE c.order_id = %s AND c.response_status = 'invited'
        """,
        (order_id,),
    )
    kept_ids: list[int] = []
    pruned = 0
    for row in cursor.fetchall():
        volunteer_id = int(row["volunteer_id"])
        keep = bool(row.get("eligible")) and _volunteer_ready_for_new_dispatch(
            cursor, volunteer_id, row.get("availability"),
        )
        if keep:
            holder = _other_soft_hold(cursor, volunteer_id, order_id)
            if holder and _cross_tier_soft_hold_action(order, holder) == "skip":
                keep = False
        if keep:
            kept_ids.append(volunteer_id)
        else:
            pruned += 1
            cursor.execute(
                """UPDATE dispatch_candidates
                   SET response_status = 'waiting', invited_at = NULL
                   WHERE order_id = %s AND volunteer_id = %s AND response_status = 'invited'""",
                (order_id, volunteer_id),
            )

    # 2) Fill remaining seats from live ranking (never demote sticky keepers).
    need = max(0, int(cap) - len(kept_ids))
    newly_invited: list[int] = []
    skipped_held = 0
    if need > 0:
        cursor.execute(
            """
            SELECT c.volunteer_id, c.candidate_rank, c.distance_km, c.total_score, p.availability
            FROM dispatch_candidates c
            JOIN volunteer_location_state p ON p.volunteer_id = c.volunteer_id
            WHERE c.order_id = %s AND c.eligible = TRUE
              AND c.response_status = 'waiting' AND p.availability IN ('idle', 'returning')
              AND NOT EXISTS (
                  SELECT 1 FROM orders active
                  WHERE active.volunteer_id = c.volunteer_id
                    AND active.status IN ('accepted', 'in_progress')
              )
            ORDER BY c.candidate_rank NULLS LAST, c.total_score DESC
            LIMIT %s
            """,
            (order_id, max(cap * 6, 60)),
        )
        for row in cursor.fetchall():
            if len(newly_invited) >= need:
                break
            volunteer_id = int(row["volunteer_id"])
            if volunteer_id in kept_ids:
                continue
            if not _volunteer_ready_for_new_dispatch(cursor, volunteer_id, row.get("availability")):
                continue
            holder = _other_soft_hold(cursor, volunteer_id, order_id)
            if holder:
                action = _cross_tier_soft_hold_action(order, holder)
                if action == "skip":
                    skipped_held += 1
                    continue
                if action == "preempt":
                    _release_soft_hold_for_preempt(cursor, volunteer_id, order_id, holder)
            cursor.execute(
                """UPDATE dispatch_candidates
                   SET response_status = 'invited', invited_at = CURRENT_TIMESTAMP
                   WHERE order_id = %s AND volunteer_id = %s AND response_status = 'waiting'""",
                (order_id, volunteer_id),
            )
            newly_invited.append(volunteer_id)

    total_invited = len(kept_ids) + len(newly_invited)
    if total_invited > 0 or pruned or skipped_held:
        shortage_note = ""
        if total_invited < int(cap):
            shortage_note = f"；本区当前技能匹配且空闲/返程仅 {total_invited} 人，不足目标席位 {cap}"
        _event(
            cursor,
            order_id,
            "candidates_invited",
            f"{label}抢单池：保留 {len(kept_ids)} 人粘性邀请，新开放 {len(newly_invited)} 人（目标席位 {cap}）{shortage_note}。",
            {
                "phase": phase,
                "stage": stage,
                "cap": cap,
                "kept": kept_ids,
                "newly_invited": newly_invited,
                "eligible_pool": total_invited,
                "pruned": pruned,
                "skipped_soft_held": skipped_held,
                "reason": reason,
            },
        )
        return True

    _event(
        cursor,
        order_id,
        "no_eligible_candidate",
        "当前范围内没有同时满足技能、空闲且未被更高优先级单软占用的志愿者。"
        if skipped_held
        else "当前范围内没有同时满足技能与空闲条件的志愿者。",
        {"stage": stage, "skipped_soft_held": skipped_held, "pruned": pruned},
    )
    return False


def _explain_accept_conflict(cursor: Any, order_id: int, volunteer_id: int) -> str:
    """Human-readable reason when a grab/accept loses a race."""
    cursor.execute(
        """SELECT o.status, o.volunteer_id, d.urgency, d.forced_assignment, d.dispatch_state,
                  u.real_name AS holder_name
           FROM orders o
           JOIN dispatch_orders d ON d.order_id = o.order_id
           LEFT JOIN users u ON u.user_id = o.volunteer_id
           WHERE o.order_id = %s""",
        (order_id,),
    )
    order = cursor.fetchone()
    if not order:
        return "接单失败：订单不存在，请刷新后重试"

    holder_id = int(order["volunteer_id"]) if order.get("volunteer_id") else None
    if str(order.get("status") or "") != "pending" or holder_id:
        if holder_id == int(volunteer_id):
            return "你已接上该单，请刷新查看行程"
        if bool(order.get("forced_assignment")) or str(order.get("urgency") or "") == "sos":
            # SOS is never a grab race — this only appears on a stale click after auto-assign.
            return "该紧急单已由系统自动派单完成，不支持抢单，请刷新列表"
        if str(order.get("dispatch_state") or "") in ("accepted", "serving", "forced_assigned"):
            name = order.get("holder_name") or "其他志愿者"
            return f"抢单失败：该单刚被其他志愿者抢走（{name}）。服务中的人不能再抢新单，完成或返家空闲后才能继续"
        return "抢单失败：订单已结束匹配或已关闭，请刷新列表"

    cursor.execute(
        "SELECT availability FROM volunteer_location_state WHERE volunteer_id = %s",
        (volunteer_id,),
    )
    state = cursor.fetchone()
    availability = str(state.get("availability") or "") if state else ""
    cursor.execute(
        """SELECT o.order_id, d.urgency, d.forced_assignment, o.service_type
           FROM orders o JOIN dispatch_orders d ON d.order_id = o.order_id
           WHERE o.volunteer_id = %s AND o.status IN ('accepted', 'in_progress')
           ORDER BY o.order_id DESC LIMIT 1""",
        (volunteer_id,),
    )
    active = cursor.fetchone()
    if active or availability in ("en_route", "serving"):
        if active and (bool(active.get("forced_assignment")) or str(active.get("urgency") or "") == "sos"):
            return (
                f"接单失败：系统已将你自动派往 SOS「{active.get('service_type') or '紧急救助'}」。"
                "前往/服务中不能再抢其他单，完成服务并进入空闲或返家后才能继续抢单或自动接单"
            )
        if active:
            return (
                f"接单失败：你已有进行中的服务（#{int(active['order_id'])}）。"
                "被自动分配或接单后不能再抢新单，完成服务并空闲/返家后才能继续"
            )
        return "接单失败：你当前不在空闲/返家状态，无法抢单；完成当前行程后再试"

    cursor.execute(
        "SELECT response_status, eligible FROM dispatch_candidates WHERE order_id = %s AND volunteer_id = %s",
        (order_id, volunteer_id),
    )
    candidate = cursor.fetchone()
    if not candidate or not candidate.get("eligible"):
        return "该单未向你开放（技能不符的订单不会出现在抢单列表，请刷新）"
    status = str(candidate.get("response_status") or "")
    if status == "waiting":
        return "接单失败：该单邀请已变更（可能被更高优先级单软占用），请刷新后查看是否仍可抢"
    if status in ("declined", "rejected", "expired"):
        return "接单失败：你对本单的邀请已失效，请等待后续开放或其他订单"
    if status not in ("invited", "forced"):
        return "接单失败：当前订单尚未向你开放抢单，请刷新列表"
    return "接单未成功：可能刚被系统兜底自动分配或其他人抢先，请刷新后重试"


def _ensure_service_conversation(cursor: Any, order: dict[str, Any], volunteer_id: int) -> None:
    """Open the right chat after assignment: SOS stays one group; otherwise service chat.

    When the order is linked to an SOS / admin-intervene incident, volunteer,
    elder and family join that same SOS conversation so admin/family/volunteer
    are not split across redundant threads.
    """
    order_id = int(order["order_id"])
    elder_id = int(order["elder_id"])
    conversation_id = _find_primary_order_conversation(cursor, order)

    if conversation_id:
        cursor.execute(
            """UPDATE conversations
               SET order_id = COALESCE(order_id, %s),
                   status = 'active',
                   archived_at = NULL
               WHERE conversation_id = %s""",
            (order_id, conversation_id),
        )
        _archive_duplicate_order_conversations(cursor, order_id, conversation_id)
        cursor.execute("SELECT conversation_type, upgraded_to_sos FROM conversations WHERE conversation_id = %s", (conversation_id,))
        meta = cursor.fetchone() or {}
        is_sos_thread = str(meta.get("conversation_type") or "") == "sos" or bool(meta.get("upgraded_to_sos"))
        if is_sos_thread or str(order.get("urgency") or "") == "sos":
            _ensure_sos_group_members(cursor, conversation_id, elder_id, volunteer_id=volunteer_id)
            cursor.execute("SELECT real_name FROM users WHERE user_id = %s", (volunteer_id,))
            named = cursor.fetchone()
            volunteer_label = (named.get("real_name") if named else None) or f"志愿者#{volunteer_id}"
            cursor.execute(
                """INSERT INTO conversation_messages (conversation_id, sender_user_id, message_type, content)
                   VALUES (%s, NULL, 'system', %s)""",
                (conversation_id, f"志愿者 {volunteer_label} 已接单并加入本群（不开新会话）。"),
            )
            return
        _sync_active_volunteer_in_chats(cursor, order_id, volunteer_id)
        cursor.execute("SELECT real_name FROM users WHERE user_id = %s", (volunteer_id,))
        named = cursor.fetchone()
        volunteer_label = (named.get("real_name") if named else None) or f"志愿者#{volunteer_id}"
        cursor.execute(
            """INSERT INTO conversation_messages (conversation_id, sender_user_id, message_type, content)
               VALUES (%s, NULL, 'system', %s)""",
            (conversation_id, f"志愿者 {volunteer_label} 已接单，服务沟通已更新。"),
        )
        return

    cursor.execute(
        """INSERT INTO conversations (conversation_type, elder_id, order_id)
           VALUES ('service', %s, %s) RETURNING conversation_id""",
        (elder_id, order_id),
    )
    conversation_id = int(cursor.fetchone()["conversation_id"])
    cursor.execute("SELECT user_id FROM elders WHERE elder_id = %s", (elder_id,))
    elder_user = cursor.fetchone()
    member_ids = {int(volunteer_id)}
    if elder_user:
        member_ids.add(int(elder_user["user_id"]))
    cursor.execute("SELECT family_user_id FROM user_elder_relation WHERE elder_id = %s", (elder_id,))
    member_ids.update(int(row["family_user_id"]) for row in cursor.fetchall())
    for member_id in member_ids:
        _add_conversation_member(cursor, conversation_id, member_id, can_speak=True)
    cursor.execute(
        """INSERT INTO conversation_messages (conversation_id, sender_user_id, message_type, content)
           VALUES (%s, NULL, 'system', '服务已接单，已开放服务沟通会话（老人、家属、志愿者）。')""",
        (conversation_id,),
    )


def _find_primary_order_conversation(cursor: Any, order: dict[str, Any]) -> int | None:
    """Prefer one reusable thread for an order: service chat, then linked SOS, then elder open SOS."""
    order_id = int(order["order_id"])
    elder_id = int(order["elder_id"])
    cursor.execute(
        """SELECT conversation_id FROM conversations
           WHERE order_id = %s
           ORDER BY CASE
                      WHEN conversation_type = 'sos' THEN 0
                      WHEN upgraded_to_sos THEN 1
                      WHEN conversation_type = 'service' THEN 2
                      ELSE 3
                    END,
                    conversation_id DESC
           LIMIT 1""",
        (order_id,),
    )
    row = cursor.fetchone()
    if row:
        return int(row["conversation_id"])
    cursor.execute(
        """SELECT c.conversation_id
           FROM conversations c
           JOIN emergency_incidents ei ON ei.incident_id = c.incident_id
           WHERE ei.linked_order_id = %s
           ORDER BY c.conversation_id DESC LIMIT 1""",
        (order_id,),
    )
    row = cursor.fetchone()
    if row:
        return int(row["conversation_id"])
    # SOS emergency chat may exist before linked_order_id is written (race on create).
    if str(order.get("urgency") or "") == "sos":
        cursor.execute(
            """SELECT c.conversation_id
               FROM conversations c
               LEFT JOIN emergency_incidents ei ON ei.incident_id = c.incident_id
               WHERE c.elder_id = %s
                 AND c.conversation_type = 'sos'
                 AND c.status = 'active'
                 AND (ei.linked_order_id IS NULL OR ei.linked_order_id = %s OR ei.status <> 'resolved')
               ORDER BY c.conversation_id DESC LIMIT 1""",
            (elder_id, order_id),
        )
        row = cursor.fetchone()
        if row:
            return int(row["conversation_id"])
    return None


def _archive_duplicate_order_conversations(cursor: Any, order_id: int, keep_conversation_id: int) -> None:
    """Collapse accidental parallel chats for the same order into one thread."""
    cursor.execute(
        """SELECT conversation_id FROM conversations
           WHERE order_id = %s AND conversation_id <> %s AND status = 'active'""",
        (order_id, keep_conversation_id),
    )
    extras = [int(row["conversation_id"]) for row in cursor.fetchall()]
    if not extras:
        return
    cursor.execute(
        f"""UPDATE conversations
           SET status = 'archived', archived_at = CURRENT_TIMESTAMP
           WHERE conversation_id IN ({",".join(["%s"] * len(extras))})""",
        tuple(extras),
    )
    for conversation_id in extras:
        cursor.execute(
            """INSERT INTO conversation_messages (conversation_id, sender_user_id, message_type, content)
               VALUES (%s, NULL, 'system', '本会话已合并到原沟通群，请继续在原会话中交流。')""",
            (conversation_id,),
        )


def _add_conversation_member(cursor: Any, conversation_id: int, user_id: int, *, can_speak: bool = True) -> None:
    cursor.execute(
        "SELECT can_speak FROM conversation_members WHERE conversation_id = %s AND user_id = %s",
        (conversation_id, user_id),
    )
    existing = cursor.fetchone()
    if existing:
        cursor.execute(
            """UPDATE conversation_members
               SET can_speak = %s, hidden_at = NULL
               WHERE conversation_id = %s AND user_id = %s""",
            (bool(can_speak), conversation_id, user_id),
        )
        return
    cursor.execute("SELECT role FROM users WHERE user_id = %s", (user_id,))
    user = cursor.fetchone()
    if not user:
        return
    cursor.execute(
        """INSERT INTO conversation_members
           (conversation_id, user_id, role_in_conversation, can_speak)
           VALUES (%s, %s, %s, %s)""",
        (conversation_id, user_id, user["role"], bool(can_speak)),
    )


def _order_conversation_ids(cursor: Any, order_id: int) -> list[int]:
    cursor.execute(
        """
        SELECT conversation_id FROM conversations WHERE order_id = %s
        UNION
        SELECT c.conversation_id FROM conversations c
        JOIN emergency_incidents ei ON ei.incident_id = c.incident_id
        WHERE ei.linked_order_id = %s
        """,
        (order_id, order_id),
    )
    return [int(row["conversation_id"]) for row in cursor.fetchall()]


def _mute_volunteer_in_order_chats(cursor: Any, order_id: int, volunteer_id: int, note: str | None = None) -> None:
    """Keep swapped-out volunteers in history but block further messages."""
    ids = _order_conversation_ids(cursor, order_id)
    if not ids:
        return
    placeholders = ",".join(["%s"] * len(ids))
    cursor.execute(
        f"""UPDATE conversation_members SET can_speak = FALSE
            WHERE user_id = %s AND conversation_id IN ({placeholders})""",
        (volunteer_id, *ids),
    )
    if note:
        for conversation_id in ids:
            cursor.execute(
                """INSERT INTO conversation_messages (conversation_id, sender_user_id, message_type, content)
                   VALUES (%s, NULL, 'system', %s)""",
                (conversation_id, note),
            )


def _sync_active_volunteer_in_chats(cursor: Any, order_id: int, volunteer_id: int) -> None:
    """Mute other volunteers in the order chats and enable the newly assigned one."""
    ids = _order_conversation_ids(cursor, order_id)
    if not ids:
        return
    placeholders = ",".join(["%s"] * len(ids))
    cursor.execute(
        f"""UPDATE conversation_members cm
            SET can_speak = FALSE
            FROM users u
            WHERE u.user_id = cm.user_id
              AND u.role = 'volunteer'
              AND cm.conversation_id IN ({placeholders})
              AND cm.user_id <> %s""",
        (*ids, volunteer_id),
    )
    for conversation_id in ids:
        _add_conversation_member(cursor, conversation_id, volunteer_id, can_speak=True)


def _archive_order_conversations(cursor: Any, order_id: int, note: str) -> None:
    ids = _order_conversation_ids(cursor, order_id)
    if not ids:
        return
    placeholders = ",".join(["%s"] * len(ids))
    cursor.execute(
        f"""UPDATE conversations
            SET status = 'archived', archived_at = CURRENT_TIMESTAMP
            WHERE conversation_id IN ({placeholders}) AND status = 'active'""",
        tuple(ids),
    )
    for conversation_id in ids:
        cursor.execute(
            """INSERT INTO conversation_messages (conversation_id, sender_user_id, message_type, content)
               VALUES (%s, NULL, 'system', %s)""",
            (conversation_id, note),
        )


def _ensure_sos_group_members(
    cursor: Any,
    conversation_id: int,
    elder_id: int,
    *,
    volunteer_id: int | None = None,
) -> None:
    """Elder + all bound family + optional volunteer stay in one SOS group."""
    cursor.execute("SELECT user_id FROM elders WHERE elder_id = %s", (elder_id,))
    elder_user = cursor.fetchone()
    if elder_user:
        _add_conversation_member(cursor, conversation_id, int(elder_user["user_id"]))
    cursor.execute("SELECT family_user_id FROM user_elder_relation WHERE elder_id = %s", (elder_id,))
    for row in cursor.fetchall():
        _add_conversation_member(cursor, conversation_id, int(row["family_user_id"]))
    if volunteer_id:
        _add_conversation_member(cursor, conversation_id, int(volunteer_id), can_speak=True)
        cursor.execute("SELECT order_id FROM conversations WHERE conversation_id = %s", (conversation_id,))
        linked = cursor.fetchone()
        if linked and linked.get("order_id"):
            _sync_active_volunteer_in_chats(cursor, int(linked["order_id"]), int(volunteer_id))
        else:
            # SOS without order_id yet: still mute other volunteers in this chat.
            cursor.execute(
                """UPDATE conversation_members cm SET can_speak = FALSE
                   FROM users u
                   WHERE u.user_id = cm.user_id AND u.role = 'volunteer'
                     AND cm.conversation_id = %s AND cm.user_id <> %s""",
                (conversation_id, int(volunteer_id)),
            )


def _resolve_volunteer_labels(cursor: Any, volunteer_ids: list[int]) -> list[dict[str, Any]]:
    if not volunteer_ids:
        return []
    unique = sorted({int(v) for v in volunteer_ids})
    placeholders = ",".join(["%s"] * len(unique))
    cursor.execute(
        f"SELECT user_id, real_name FROM users WHERE user_id IN ({placeholders})",
        tuple(unique),
    )
    names = {int(row["user_id"]): row.get("real_name") or f"志愿者#{row['user_id']}" for row in cursor.fetchall()}
    return [{"volunteer_id": vid, "volunteer_name": names.get(vid, f"志愿者#{vid}")} for vid in unique]


def _build_order_dispatch_trail(cursor: Any, order_id: int) -> dict[str, Any]:
    """Reconstruct Top1 / Top3 / Top10 invite seats and fallback assignee for admins."""
    order = _order_context(cursor, order_id)
    if not order:
        return {"order_id": order_id, "phases": {}, "events": [], "current_invited": [], "assignee": None}
    cursor.execute(
        """SELECT event_id, event_type, message, details, created_at
           FROM dispatch_events WHERE order_id = %s
           ORDER BY event_id ASC""",
        (order_id,),
    )
    events = []
    phases: dict[str, dict[str, Any]] = {
        "top1": {"label": "Top1 专属", "invited": [], "newly_invited": [], "kept": [], "at": None},
        "top3": {"label": "Top3 抢单（含粘性保留）", "invited": [], "newly_invited": [], "kept": [], "at": None},
        "top10": {"label": "Top10 扩散（含粘性保留）", "invited": [], "newly_invited": [], "kept": [], "at": None},
        "fallback": {"label": "兜底（抢单+自动接单）", "invited": [], "newly_invited": [], "kept": [], "at": None},
    }
    assignee = None
    sticky_pool: list[int] = []
    for row in cursor.fetchall():
        details: dict[str, Any] = {}
        raw = row.get("details")
        if isinstance(raw, str):
            try:
                details = json.loads(raw) or {}
            except json.JSONDecodeError:
                details = {}
        elif isinstance(raw, dict):
            details = raw
        event = {
            "event_id": int(row["event_id"]),
            "event_type": row["event_type"],
            "message": row["message"],
            "details": details,
            "created_at": _iso(row["created_at"]),
        }
        events.append(event)
        et = str(row["event_type"] or "")
        if et == "candidates_invited":
            phase = str(details.get("phase") or "top1")
            if phase not in phases:
                phase = "fallback" if phase == "fallback" else "top10"
            kept_ids = [int(v) for v in (details.get("kept") or [])]
            new_ids = [int(v) for v in (details.get("newly_invited") or [])]
            sticky_pool = sorted(set(sticky_pool) | set(kept_ids) | set(new_ids))
            phases[phase] = {
                **phases.get(phase, {"label": phase}),
                "label": phases.get(phase, {}).get("label") or phase,
                "kept": _resolve_volunteer_labels(cursor, kept_ids),
                "newly_invited": _resolve_volunteer_labels(cursor, new_ids),
                "invited": _resolve_volunteer_labels(cursor, sticky_pool if phase != "top1" else (kept_ids + new_ids)),
                "at": _iso(row["created_at"]),
                "reason": details.get("reason"),
            }
        if et in ("candidate_accepted", "candidate_auto_accepted", "sos_forced_assigned", "admin_manual_assigned"):
            vid = details.get("volunteer_id")
            if vid is not None:
                labels = _resolve_volunteer_labels(cursor, [int(vid)])
                assignee = {
                    **(labels[0] if labels else {"volunteer_id": int(vid), "volunteer_name": f"志愿者#{vid}"}),
                    "mode": et,
                    "automatic": bool(details.get("automatic")) or et in ("candidate_auto_accepted", "sos_forced_assigned"),
                    "at": _iso(row["created_at"]),
                    "message": row["message"],
                }
    cursor.execute(
        """SELECT c.volunteer_id, u.real_name AS volunteer_name, c.candidate_rank, c.response_status,
                  c.total_score, c.eta_minutes, c.distance_km, p.auto_accept_enabled
           FROM dispatch_candidates c
           JOIN users u ON u.user_id = c.volunteer_id
           JOIN volunteer_location_state p ON p.volunteer_id = c.volunteer_id
           WHERE c.order_id = %s AND c.response_status IN ('invited', 'forced', 'accepted')
           ORDER BY c.candidate_rank NULLS LAST, c.total_score DESC""",
        (order_id,),
    )
    current_invited = [{
        "volunteer_id": int(row["volunteer_id"]),
        "volunteer_name": row["volunteer_name"],
        "candidate_rank": int(row["candidate_rank"]) if row.get("candidate_rank") is not None else None,
        "response_status": row["response_status"],
        "total_score": float(row["total_score"]) if row.get("total_score") is not None else None,
        "eta_minutes": int(row["eta_minutes"]) if row.get("eta_minutes") is not None else None,
        "distance_km": float(row["distance_km"]) if row.get("distance_km") is not None else None,
        "auto_accept_enabled": bool(row["auto_accept_enabled"]),
    } for row in cursor.fetchall()]
    if not assignee and order.get("volunteer_id"):
        labels = _resolve_volunteer_labels(cursor, [int(order["volunteer_id"])])
        assignee = {
            **(labels[0] if labels else {"volunteer_id": int(order["volunteer_id"]), "volunteer_name": "已指派"}),
            "mode": "current",
            "automatic": bool(order.get("forced_assignment")),
            "at": None,
            "message": "当前指派",
        }
    return {
        "order_id": order_id,
        "elder_name": order.get("elder_name"),
        "service_type": order.get("service_type"),
        "urgency": order.get("urgency"),
        "dispatch_phase": order.get("dispatch_phase"),
        "dispatch_state": order.get("dispatch_state"),
        "status": order.get("status"),
        "phases": phases,
        "assignee": assignee,
        "current_invited": current_invited,
        "events": events[-40:],
    }


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


def _create_return_route(cursor: Any, volunteer_id: int) -> dict[str, Any] | None:
    cursor.execute("""SELECT lng, lat, home_lng, home_lat FROM volunteer_location_state
                      WHERE volunteer_id = %s""", (volunteer_id,))
    volunteer = cursor.fetchone()
    if not volunteer or volunteer["home_lng"] is None or volunteer["home_lat"] is None:
        return None
    route = route_endpoints(float(volunteer["lng"]), float(volunteer["lat"]), float(volunteer["home_lng"]), float(volunteer["home_lat"]), _traffic_version(cursor))
    route.update({
        "progress": 0,
        "journey_type": "returning",
        # Negative order ids are stable per volunteer.  A distinct journey id
        # prevents an already-open admin map from mistaking a later return trip
        # for the old one and reusing its marker/route-publish cache.
        "journey_id": f"return-{volunteer_id}-{_journey_stamp()}",
        "motion_seconds": _demo_motion_seconds(route.get("eta_minutes"), returning=True),
        "home_lng": float(volunteer["home_lng"]),
        "home_lat": float(volunteer["home_lat"]),
    })
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
    # P0 SOS waiting capacity beats any normal / P1 auto-accept steal.
    if str(order.get("urgency") or "") != "sos":
        sos_hold = _waiting_sos_capacity_hold(cursor, int(volunteer_id), int(order["order_id"]))
        if sos_hold:
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
    cursor.execute("SELECT real_name FROM users WHERE user_id = %s", (volunteer_id,))
    named = cursor.fetchone()
    old_label = (named.get("real_name") if named else None) or f"志愿者#{volunteer_id}"
    _mute_volunteer_in_order_chats(
        cursor,
        int(order["order_id"]),
        int(volunteer_id),
        f"志愿者 {old_label} 已取消接单并离开本群，无法继续发言。",
    )
    if order.get("urgency") != "sos":
        _set_dispatch_phase(cursor, order, "top1")
    _upsert_candidates(cursor, order)
    _invite_candidates(cursor, order, reason)
    _event(cursor, int(order["order_id"]), event_type, reason, {"volunteer_id": volunteer_id})


def _apply_redispatch_reject_rating(cursor: Any, volunteer_id: int, order_id: int, reason: str) -> float:
    """Record a hard 3-star service reject and blend it into the live rating."""
    cursor.execute(
        "SELECT service_rating FROM volunteer_location_state WHERE volunteer_id = %s FOR UPDATE",
        (volunteer_id,),
    )
    state = cursor.fetchone()
    current = float(state["service_rating"]) if state and state.get("service_rating") is not None else 4.5
    # Treat the reject as one new sample against a small historical weight.
    blended = round(max(1.0, min(5.0, (current * 4.0 + 3.0) / 5.0)), 2)
    cursor.execute(
        "UPDATE volunteer_location_state SET service_rating = %s, updated_at = CURRENT_TIMESTAMP WHERE volunteer_id = %s",
        (blended, volunteer_id),
    )
    _event(
        cursor,
        order_id,
        "service_rejected_redispatch",
        f"服务异常驳回：记 3 分并重派。原因：{reason}",
        {"volunteer_id": volunteer_id, "rating": 3, "previous_rating": current, "new_rating": blended, "reason": reason},
    )
    return blended


def _actor_can_touch_order(cursor: Any, order: dict[str, Any], user_id: int) -> tuple[bool, str | None]:
    cursor.execute("SELECT user_id, role FROM users WHERE user_id = %s", (user_id,))
    actor = cursor.fetchone()
    if not actor:
        return False, None
    role = str(actor["role"])
    if role == "elder":
        cursor.execute("SELECT elder_id FROM elders WHERE user_id = %s", (user_id,))
        elder = cursor.fetchone()
        return bool(elder and int(elder["elder_id"]) == int(order["elder_id"])), role
    if role == "volunteer":
        return int(order.get("volunteer_id") or 0) == int(user_id), role
    if role == "family":
        cursor.execute(
            "SELECT 1 FROM user_elder_relation WHERE family_user_id = %s AND elder_id = %s",
            (user_id, order["elder_id"]),
        )
        return bool(cursor.fetchone()), role
    if role == "admin":
        return _admin_can_manage_region(cursor, int(user_id), str(order["region_adcode"])), role
    return False, role


def _notify_service_conversation(cursor: Any, order_id: int, content: str) -> None:
    ids = _order_conversation_ids(cursor, order_id)
    for conversation_id in ids:
        cursor.execute(
            """INSERT INTO conversation_messages (conversation_id, sender_user_id, message_type, content)
               VALUES (%s, NULL, 'system', %s)""",
            (conversation_id, content),
        )


def _pick_least_loaded_district_admin(cursor: Any, region_adcode: str) -> int | None:
    """Exclusive desk owner: fewest open assigned SOS, then lowest user id."""
    cursor.execute(
        """
        SELECT ars.admin_user_id,
               COALESCE((
                   SELECT COUNT(*) FROM emergency_incidents ei
                    WHERE ei.assigned_admin_id = ars.admin_user_id
                      AND COALESCE(ei.status, 'reported') <> 'resolved'
               ), 0) AS active_sos
        FROM admin_region_scope ars
        JOIN users u ON u.user_id = ars.admin_user_id
        WHERE ars.region_adcode = %s AND u.role = 'admin'
        ORDER BY active_sos ASC, ars.admin_user_id ASC
        LIMIT 1
        """,
        (region_adcode,),
    )
    assigned = cursor.fetchone()
    return int(assigned["admin_user_id"]) if assigned else None


def _persist_sos_assigned_admin(cursor: Any, incident_id: int, assigned_admin_id: int | None) -> None:
    if not assigned_admin_id:
        return
    cursor.execute(
        """UPDATE emergency_incidents
              SET assigned_admin_id = COALESCE(assigned_admin_id, %s)
            WHERE incident_id = %s""",
        (int(assigned_admin_id), int(incident_id)),
    )


def _district_admin_owns_sos(cursor: Any, admin_user_id: int, incident_id: int | None) -> bool:
    """True when this district admin is the exclusive desk owner for the SOS."""
    if not incident_id:
        return False
    cursor.execute(
        """
        SELECT 1
          FROM emergency_incidents ei
         WHERE ei.incident_id = %s
           AND (
                ei.assigned_admin_id = %s
                OR EXISTS (
                    SELECT 1 FROM emergency_notifications en
                     WHERE en.incident_id = ei.incident_id
                       AND en.recipient_user_id = %s
                )
           )
        """,
        (int(incident_id), int(admin_user_id), int(admin_user_id)),
    )
    return bool(cursor.fetchone())


def _assign_sos_desk_members(
    cursor: Any,
    elder: dict[str, Any],
    reporter_user_id: int,
    *,
    region_adcode: str | None = None,
) -> tuple[set[int], int | None]:
    """Notify root + one least-loaded district admin for the service region."""
    recipient_ids: set[int] = set()
    cursor.execute("SELECT family_user_id FROM user_elder_relation WHERE elder_id = %s", (elder["elder_id"],))
    recipient_ids.update(int(row["family_user_id"]) for row in cursor.fetchall())
    cursor.execute("SELECT admin_user_id FROM admin_region_scope WHERE region_adcode = '*'")
    recipient_ids.update(int(row["admin_user_id"]) for row in cursor.fetchall())
    service_region = str(region_adcode or elder.get("region_adcode") or DEFAULT_REGION_ADCODE)
    assigned_admin_id = _pick_least_loaded_district_admin(cursor, service_region)
    if assigned_admin_id:
        recipient_ids.add(assigned_admin_id)
    recipient_ids.add(int(elder["user_id"]))
    recipient_ids.add(int(reporter_user_id))
    return recipient_ids, assigned_admin_id


def _ensure_sos_intervention_for_order(
    cursor: Any,
    order: dict[str, Any],
    *,
    requester_user_id: int,
    reason: str,
) -> dict[str, Any]:
    """Bring admins into the existing order chat. Upgrade urgency only for normal orders.

    Native SOS chats already are the admin desk channel — contact-admin must not
    flip ``upgraded_to_sos`` or rewrite the title as「升级成SOS」.
    """
    order_id = int(order["order_id"])
    already_sos = str(order.get("urgency") or "") == "sos"
    upgraded = False
    created = False

    def _upgrade_urgency_if_needed() -> None:
        nonlocal upgraded
        if already_sos:
            return
        if str(order.get("urgency") or "") != "sos":
            cursor.execute(
                """UPDATE dispatch_orders
                   SET urgency = 'sos', priority_tier = %s, dispatch_phase = 'fallback',
                       phase_expires_at = NULL, last_expanded_at = CURRENT_TIMESTAMP
                   WHERE order_id = %s""",
                (PRIORITY_SOS, order_id),
            )
            upgraded = True
            order["urgency"] = "sos"

    def _find_order_conversation() -> int | None:
        return _find_primary_order_conversation(cursor, order)

    def _attach_desk_to_conversation(conversation_id: int, elder: dict[str, Any], incident_id: int) -> int | None:
        recipient_ids, assigned_admin_id = _assign_sos_desk_members(cursor, elder, requester_user_id)
        _persist_sos_assigned_admin(cursor, incident_id, assigned_admin_id)
        for recipient_id in recipient_ids:
            _add_conversation_member(cursor, conversation_id, int(recipient_id), can_speak=True)
            cursor.execute(
                """INSERT INTO emergency_notifications
                   (incident_id, recipient_user_id, recipient_role, notification_type)
                   SELECT %s, u.user_id, u.role, 'in_app' FROM users u WHERE u.user_id = %s
                   AND NOT EXISTS (
                       SELECT 1 FROM emergency_notifications en
                       WHERE en.incident_id = %s AND en.recipient_user_id = %s AND en.notification_type = 'in_app'
                   )""",
                (incident_id, recipient_id, incident_id, recipient_id),
            )
        _ensure_sos_group_members(
            cursor,
            conversation_id,
            int(elder["elder_id"]),
            volunteer_id=int(order["volunteer_id"]) if order.get("volunteer_id") else None,
        )
        if already_sos:
            # Native SOS: never stamp「升级成SOS」. Clear any mistaken flag.
            cursor.execute(
                """UPDATE conversations
                   SET conversation_type = 'sos',
                       incident_id = COALESCE(incident_id, %s),
                       order_id = COALESCE(order_id, %s),
                       upgraded_to_sos = FALSE,
                       status = 'active',
                       archived_at = NULL
                   WHERE conversation_id = %s""",
                (incident_id, order_id, conversation_id),
            )
        else:
            cursor.execute(
                """UPDATE conversations
                   SET conversation_type = 'sos',
                       incident_id = COALESCE(incident_id, %s),
                       order_id = COALESCE(order_id, %s),
                       upgraded_to_sos = TRUE,
                       status = 'active',
                       archived_at = NULL
                   WHERE conversation_id = %s""",
                (incident_id, order_id, conversation_id),
            )
        _archive_duplicate_order_conversations(cursor, order_id, conversation_id)
        return assigned_admin_id

    cursor.execute(
        """SELECT incident_id, status FROM emergency_incidents
           WHERE linked_order_id = %s AND status <> 'resolved'
           ORDER BY incident_id DESC LIMIT 1""",
        (order_id,),
    )
    existing = cursor.fetchone()
    cursor.execute(
        "SELECT elder_id, user_id, name, region_adcode, address FROM elders WHERE elder_id = %s",
        (order["elder_id"],),
    )
    elder = cursor.fetchone()
    if not elder:
        raise ValueError("老人档案不存在")

    if existing:
        incident_id = int(existing["incident_id"])
        conversation_id = _find_order_conversation()
        if not conversation_id:
            cursor.execute(
                """SELECT conversation_id FROM conversations
                   WHERE incident_id = %s
                   ORDER BY conversation_id DESC LIMIT 1""",
                (incident_id,),
            )
            conv = cursor.fetchone()
            conversation_id = int(conv["conversation_id"]) if conv else None
        _upgrade_urgency_if_needed()
        assigned_admin_id = None
        if conversation_id:
            assigned_admin_id = _attach_desk_to_conversation(conversation_id, elder, incident_id)
            cursor.execute(
                """INSERT INTO conversation_messages (conversation_id, sender_user_id, message_type, content)
                   VALUES (%s, %s, 'system', %s)""",
                (
                    conversation_id,
                    requester_user_id,
                    f"管理员已加入本群协助（仍在原会话，不开新聊天）。原因：{reason}",
                ),
            )
        _event(
            cursor,
            order_id,
            "admin_intervention_requested",
            (
                f"已在原 SOS 会话联系管理员跟进。原因：{reason}"
                if already_sos
                else f"已在原服务会话中升级介入，等待管理员跟进。原因：{reason}"
            ),
            {"incident_id": incident_id, "conversation_id": conversation_id, "upgraded": upgraded},
        )
        return {
            "incident_id": incident_id,
            "conversation_id": conversation_id,
            "upgraded": upgraded,
            "created": False,
            "assigned_admin_id": assigned_admin_id,
        }

    description = f"服务中异常求助（订单#{order_id}）：{reason}"[:500]
    service_region = str(order.get("region_adcode") or elder.get("region_adcode") or DEFAULT_REGION_ADCODE)
    order_address = str(order.get("address") or elder.get("address") or "").strip() or None
    order_lng = order.get("service_lng") if order.get("service_lng") is not None else order.get("elder_lng")
    order_lat = order.get("service_lat") if order.get("service_lat") is not None else order.get("elder_lat")
    cursor.execute(
        """INSERT INTO emergency_incidents
           (elder_id, region_adcode, incident_type, description, status, created_by, linked_order_id,
            service_address, service_lng, service_lat, location_mode)
           VALUES (%s, %s, 'service_issue', %s, 'dispatching', %s, %s, %s, %s, %s, %s)
           RETURNING incident_id""",
        (
            elder["elder_id"],
            service_region,
            description,
            requester_user_id,
            order_id,
            order_address,
            float(order_lng) if order_lng is not None else None,
            float(order_lat) if order_lat is not None else None,
            "address",
        ),
    )
    incident_id = int(cursor.fetchone()["incident_id"])
    cursor.execute(
        """INSERT INTO alerts (elder_id, alert_type, description, emergency_incident_id)
           VALUES (%s, 'sos', %s, %s) RETURNING alert_id""",
        (elder["elder_id"], description, incident_id),
    )
    alert_id = int(cursor.fetchone()["alert_id"])

    conversation_id = _find_order_conversation()
    if conversation_id:
        assigned_admin_id = _attach_desk_to_conversation(conversation_id, elder, incident_id)
        created = False
    else:
        # No prior service chat (e.g. pending before accept): open one SOS thread only.
        recipient_ids, assigned_admin_id = _assign_sos_desk_members(
            cursor, elder, requester_user_id, region_adcode=service_region,
        )
        _persist_sos_assigned_admin(cursor, incident_id, assigned_admin_id)
        for recipient_id in recipient_ids:
            cursor.execute(
                """INSERT INTO emergency_notifications
                   (incident_id, recipient_user_id, recipient_role, notification_type)
                   SELECT %s, u.user_id, u.role, 'in_app' FROM users u WHERE u.user_id = %s""",
                (incident_id, recipient_id),
            )
        # Native SOS desk chat is not an "upgrade" — upgraded_to_sos stays false.
        cursor.execute(
            """INSERT INTO conversations
               (conversation_type, elder_id, incident_id, order_id, upgraded_to_sos)
               VALUES ('sos', %s, %s, %s, FALSE) RETURNING conversation_id""",
            (elder["elder_id"], incident_id, order_id),
        )
        conversation_id = int(cursor.fetchone()["conversation_id"])
        for member_id in recipient_ids:
            _add_conversation_member(cursor, conversation_id, int(member_id))
        _ensure_sos_group_members(
            cursor,
            conversation_id,
            int(elder["elder_id"]),
            volunteer_id=int(order["volunteer_id"]) if order.get("volunteer_id") else None,
        )
        created = True

    assign_note = "已按本区平均负载指派分管理员跟进" if assigned_admin_id else "已通知总管理员"
    if assigned_admin_id:
        cursor.execute("SELECT real_name FROM users WHERE user_id = %s", (assigned_admin_id,))
        named = cursor.fetchone()
        if named and named.get("real_name"):
            assign_note = f"已平均分配给分管理员 {named['real_name']} 跟进"
    cursor.execute(
        """INSERT INTO conversation_messages (conversation_id, sender_user_id, message_type, content)
           VALUES (%s, %s, 'system', %s)""",
        (
            conversation_id,
            requester_user_id,
            f"{'管理员已加入本群协助（仍用原会话）' if not created else '已开启紧急协同会话'}：{reason}；{assign_note}",
        ),
    )
    _upgrade_urgency_if_needed()
    _event(
        cursor,
        order_id,
        "order_upgraded_to_sos" if upgraded else "admin_intervention_opened",
        (
            ("普通单已在原群升级为 SOS，" if upgraded else "")
            + (f"管理员已加入原 SOS 会话。原因：{reason}" if already_sos and not upgraded else f"管理员已加入原会话（不开新聊天）。原因：{reason}")
        ),
        {
            "incident_id": incident_id,
            "conversation_id": conversation_id,
            "alert_id": alert_id,
            "upgraded": upgraded,
            "assigned_admin_id": assigned_admin_id,
            "reused_existing_chat": not created,
        },
    )
    return {
        "incident_id": incident_id,
        "conversation_id": conversation_id,
        "alert_id": alert_id,
        "upgraded": upgraded,
        "created": created,
        "assigned_admin_id": assigned_admin_id,
    }


def _mid_service_redispatch(
    cursor: Any,
    order: dict[str, Any],
    *,
    actor_user_id: int,
    reason: str,
    source: str,
) -> dict[str, Any]:
    """Release current volunteer with a 3★ reject and re-enter the core queue by order type."""
    order_id = int(order["order_id"])
    volunteer_id = int(order.get("volunteer_id") or 0)
    if not volunteer_id:
        raise ValueError("当前订单没有可驳回的志愿者")
    if str(order.get("status") or "") not in ("accepted", "in_progress"):
        raise ValueError("仅接单后或服务中的订单可以重派")

    new_rating = _apply_redispatch_reject_rating(cursor, volunteer_id, order_id, reason)
    cursor.execute(
        """UPDATE dispatch_candidates
           SET response_status = 'rejected', eligible = FALSE, responded_at = CURRENT_TIMESTAMP
           WHERE order_id = %s AND volunteer_id = %s""",
        (order_id, volunteer_id),
    )
    cursor.execute(
        """UPDATE dispatch_candidates
           SET response_status = 'waiting', responded_at = NULL, invited_at = NULL, eligible = FALSE
           WHERE order_id = %s AND volunteer_id <> %s AND response_status <> 'rejected'""",
        (order_id, volunteer_id),
    )
    _materialize_dispatch_position(cursor, order_id, volunteer_id)
    cursor.execute("DELETE FROM dispatch_routes WHERE order_id = %s", (order_id,))
    return_route = _create_return_route(cursor, volunteer_id)
    cursor.execute(
        """UPDATE volunteer_location_state
           SET availability = %s, updated_at = CURRENT_TIMESTAMP WHERE volunteer_id = %s""",
        ("returning" if return_route else "idle", volunteer_id),
    )
    cursor.execute("UPDATE orders SET volunteer_id = NULL, status = 'pending' WHERE order_id = %s", (order_id,))
    cursor.execute(
        """UPDATE dispatch_orders
           SET dispatch_state = 'matching', forced_assignment = FALSE, last_expanded_at = CURRENT_TIMESTAMP
           WHERE order_id = %s""",
        (order_id,),
    )
    cursor.execute("SELECT real_name FROM users WHERE user_id = %s", (volunteer_id,))
    named = cursor.fetchone()
    old_label = (named.get("real_name") if named else None) or f"志愿者#{volunteer_id}"
    _mute_volunteer_in_order_chats(
        cursor,
        order_id,
        volunteer_id,
        f"志愿者 {old_label} 已换出本群，无法继续发言；系统正在重新派单。",
    )
    order = _order_context(cursor, order_id)
    if not order:
        raise ValueError("订单调度上下文丢失")

    is_sos = str(order.get("urgency") or "") == "sos"
    if is_sos:
        cursor.execute(
            """UPDATE dispatch_orders
               SET dispatch_phase = 'fallback', phase_expires_at = NULL, priority_tier = %s,
                   dispatch_version = COALESCE(dispatch_version, 0) + 1
               WHERE order_id = %s""",
            (PRIORITY_SOS, order_id),
        )
        order = _order_context(cursor, order_id)
        assigned = _force_assign_sos(cursor, order)
        mode = "sos_force" if assigned else "sos_waiting_capacity"
        message = (
            "已驳回当前志愿者并按 SOS 强制调度重派"
            if assigned
            else "已驳回当前志愿者；暂无空闲自动接单人选，已排队等待并通知管理员，有人空闲后会自动指派"
        )
    else:
        _set_dispatch_phase(cursor, order, "top1")
        order = _order_context(cursor, order_id)
        _upsert_candidates(cursor, order)
        invited = _invite_candidates(cursor, order, f"服务异常重派：{reason}")
        if not invited:
            cursor.execute(
                "UPDATE dispatch_orders SET dispatch_state = 'queued_waiting_capacity' WHERE order_id = %s",
                (order_id,),
            )
            mode = "normal_queued"
            message = "已驳回当前志愿者，普通单已回核心队列等待合适人选"
        else:
            mode = "normal_top1"
            message = "已驳回当前志愿者，普通单已按 Top1→Top3→Top10 流程重新调度"

    _notify_service_conversation(
        cursor,
        order_id,
        f"服务异常已触发重派（3 分驳回）。{message}。原因：{reason}",
    )
    _event(
        cursor,
        order_id,
        "mid_service_redispatched",
        message,
        {
            "rejected_volunteer_id": volunteer_id,
            "new_rating": new_rating,
            "actor_user_id": actor_user_id,
            "source": source,
            "mode": mode,
            "reason": reason,
        },
    )
    fresh = _order_context(cursor, order_id) or order
    return {
        "order_id": order_id,
        "mode": mode,
        "urgency": fresh.get("urgency"),
        "dispatch_state": fresh.get("dispatch_state"),
        "rejected_volunteer_id": volunteer_id,
        "rejected_volunteer_new_rating": new_rating,
        "message": message,
    }


def _try_auto_accept(cursor: Any, order: dict[str, Any]) -> bool:
    """Fallback only: assign the highest-ranked volunteer who opted in.

    Never drains a volunteer reserved for a waiting P0 SOS (auto-accept +
    skill + rating≥4). Those people stay free until `_force_assign_sos` runs.
    """
    # Re-rank from live coordinates.  Mid-service volunteers are excluded even
    # when auto-accept is on; returning (service finished) may accept immediately.
    _upsert_candidates(cursor, order)
    cursor.execute("""
        SELECT c.volunteer_id, p.availability FROM dispatch_candidates c
        JOIN volunteer_location_state p ON p.volunteer_id = c.volunteer_id
        WHERE c.order_id = %s AND c.eligible = TRUE AND c.response_status IN ('waiting', 'invited')
          AND c.response_status <> 'rejected'
          AND p.auto_accept_enabled = TRUE AND p.availability IN ('idle', 'returning')
        ORDER BY c.candidate_rank NULLS LAST, c.total_score DESC
    """, (order["order_id"],))
    for candidate in cursor.fetchall():
        volunteer_id = int(candidate["volunteer_id"])
        if not _volunteer_ready_for_new_dispatch(cursor, volunteer_id, candidate.get("availability")):
            continue
        holder = _other_soft_hold(cursor, volunteer_id, int(order["order_id"]))
        if holder:
            action = _cross_tier_soft_hold_action(order, holder)
            if action == "skip":
                continue
            if action == "preempt":
                _release_soft_hold_for_preempt(cursor, volunteer_id, int(order["order_id"]), holder)
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
    """Force-assign SOS only to high-rated, skill-matched idle/returning auto-accept volunteers.

    Forced assignment cannot be declined online, so it must never land on a
    manual-only volunteer.  Rating must meet EXCELLENT_RATING_MIN (same bar as
    the admin SOS desk).  If none are free, keep retrying via the capacity queue.
    """
    candidates = _upsert_candidates(cursor, order)
    cursor.execute(
        """SELECT volunteer_id FROM dispatch_candidates
           WHERE order_id = %s AND response_status = 'rejected'""",
        (order["order_id"],),
    )
    rejected_ids = {int(row["volunteer_id"]) for row in cursor.fetchall()}
    # SOS still cannot steal a volunteer who is mid-service / en route.
    # Returning volunteers (service finished) may be pulled from the live return point.
    available = [
        item for item in candidates
        if item["skill_ok"]
        and int(item["volunteer_id"]) not in rejected_ids
        and bool(item.get("auto_accept_enabled"))
        and float(item.get("service_rating") or 0) >= EXCELLENT_RATING_MIN
        and _volunteer_ready_for_new_dispatch(cursor, int(item["volunteer_id"]), item.get("availability"))
    ]
    if not available:
        # Keep SOS in the live capacity queue so advance_dispatch can retry when
        # an auto-accept volunteer becomes idle/returning.  admin_escalated alone
        # used to be a dead end even after 王佳明-class volunteers freed up.
        cursor.execute(
            """UPDATE dispatch_orders
               SET dispatch_state = 'queued_waiting_capacity',
                   dispatch_phase = 'fallback',
                   phase_expires_at = NULL,
                   last_expanded_at = CURRENT_TIMESTAMP
               WHERE order_id = %s""",
            (order["order_id"],),
        )
        _event(
            cursor,
            int(order["order_id"]),
            "sos_waiting_auto_accept",
            f"SOS 暂无已开启自动接单、技能匹配且评分≥{EXCELLENT_RATING_MIN}的空闲/返程志愿者；系统会排队自动重试。",
        )
        return False
    # SOS uses ETA first: traffic-aware nearest eligible auto-accept volunteer.
    volunteer_id = None
    for candidate in sorted(available, key=lambda item: (item["eta_minutes"], item["distance_km"], -item["total_score"])):
        candidate_id = int(candidate["volunteer_id"])
        cursor.execute("SELECT user_id FROM users WHERE user_id = %s FOR UPDATE", (candidate_id,))
        if not cursor.fetchone():
            continue
        cursor.execute(
            """SELECT availability, auto_accept_enabled FROM volunteer_location_state
               WHERE volunteer_id = %s FOR UPDATE""",
            (candidate_id,),
        )
        state = cursor.fetchone()
        if (
            state
            and bool(state.get("auto_accept_enabled"))
            and _volunteer_ready_for_new_dispatch(cursor, candidate_id, state.get("availability"))
        ):
            cursor.execute(
                "SELECT service_rating FROM volunteer_location_state WHERE volunteer_id = %s",
                (candidate_id,),
            )
            rating_row = cursor.fetchone()
            if not rating_row or float(rating_row.get("service_rating") or 0) < EXCELLENT_RATING_MIN:
                continue
            volunteer_id = candidate_id
            break
    if volunteer_id is None:
        cursor.execute(
            """UPDATE dispatch_orders
               SET dispatch_state = 'queued_waiting_capacity',
                   dispatch_phase = 'fallback',
                   phase_expires_at = NULL,
                   last_expanded_at = CURRENT_TIMESTAMP
               WHERE order_id = %s""",
            (order["order_id"],),
        )
        _event(
            cursor,
            int(order["order_id"]),
            "sos_contention_waiting",
            "SOS 自动接单候选在并发锁校验中暂不可用，保持排队并继续自动重试。",
        )
        return False
    # SOS always preempts other pending soft-holds on the chosen volunteer.
    holder = _other_soft_hold(cursor, volunteer_id, int(order["order_id"]))
    if holder:
        _release_soft_hold_for_preempt(cursor, volunteer_id, int(order["order_id"]), holder)
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
    _event(
        cursor,
        int(order["order_id"]),
        "sos_forced_assigned",
        f"SOS 已强制派给最近的已开自动接单志愿者，预计{route['eta_minutes']}分钟到达。",
        {"volunteer_id": volunteer_id, "auto_accept_only": True},
    )
    return True


def _reset_daily_fatigue(cursor: Any) -> None:
    """Reset the fairness counters once per Asia/Shanghai calendar day.

    The marker lives in the shared state table, so the reset is performed only
    once even when several users open the board at the same time.
    """
    today = _shanghai_now().date().isoformat()
    cursor.execute("SELECT state_value FROM dispatch_system_state WHERE state_key = 'fatigue_reset_date'")
    row = cursor.fetchone()
    if row and row["state_value"] == today:
        return
    cursor.execute("UPDATE volunteer_location_state SET fatigue_score = 0, assigned_today = 0, fatigue_updated_at = CURRENT_TIMESTAMP")
    if row:
        cursor.execute("UPDATE dispatch_system_state SET state_value = %s, updated_at = CURRENT_TIMESTAMP WHERE state_key = 'fatigue_reset_date'", (today,))
    else:
        cursor.execute("INSERT INTO dispatch_system_state (state_key, state_value) VALUES ('fatigue_reset_date', %s)", (today,))
    _event(cursor, None, "daily_fatigue_reset", f"北京时间 {today} 起疲劳度与今日接单数已自动刷新。")


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

    # Returning without a route (or already sitting on home after a stuck
    # arrival stamp) must become idle, otherwise the admin console freezes.
    cursor.execute("""
        SELECT p.volunteer_id, p.lng, p.lat, p.home_lng, p.home_lat
        FROM volunteer_location_state p
        WHERE p.availability = 'returning'
          AND NOT EXISTS (SELECT 1 FROM volunteer_return_routes rr WHERE rr.volunteer_id = p.volunteer_id)
    """)
    for row in cursor.fetchall():
        cursor.execute("""UPDATE volunteer_location_state
                          SET availability = 'idle', return_started_at = NULL,
                              lng = COALESCE(home_lng, lng), lat = COALESCE(home_lat, lat),
                              updated_at = CURRENT_TIMESTAMP
                          WHERE volunteer_id = %s""", (int(row["volunteer_id"]),))
        _event(cursor, None, "orphaned_return_cleared", "返程路线已结束，志愿者恢复空闲。", {"volunteer_id": int(row["volunteer_id"])})


def _prune_lower_priority_invites_for_waiting_sos(cursor: Any) -> None:
    """Immediately free SOS-eligible auto-accept people from normal Top invites.

    Waiting SOS has no invite row, so without this prune a late SOS would leave
    sticky Top1–Top10 invites on the only people who can take it.
    """
    cursor.execute(
        """
        SELECT DISTINCT c.volunteer_id
        FROM dispatch_candidates c
        JOIN dispatch_orders d ON d.order_id = c.order_id
        JOIN orders o ON o.order_id = c.order_id
        WHERE o.status = 'pending'
          AND d.urgency <> 'sos'
          AND c.response_status = 'invited'
        """
    )
    for row in cursor.fetchall():
        volunteer_id = int(row["volunteer_id"])
        hold = _waiting_sos_capacity_hold(cursor, volunteer_id, None)
        if not hold:
            continue
        cursor.execute(
            """
            UPDATE dispatch_candidates AS c
               SET response_status = 'waiting', invited_at = NULL
              FROM dispatch_orders AS d
              JOIN orders AS o ON o.order_id = d.order_id
             WHERE c.order_id = d.order_id
               AND c.volunteer_id = %s
               AND c.response_status = 'invited'
               AND o.status = 'pending'
               AND d.urgency <> 'sos'
            """,
            (volunteer_id,),
        )
        _event(
            cursor,
            int(hold["order_id"]),
            "sos_capacity_reserved",
            f"P0 SOS 已优先占用志愿者 #{volunteer_id}，已撤回其普通单邀请。",
            {"volunteer_id": volunteer_id, "sos_order_id": int(hold["order_id"])},
        )


def _advance_dispatch_unthrottled(cursor: Any) -> None:
    _reset_daily_fatigue(cursor)
    _recover_fatigue(cursor)
    _advance_active_journeys(cursor)
    _prune_lower_priority_invites_for_waiting_sos(cursor)
    # P0 SOS → P1 escalated → P2 normal; within a tier keep FIFO by created_at.
    cursor.execute("""
        SELECT d.order_id FROM dispatch_orders d JOIN orders o ON o.order_id = d.order_id
        WHERE o.status = 'pending'
          AND (
            d.dispatch_state IN ('matching', 'waiting_response', 'queued_waiting_capacity', 'scheduled')
            OR (d.urgency = 'sos' AND d.dispatch_state = 'admin_escalated')
          )
        ORDER BY COALESCE(d.priority_tier, 2) ASC, d.created_at ASC, d.order_id ASC
    """)
    for row in cursor.fetchall():
        order = _order_context(cursor, int(row["order_id"]))
        if not order:
            continue
        if order["urgency"] != "sos" and _appointment_is_future(order.get("service_time")):
            # Protect both newly created and legacy rows.  Older builds could
            # already have moved a future appointment into Top1/Top3/Top10;
            # park it again and revoke those premature invitations.
            cursor.execute(
                """UPDATE dispatch_candidates
                      SET response_status = 'waiting', invited_at = NULL
                    WHERE order_id = %s AND response_status = 'invited'""",
                (int(order["order_id"]),),
            )
            if str(order.get("dispatch_state") or "") != "scheduled":
                _park_order_as_scheduled(cursor, int(order["order_id"]), order.get("service_time"))
            continue
        if str(order.get("dispatch_state") or "") == "scheduled":
            if _appointment_is_future(order.get("service_time")):
                continue
            _activate_scheduled_order(cursor, order)
            continue
        if order["urgency"] == "sos":
            # Revive older demo rows that were parked forever in admin_escalated.
            if str(order.get("dispatch_state") or "") == "admin_escalated":
                cursor.execute(
                    """UPDATE dispatch_orders
                       SET dispatch_state = 'queued_waiting_capacity',
                           dispatch_phase = 'fallback',
                           phase_expires_at = NULL
                       WHERE order_id = %s""",
                    (int(order["order_id"]),),
                )
                order = _order_context(cursor, int(order["order_id"])) or order
            _force_assign_sos(cursor, order)
            continue
        current_phase = str(order.get("dispatch_phase") or "top1")
        # A request advances from the persisted phase timer, never from its
        # database creation timestamp.  This prevents an old or restored
        # record from skipping the mandatory Top1 eight-second protection
        # window and jumping straight to automatic fallback.
        if current_phase == "fallback":
            _upsert_candidates(cursor, order)
            # Auto-accept runs every tick when an opted-in idle/returning
            # volunteer appears; Top10 invites refresh about every 30 seconds
            # from live rankings so grabbers see current capacity.
            last = order.get("last_expanded_at") or order.get("phase_started_at")
            refresh_due = True
            if isinstance(last, dt.datetime):
                refresh_due = (_now() - last).total_seconds() >= FALLBACK_REFRESH_SECONDS
            if refresh_due:
                _invite_candidates(cursor, order, "兜底轮询：粘性保留原邀请，并按最新位置补齐 Top10 抢单席位")
                _mark_order_escalated_queue(cursor, int(order["order_id"]))
                _event(
                    cursor,
                    int(order["order_id"]),
                    "fallback_top10_refreshed",
                    f"已刷新抢单池（约每 {FALLBACK_REFRESH_SECONDS} 秒）：曾获邀者保留资格，并补齐至 Top10 席位；与自动接单并行。",
                    {"refresh_seconds": FALLBACK_REFRESH_SECONDS},
                )
            if _try_auto_accept(cursor, order):
                _event(cursor, int(order["order_id"]), "fallback_auto_assigned", "兜底并行：已自动派给当前最优且已开启自动接单的空闲/返程志愿者。")
            elif order.get("dispatch_state") != "queued_waiting_capacity":
                _mark_order_escalated_queue(cursor, int(order["order_id"]))
                _event(cursor, int(order["order_id"]), "fallback_waiting_capacity", "自动接单志愿者暂不可用；订单进入升级队列并保持 Top10 抢单。")
            continue
        expires_at = order.get("phase_expires_at")
        if not isinstance(expires_at, dt.datetime):
            _set_dispatch_phase(cursor, order, "top1")
            _upsert_candidates(cursor, order)
            _invite_candidates(cursor, order, "补齐Top1专属确认计时")
            continue
        if _now() < (_ensure_naive(expires_at) or expires_at):
            # Keep ranking tied to live volunteer coordinates (and the elder's
            # current pin), not the snapshot from when the order was created.
            _upsert_candidates(cursor, order)
            _invite_candidates(cursor, order, "按实时位置刷新本阶段候选")
            continue
        desired_phase = {"top1": "top3", "top3": "top10", "top10": "fallback"}.get(current_phase, "top1")
        _set_dispatch_phase(cursor, order, desired_phase)
        # Phase expansion keeps earlier invitees (sticky grab rights) and only
        # opens additional seats up to the new cap.
        _upsert_candidates(cursor, order)
        if desired_phase == "fallback":
            _invite_candidates(cursor, order, "35秒窗口结束：保留原邀请并扩至 Top10，与自动接单并行")
            auto_ok = _try_auto_accept(cursor, order)
            _mark_order_escalated_queue(cursor, int(order["order_id"]))
            if auto_ok:
                _event(cursor, int(order["order_id"]), "fallback_auto_assigned", "35秒手动窗口结束，已自动兜底派单给最优已开启自动接单的志愿者。")
            else:
                _event(cursor, int(order["order_id"]), "fallback_waiting_capacity", "35秒窗口结束：暂无空闲自动接单志愿者；已开放抢单池（粘性保留+Top10席位）并进入升级队列。")
        else:
            _invite_candidates(
                cursor,
                order,
                "Top1窗口结束，扩至Top3并保留原Top1抢单资格" if desired_phase == "top3" else "Top3窗口结束，扩至Top10并保留原邀请人抢单资格",
            )


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
                   FROM administrative_regions
                   ORDER BY COALESCE(province_name, ''), COALESCE(city_name, ''), name, adcode"""
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
    if not admin_user_id or not adcode:
        return jsonify({"code": 400, "message": "请提供 admin_user_id 与区县 adcode"}), 400
    if not manager_user_id:
        return jsonify({"code": 400, "message": "开通区县时必须选择已有区管理员"}), 400
    conn = get_db_connection()
    if not conn:
        return jsonify({"code": 500, "message": "database unavailable"}), 500
    try:
        with conn.cursor() as cursor:
            if not admin_is_root(cursor, int(admin_user_id)):
                return jsonify({"code": 403, "message": "仅总管理员可添加区域"}), 403
            cursor.execute("SELECT name FROM administrative_regions WHERE adcode = %s", (adcode,))
            existing_region = cursor.fetchone()
            if existing_region:
                return jsonify({
                    "code": 409,
                    "message": f"{existing_region['name']} 已开通过，请在下方已配置区域中启用、解绑或绑定管理员",
                }), 409
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
                manager_user_id=int(manager_user_id),
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
    if not admin_user_id:
        return jsonify({"code": 400, "message": "缺少 admin_user_id"}), 400
    if not manager_user_id:
        return jsonify({"code": 400, "message": "请选择已有区管理员"}), 400
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
                manager_user_id=int(manager_user_id),
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
        WHERE p.availability <> 'offline'
        GROUP BY p.volunteer_id, u.real_name, p.lng, p.lat, p.availability, p.fatigue_score, p.service_rating, p.assigned_today, p.auto_accept_enabled
        ORDER BY p.volunteer_id
    """)
    volunteers = []
    for row in cursor.fetchall():
        if _volunteer_current_region(row.get("lng"), row.get("lat")) != region_adcode:
            continue
        volunteers.append({
            "volunteer_id": int(row["volunteer_id"]), "name": row["real_name"], "lng": float(row["lng"]), "lat": float(row["lat"]),
            "availability": row["availability"], "fatigue": int(row["fatigue_score"]), "rating": float(row["service_rating"]),
            "assigned_today": int(row["assigned_today"]), "auto_accept_enabled": bool(row["auto_accept_enabled"]), "skills": [tag for tag in str(row.get("skills_text") or "").split("|") if tag],
        })
    cursor.execute("""
        SELECT e.elder_id, e.name, l.lng, l.lat FROM elder_location_state l
        JOIN elders e ON e.elder_id = l.elder_id
        WHERE l.location_source <> 'hidden_demo' ORDER BY e.elder_id LIMIT 80
    """)
    elders = []
    for row in cursor.fetchall():
        if _region_for_point(row.get("lng"), row.get("lat")) != region_adcode:
            continue
        elders.append({"elder_id": int(row["elder_id"]), "name": row["name"], "lng": float(row["lng"]), "lat": float(row["lat"])})
        if len(elders) >= 25:
            break
    cursor.execute("""
        SELECT o.order_id, o.service_type, o.status, o.volunteer_id, o.notes, v.real_name AS volunteer_name, e.name AS elder_name, e.personality_bio,
               d.urgency, d.dispatch_state, d.search_stage, d.dispatch_phase, d.phase_expires_at,
               d.dispatch_version, d.forced_assignment, d.created_at, o.service_time,
               COALESCE(o.service_lng, l.lng) AS lng,
               COALESCE(o.service_lat, l.lat) AS lat
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
        "service_time": _service_time_text(row.get("service_time")),
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
    cursor.execute("""SELECT r.volunteer_id, p.lng, p.lat
                      FROM volunteer_return_routes r JOIN volunteer_location_state p ON p.volunteer_id = r.volunteer_id
                      ORDER BY r.updated_at DESC LIMIT 40""")
    for row in cursor.fetchall():
        if _volunteer_current_region(row.get("lng"), row.get("lat")) != region_adcode:
            continue
        route = _return_route_for_volunteer(cursor, int(row["volunteer_id"]))
        if route:
            routes.append(route)
    routes_by_order = {int(route["order_id"]): route for route in routes}
    for order in orders:
        order["route"] = routes_by_order.get(int(order["order_id"]))
    cursor.execute("""
        SELECT c.order_id, c.volunteer_id, u.real_name AS volunteer_name, c.eligible, c.skill_match,
               c.distance_km, c.eta_minutes, c.total_score, c.candidate_rank, c.response_status,
               o.service_type, d.search_stage, p.auto_accept_enabled
        FROM dispatch_candidates c JOIN users u ON u.user_id = c.volunteer_id
        JOIN volunteer_location_state p ON p.volunteer_id = c.volunteer_id
        JOIN orders o ON o.order_id = c.order_id JOIN dispatch_orders d ON d.order_id = o.order_id
        WHERE o.status = 'pending' AND o.region_adcode = %s
          AND d.dispatch_state <> 'scheduled'
          AND c.eligible = TRUE AND p.availability IN ('idle', 'returning')
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
        "auto_accept_enabled": bool(row["auto_accept_enabled"]),
    } for row in cursor.fetchall()]
    # One volunteer per order in the board table (never list the same person twice).
    deduped_candidates: list[dict[str, Any]] = []
    seen_pair: set[tuple[int, int]] = set()
    for item in candidates:
        key = (int(item["order_id"]), int(item["volunteer_id"]))
        if key in seen_pair:
            continue
        seen_pair.add(key)
        deduped_candidates.append(item)
    candidates = deduped_candidates
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
            "summary": summary,
            "service_catalog": _public_service_catalog(),
            "skill_options": [{"code": code, "label": label} for code, label in SKILL_LABELS.items()],
        }


def _tracking_shell(cursor: Any) -> dict[str, Any]:
    version = _traffic_version(cursor)
    return {
        "bounds": MAP_BOUNDS, "grid_size": 1, "traffic_version": version,
        "traffic_cells": [], "volunteers": [], "elders": [], "orders": [], "routes": [],
        "service_catalog": _public_service_catalog(),
        "skill_options": [{"code": code, "label": label} for code, label in SKILL_LABELS.items()],
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
            SELECT e.elder_id, e.name, e.address, e.region_adcode, l.lng, l.lat, l.location_source, l.is_home_fixed,
                   ea.full_address AS default_address, ea.lng AS default_lng, ea.lat AS default_lat,
                   ea.label AS default_label
            FROM elders e
            JOIN elder_location_state l ON l.elder_id = e.elder_id
            LEFT JOIN elder_addresses ea ON ea.elder_id = e.elder_id AND ea.is_current = TRUE
            WHERE e.user_id = %s
        """, (user_id,))
        elder = cursor.fetchone()
        if not elder:
            return None
        standing_region = _region_for_point(elder.get("lng"), elder.get("lat"))
        _set_tracking_region(payload, standing_region or elder.get("region_adcode"))
        default_address = elder.get("default_address") or elder.get("address")
        map_lng = float(elder["lng"])
        map_lat = float(elder["lat"])
        map_address = default_address
        # While an order is open, pin the elder on the confirmed service point
        # (same place they ordered), not a later live GPS move.
        cursor.execute("""
            SELECT address, service_lng, service_lat
            FROM orders
            WHERE elder_id = %s AND status IN ('pending', 'accepted', 'in_progress')
              AND service_lng IS NOT NULL AND service_lat IS NOT NULL
            ORDER BY order_id DESC
            LIMIT 1
        """, (elder["elder_id"],))
        active_service = cursor.fetchone()
        if active_service:
            map_lng = float(active_service["service_lng"])
            map_lat = float(active_service["service_lat"])
            map_address = str(active_service.get("address") or default_address)
        payload["elders"] = [{
            "elder_id": int(elder["elder_id"]), "name": elder["name"],
            "address": map_address,
            "default_address": default_address,
            "default_label": elder.get("default_label") or "家",
            "default_lng": float(elder["default_lng"]) if elder.get("default_lng") is not None else None,
            "default_lat": float(elder["default_lat"]) if elder.get("default_lat") is not None else None,
            "lng": map_lng, "lat": map_lat,
            "location_source": elder["location_source"],
            "is_home_fixed": bool(elder["is_home_fixed"]),
        }]
        cursor.execute("""
            SELECT o.order_id, o.service_type, o.service_time, o.status, o.volunteer_id, o.address AS order_address,
                   o.service_lng, o.service_lat, o.proxy_created_by, o.proxy_reason,
                   d.urgency, d.dispatch_state, d.search_stage, d.dispatch_phase, d.phase_expires_at, d.forced_assignment,
                   u.real_name AS volunteer_name, p.lng AS volunteer_lng, p.lat AS volunteer_lat, p.availability, p.service_rating,
                   pu.real_name AS proxy_family_name,
                   COALESCE((SELECT string_agg(s.skill_tag, '|') FROM volunteer_skill_tags s
                             WHERE s.volunteer_id = o.volunteer_id), '') AS volunteer_skills_text
            FROM orders o JOIN dispatch_orders d ON d.order_id = o.order_id
            LEFT JOIN users u ON u.user_id = o.volunteer_id
            LEFT JOIN users pu ON pu.user_id = o.proxy_created_by
            LEFT JOIN volunteer_location_state p ON p.volunteer_id = o.volunteer_id
            WHERE o.elder_id = %s AND o.status != 'cancelled' ORDER BY d.created_at DESC LIMIT 20
        """, (elder["elder_id"],))
        rows = cursor.fetchall()
        for row in rows:
            service_lng = float(row["service_lng"]) if row.get("service_lng") is not None else map_lng
            service_lat = float(row["service_lat"]) if row.get("service_lat") is not None else map_lat
            item = {
                "order_id": int(row["order_id"]), "service_type": row["service_type"], "status": row["status"],
                "service_time": _service_time_text(row.get("service_time")),
                "volunteer_id": int(row["volunteer_id"]) if row["volunteer_id"] else None,
                "volunteer_name": row["volunteer_name"], "urgency": row["urgency"],
                "volunteer_availability": row["availability"] if row["volunteer_id"] else None,
                "volunteer_rating": float(row["service_rating"]) if row["volunteer_id"] else None,
                "volunteer_skills": [tag for tag in str(row.get("volunteer_skills_text") or "").split("|") if tag],
                "dispatch_state": row["dispatch_state"], "search_stage": int(row["search_stage"]),
                "dispatch_phase": row["dispatch_phase"], "phase_expires_at": _iso(row["phase_expires_at"]),
                "forced_assignment": bool(row["forced_assignment"]),
                "address": row["order_address"] or default_address,
                "proxy_created_by": int(row["proxy_created_by"]) if row.get("proxy_created_by") else None,
                "proxy_family_name": row.get("proxy_family_name"),
                "proxy_reason": row.get("proxy_reason"),
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
                item["amap_navigation_url"] = _amap_navigation_url(
                    volunteer["lng"], volunteer["lat"], service_lng, service_lat, f"{elder['name']}服务点",
                )
            else:
                # Pending / completed: never expose volunteer return-home state on ended orders.
                item["location_sharing_active"] = False
                if row["status"] not in ("pending", "accepted", "in_progress"):
                    item["volunteer_availability"] = None
            payload["orders"].append(item)
        if any(order.get("location_sharing_active") for order in payload["orders"]):
            payload["privacy_message"] = "志愿者已接单：地图仅显示为其本人服务的志愿者实时位置与路线。未发请求或服务结束后不会看到其他志愿者。"
        else:
            payload["privacy_message"] = "当前仅显示您自己的位置。未发请求、匹配中或服务结束后，不会展示其他志愿者位置。"
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
        standing_region = _region_for_point(volunteer.get("lng"), volunteer.get("lat"))
        _set_tracking_region(payload, standing_region or volunteer.get("service_region_adcode"))
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
            SELECT o.order_id, o.service_type, e.name AS elder_name, e.personality_bio, o.address,
                   d.urgency,
                   COALESCE(o.service_lng, el.lng) AS lng,
                   COALESCE(o.service_lat, el.lat) AS lat
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
        return_route = _return_route_for_volunteer(cursor, int(user_id))
        if return_route:
            payload["return_route"] = return_route
            payload["routes"].append(return_route)
        cursor.execute("""
            SELECT DISTINCT o.order_id, o.service_type, o.status, o.volunteer_id, o.address AS order_address,
                   e.elder_id, e.name AS elder_name, e.address AS elder_address,
                   COALESCE(o.service_lng, l.lng) AS lng, COALESCE(o.service_lat, l.lat) AS lat,
                   d.urgency, d.dispatch_state, d.search_stage, d.forced_assignment
            FROM orders o JOIN dispatch_orders d ON d.order_id = o.order_id
            JOIN elders e ON e.elder_id = o.elder_id JOIN elder_location_state l ON l.elder_id = e.elder_id
            LEFT JOIN dispatch_candidates c ON c.order_id = o.order_id AND c.volunteer_id = %s
            WHERE o.status IN ('pending', 'accepted', 'in_progress')
              AND COALESCE(c.response_status, '') <> 'rejected'
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
            assigned_to_me = int(row["volunteer_id"] or 0) == user_id and row["status"] in active_statuses
            # Exact elder coordinates only after accept.  Pending invites keep
            # the order card (distance/ETA) but do not unlock the map pin.
            item = {
                "order_id": int(row["order_id"]), "service_type": row["service_type"], "status": row["status"],
                "volunteer_id": int(row["volunteer_id"]) if row["volunteer_id"] else None,
                "elder_name": row["elder_name"], "urgency": row["urgency"], "dispatch_state": row["dispatch_state"],
                "search_stage": int(row["search_stage"]), "forced_assignment": bool(row["forced_assignment"]),
                "address": row["order_address"] or row["elder_address"],
                "location_unlocked": assigned_to_me,
            }
            if assigned_to_me:
                if elder_id not in seen_elders:
                    payload["elders"].append({
                        "elder_id": elder_id, "name": row["elder_name"], "address": row["elder_address"],
                        "lng": float(row["lng"]), "lat": float(row["lat"]),
                    })
                    seen_elders.add(elder_id)
                item["lng"] = float(row["lng"])
                item["lat"] = float(row["lat"])
                item["amap_marker_url"] = _amap_marker_url(float(row["lng"]), float(row["lat"]), f"{row['elder_name']}服务点")
                route = _route_for_order(cursor, int(row["order_id"]))
                if route:
                    payload["routes"].append(route)
                item["amap_navigation_url"] = _amap_navigation_url(
                    own["lng"], own["lat"], item["lng"], item["lat"], f"{row['elder_name']}服务点",
                )
            payload["orders"].append(item)
        if payload["elders"]:
            payload["privacy_message"] = "已接单：地图显示老人真实服务点与前往路线。未接单时仅显示您自己的位置。"
        else:
            payload["privacy_message"] = "未接单时地图只显示您自己的位置；接单后才会解锁老人真实坐标与导航路线。"
        return payload

    if role == "family":
        cursor.execute("""
            SELECT DISTINCT e.elder_id, e.name, e.address, e.region_adcode, l.lng, l.lat, l.location_source, l.is_home_fixed,
                   (
                     SELECT o.service_lng FROM orders o
                     WHERE o.elder_id = e.elder_id
                       AND o.status IN ('pending', 'accepted', 'in_progress')
                       AND o.service_lng IS NOT NULL
                     ORDER BY o.order_id DESC LIMIT 1
                   ) AS active_service_lng,
                   (
                     SELECT o.service_lat FROM orders o
                     WHERE o.elder_id = e.elder_id
                       AND o.status IN ('pending', 'accepted', 'in_progress')
                       AND o.service_lat IS NOT NULL
                     ORDER BY o.order_id DESC LIMIT 1
                   ) AS active_service_lat,
                   (
                     SELECT o.address FROM orders o
                     WHERE o.elder_id = e.elder_id
                       AND o.status IN ('pending', 'accepted', 'in_progress')
                     ORDER BY o.order_id DESC LIMIT 1
                   ) AS active_service_address
            FROM user_elder_relation rel JOIN elders e ON e.elder_id = rel.elder_id
            JOIN elder_location_state l ON l.elder_id = e.elder_id
            WHERE rel.family_user_id = %s
        """, (user_id,))
        elder_rows = cursor.fetchall()
        if not elder_rows:
            return None
        _set_tracking_region(payload, elder_rows[0].get("region_adcode"))
        payload["elders"] = []
        for row in elder_rows:
            has_active = row.get("active_service_lng") is not None and row.get("active_service_lat") is not None
            payload["elders"].append({
                "elder_id": int(row["elder_id"]),
                "name": row["name"],
                "address": (row.get("active_service_address") or row["address"]) if has_active else row["address"],
                "lng": float(row["active_service_lng"]) if has_active else float(row["lng"]),
                "lat": float(row["active_service_lat"]) if has_active else float(row["lat"]),
                "location_source": row["location_source"],
                "is_home_fixed": bool(row["is_home_fixed"]),
            })
        elder_by_id = {int(row["elder_id"]): row for row in elder_rows}
        cursor.execute("""
            SELECT o.order_id, o.elder_id, o.service_type, o.status, o.volunteer_id, o.address AS order_address,
                   o.service_lng, o.service_lat,
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
            # Navigation target = order snapshot, not the elder's later GPS moves.
            service_lng = float(row["service_lng"]) if row.get("service_lng") is not None else float(elder["lng"])
            service_lat = float(row["service_lat"]) if row.get("service_lat") is not None else float(elder["lat"])
            item = {
                "order_id": int(row["order_id"]), "service_type": row["service_type"], "status": row["status"],
                "volunteer_id": int(row["volunteer_id"]) if row["volunteer_id"] else None, "volunteer_name": row["volunteer_name"],
                "volunteer_availability": row["availability"] if row["volunteer_id"] else None,
                "elder_name": elder["name"], "urgency": row["urgency"], "dispatch_state": row["dispatch_state"],
                "search_stage": int(row["search_stage"]), "forced_assignment": bool(row["forced_assignment"]),
                "address": row["order_address"] or elder["address"],
                "service_lng": service_lng,
                "service_lat": service_lat,
            }
            if row["status"] in active_statuses and row["volunteer_id"]:
                volunteer = {"volunteer_id": int(row["volunteer_id"]), "name": row["volunteer_name"], "lng": float(row["volunteer_lng"]), "lat": float(row["volunteer_lat"]), "availability": row["availability"], "fatigue": 0, "rating": 0, "assigned_today": 0, "skills": []}
                payload["volunteers"].append(volunteer)
                payload["routes"].extend([route for route in [_route_for_order(cursor, int(row["order_id"]))] if route])
                item["location_sharing_active"] = True
                item["amap_navigation_url"] = _amap_navigation_url(
                    volunteer["lng"], volunteer["lat"], service_lng, service_lat, f"{elder['name']}服务点",
                )
            else:
                # Same lock as elder portal: after service ends, volunteer pins stop.
                item["location_sharing_active"] = False
            payload["orders"].append(item)
        if any(order.get("location_sharing_active") for order in payload["orders"]):
            payload["privacy_message"] = "可一直查看绑定老人位置；志愿者位置仅在已接单/服务中共享，服务结束后立即停止。"
        else:
            payload["privacy_message"] = "可一直查看绑定老人的固定/授权位置；当前无进行中服务，地图不显示志愿者。"
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


def _build_live_notices(cursor: Any, user_id: int) -> list[dict[str, Any]]:
    """Role-aware in-app notices for elder / family / volunteer / admin."""
    cursor.execute("SELECT role, real_name FROM users WHERE user_id = %s", (user_id,))
    account = cursor.fetchone()
    if not account:
        return []
    role = str(account["role"] or "")
    notices: list[dict[str, Any]] = []

    def _push(
        *,
        notice_key: str,
        title: str,
        body: str,
        level: str = "warning",
        action_path: str | None = None,
        notification_id: int | None = None,
    ) -> None:
        notices.append({
            "notice_key": notice_key,
            "title": title,
            "body": body,
            "level": level,
            "action_path": action_path,
            "notification_id": notification_id,
        })

    if role == "elder":
        cursor.execute(
            """
            SELECT o.order_id, o.service_type, o.status, d.urgency,
                   u.real_name AS volunteer_name,
                   (SELECT conversation_id FROM conversations cv
                    WHERE cv.order_id = o.order_id AND cv.status = 'active'
                    ORDER BY cv.conversation_id DESC LIMIT 1) AS conversation_id
            FROM orders o
            JOIN elders e ON e.elder_id = o.elder_id
            JOIN dispatch_orders d ON d.order_id = o.order_id
            LEFT JOIN users u ON u.user_id = o.volunteer_id
            WHERE e.user_id = %s
              AND o.status IN ('accepted', 'in_progress')
              AND o.volunteer_id IS NOT NULL
            ORDER BY o.order_id DESC
            LIMIT 8
            """,
            (user_id,),
        )
        for row in cursor.fetchall():
            volunteer = row.get("volunteer_name") or "志愿者"
            is_sos = str(row.get("urgency") or "") == "sos"
            status = str(row.get("status") or "")
            if status == "accepted":
                title = "已有人接单"
                body = f"{volunteer} 已接您的「{row['service_type']}」，正在赶来"
            else:
                title = "服务进行中"
                body = f"{volunteer} 正在为您服务：「{row['service_type']}」"
            conv = int(row["conversation_id"]) if row.get("conversation_id") else None
            _push(
                notice_key=f"elder-order-{row['order_id']}-{status}",
                title=title,
                body=body,
                level="error" if is_sos else "success",
                action_path=f"/conversations?id={conv}" if conv else "/elder/dispatch",
            )
        # Yellow health-warning toasts for the elder themselves.
        cursor.execute(
            """
            SELECT a.alert_id, a.description
            FROM alerts a
            JOIN elders e ON e.elder_id = a.elder_id
            WHERE e.user_id = %s
              AND a.alert_type = 'health_warning'
              AND COALESCE(a.is_handled, FALSE) = FALSE
            ORDER BY a.alert_id DESC
            LIMIT 5
            """,
            (user_id,),
        )
        for row in cursor.fetchall():
            # No notification_id: closing toast must not mark the alert handled.
            _push(
                notice_key=f"elder-health-{row['alert_id']}",
                title="健康打卡异常提醒",
                body=str(row.get("description") or "今日健康指标异常，请留意身体状况"),
                level="warning",
                action_path="/elder/checkin",
            )

    elif role == "family":
        cursor.execute(
            """
            SELECT en.notification_id, ei.incident_id, ei.status, ei.description, e.name AS elder_name,
                   c.conversation_id, c.upgraded_to_sos, ei.incident_type
            FROM emergency_notifications en
            JOIN emergency_incidents ei ON ei.incident_id = en.incident_id
            JOIN elders e ON e.elder_id = ei.elder_id
            LEFT JOIN conversations c ON c.incident_id = ei.incident_id AND c.conversation_type = 'sos'
            WHERE en.recipient_user_id = %s
              AND en.read_at IS NULL
              AND ei.status <> 'resolved'
            ORDER BY en.notification_id DESC
            LIMIT 8
            """,
            (user_id,),
        )
        for row in cursor.fetchall():
            status = str(row["status"] or "reported")
            status_text = {
                "reported": "待社区接警",
                "acknowledged": "社区已接警处置中",
                "dispatching": "正在安排志愿者",
                "awaiting_admin_close": "等待社区确认结案",
            }.get(status, status)
            upgraded = bool(row.get("upgraded_to_sos")) or str(row.get("incident_type") or "") == "service_issue"
            conv = int(row["conversation_id"]) if row.get("conversation_id") else None
            _push(
                notice_key=f"family-sos-{row['incident_id']}-{row['notification_id']}",
                title=("服务已升级紧急 · " if upgraded else "长辈紧急求助 · ") + str(row["elder_name"]),
                body=f"{row['description'] or '一键紧急求助'}（{status_text}）",
                level="error",
                action_path=f"/conversations?id={conv}" if conv else "/family/alerts",
                notification_id=int(row["notification_id"]),
            )
        cursor.execute(
            """
            SELECT a.alert_id, a.description, e.name AS elder_name
            FROM alerts a
            JOIN elders e ON e.elder_id = a.elder_id
            JOIN user_elder_relation uer ON uer.elder_id = a.elder_id
            WHERE uer.family_user_id = %s
              AND a.alert_type = 'health_warning'
              AND COALESCE(a.is_handled, FALSE) = FALSE
            ORDER BY a.alert_id DESC
            LIMIT 8
            """,
            (user_id,),
        )
        for row in cursor.fetchall():
            # No notification_id: family must click「确认已知晓」on alerts page.
            _push(
                notice_key=f"family-health-{row['alert_id']}",
                title=f"健康异常 · {row.get('elder_name') or '长辈'}",
                body=str(row.get("description") or "长辈健康打卡出现异常指标"),
                level="warning",
                action_path="/family/alerts",
            )

        cursor.execute(
            """
            SELECT o.order_id, o.service_type, o.status, e.name AS elder_name,
                   u.real_name AS volunteer_name, d.urgency,
                   (SELECT conversation_id FROM conversations cv
                    WHERE cv.order_id = o.order_id AND cv.status = 'active'
                    ORDER BY cv.conversation_id DESC LIMIT 1) AS conversation_id
            FROM orders o
            JOIN elders e ON e.elder_id = o.elder_id
            JOIN user_elder_relation rel ON rel.elder_id = e.elder_id
            JOIN dispatch_orders d ON d.order_id = o.order_id
            LEFT JOIN users u ON u.user_id = o.volunteer_id
            WHERE rel.family_user_id = %s
              AND o.status IN ('accepted', 'in_progress')
              AND o.volunteer_id IS NOT NULL
            ORDER BY o.order_id DESC
            LIMIT 8
            """,
            (user_id,),
        )
        for row in cursor.fetchall():
            volunteer = row.get("volunteer_name") or "志愿者"
            status = str(row.get("status") or "")
            if status == "accepted":
                title = f"志愿者已接单 · {row['elder_name']}"
                body = f"{volunteer} 已接下「{row['service_type']}」，正在前往"
            else:
                title = f"服务进行中 · {row['elder_name']}"
                body = f"{volunteer} 正在服务：「{row['service_type']}」"
            conv = int(row["conversation_id"]) if row.get("conversation_id") else None
            _push(
                notice_key=f"family-order-{row['order_id']}-{status}",
                title=title,
                body=body,
                level="success",
                action_path=f"/conversations?id={conv}" if conv else "/family/orders",
            )

    elif role == "volunteer":
        cursor.execute(
            """
            SELECT o.order_id, o.service_type, o.status, o.volunteer_id, e.name AS elder_name,
                   d.urgency, c.response_status,
                   (SELECT conversation_id FROM conversations cv
                    WHERE cv.order_id = o.order_id AND cv.status = 'active'
                    ORDER BY cv.conversation_id DESC LIMIT 1) AS conversation_id
            FROM orders o
            JOIN elders e ON e.elder_id = o.elder_id
            JOIN dispatch_orders d ON d.order_id = o.order_id
            LEFT JOIN dispatch_candidates c ON c.order_id = o.order_id AND c.volunteer_id = %s
            WHERE o.status IN ('pending', 'accepted', 'in_progress')
              AND d.urgency = 'sos'
              AND (
                    o.volunteer_id = %s
                    OR c.response_status IN ('invited', 'forced', 'accepted')
                  )
            ORDER BY o.order_id DESC
            LIMIT 8
            """,
            (user_id, user_id),
        )
        for row in cursor.fetchall():
            is_mine = row.get("volunteer_id") and int(row["volunteer_id"]) == user_id
            if is_mine:
                title = f"SOS 已派给您 · {row['elder_name']}"
                body = f"请尽快前往处理：{row['service_type']}（#{row['order_id']}）"
                level = "error"
            else:
                title = f"SOS 邀请 · {row['elder_name']}"
                body = f"系统邀请您响应紧急求助：{row['service_type']}（#{row['order_id']}）"
                level = "warning"
            conv = int(row["conversation_id"]) if row.get("conversation_id") else None
            _push(
                notice_key=f"volunteer-sos-{row['order_id']}-{row['status']}-{row.get('response_status')}",
                title=title,
                body=body,
                level=level,
                action_path=f"/conversations?id={conv}" if conv else "/volunteer/dispatch",
            )

    elif role == "admin":
        cursor.execute(
            """
            SELECT en.notification_id, ei.incident_id, ei.status, ei.description, ei.region_adcode,
                   ei.incident_type, e.name AS elder_name, a.alert_id,
                   c.conversation_id, c.upgraded_to_sos
            FROM emergency_notifications en
            JOIN emergency_incidents ei ON ei.incident_id = en.incident_id
            JOIN elders e ON e.elder_id = ei.elder_id
            LEFT JOIN alerts a ON a.emergency_incident_id = ei.incident_id
            LEFT JOIN conversations c ON c.incident_id = ei.incident_id AND c.conversation_type = 'sos'
            WHERE en.recipient_user_id = %s
              AND en.read_at IS NULL
              AND ei.status IN ('reported', 'acknowledged', 'dispatching', 'awaiting_admin_close')
            ORDER BY en.notification_id DESC
            LIMIT 10
            """,
            (user_id,),
        )
        for row in cursor.fetchall():
            status = str(row["status"] or "reported")
            upgraded = bool(row.get("upgraded_to_sos")) or str(row.get("incident_type") or "") == "service_issue"
            if status == "reported":
                title = (f"升级SOS待接警 · {row['elder_name']}" if upgraded else f"待接警 · {row['elder_name']}")
                body = f"{row['description'] or '紧急求助'}，请尽快确认接警"
                level = "error"
            elif status == "awaiting_admin_close":
                title = f"待结案 · {row['elder_name']}"
                body = "志愿服务已结束，请确认处置结果并结案"
                level = "warning"
            else:
                title = (f"升级SOS处理中 · {row['elder_name']}" if upgraded else f"SOS 处理中 · {row['elder_name']}")
                body = f"{row['description'] or '紧急求助'}（{ '社区已接警' if status == 'acknowledged' else '正在安排志愿者' }）"
                level = "warning"
            alert_id = int(row["alert_id"]) if row.get("alert_id") else None
            _push(
                notice_key=f"admin-sos-{row['incident_id']}-{status}-{row['notification_id']}",
                title=title,
                body=body,
                level=level,
                action_path="/admin/alerts" + (f"?alertId={alert_id}" if alert_id else ""),
                notification_id=int(row["notification_id"]),
            )

        # Waiting SOS that now has free auto-accept candidates (desk owner only).
        cursor.execute(
            "SELECT 1 FROM admin_region_scope WHERE admin_user_id = %s AND region_adcode = '*'",
            (user_id,),
        )
        is_root = bool(cursor.fetchone())
        region = _admin_active_region(cursor, user_id, None)
        if is_root:
            cursor.execute(
                """
                SELECT o.order_id, e.name AS elder_name, d.dispatch_state, d.required_skills
                FROM dispatch_orders d
                JOIN orders o ON o.order_id = d.order_id
                JOIN elders e ON e.elder_id = o.elder_id
                WHERE d.urgency = 'sos'
                  AND o.status = 'pending'
                  AND d.dispatch_state IN ('queued_waiting_capacity', 'admin_escalated', 'matching', 'waiting_response', 'fallback')
                  AND o.region_adcode = %s
                ORDER BY o.order_id DESC
                LIMIT 8
                """,
                (region,),
            )
        else:
            cursor.execute(
                """
                SELECT o.order_id, e.name AS elder_name, d.dispatch_state, d.required_skills
                FROM dispatch_orders d
                JOIN orders o ON o.order_id = d.order_id
                JOIN elders e ON e.elder_id = o.elder_id
                JOIN emergency_incidents ei ON ei.linked_order_id = o.order_id
                WHERE d.urgency = 'sos'
                  AND o.status = 'pending'
                  AND d.dispatch_state IN ('queued_waiting_capacity', 'admin_escalated', 'matching', 'waiting_response', 'fallback')
                  AND o.region_adcode = %s
                  AND ei.assigned_admin_id = %s
                  AND COALESCE(ei.status, 'reported') <> 'resolved'
                ORDER BY o.order_id DESC
                LIMIT 8
                """,
                (region, user_id),
            )
        waiting = list(cursor.fetchall())
        for row in waiting:
            order = _order_context(cursor, int(row["order_id"]))
            if not order:
                continue
            _upsert_candidates(cursor, order)
            pool = _excellent_assign_candidates(cursor, int(row["order_id"]), limit=3)
            if not pool:
                continue
            recommended, _alternates = _split_recommended_alternates(pool)
            if not recommended:
                continue
            names = recommended["volunteer_name"]
            if _alternates:
                names = f"{names}、" + "、".join(str(item["volunteer_name"]) for item in _alternates[:2])
            _push(
                notice_key=f"admin-capacity-{row['order_id']}-{int(recommended['volunteer_id'])}-{len(pool)}",
                title=f"系统可自动派单 · {row['elder_name']}",
                body=f"SOS #{row['order_id']} 已有达标人选：{names}。系统会自动派单，管理员只需接警与盯进度。",
                level="success",
                action_path="/admin/alerts",
            )

    return notices


@dispatch_bp.route("/live-notices", methods=["GET"])
def live_notices():
    user_id = request.args.get("user_id", type=int)
    if not user_id:
        return jsonify({"code": 400, "message": "缺少用户编号"}), 400
    conn = get_db_connection()
    if not conn:
        return jsonify({"code": 500, "message": "数据库连接失败"}), 500
    try:
        with conn.cursor() as cursor:
            payload = _build_live_notices(cursor, int(user_id))
            conn.commit()
            return jsonify({"code": 200, "message": "ok", "data": {"notices": payload}})
    except Exception as exc:
        conn.rollback()
        return jsonify({"code": 500, "message": f"加载即时提醒失败: {exc}"}), 500
    finally:
        conn.close()


@dispatch_bp.route("/live-notices/dismiss", methods=["POST"])
def dismiss_live_notice():
    data = request.get_json() or {}
    user_id = data.get("user_id")
    notification_id = data.get("notification_id")
    if not user_id:
        return jsonify({"code": 400, "message": "缺少用户编号"}), 400
    conn = get_db_connection()
    if not conn:
        return jsonify({"code": 500, "message": "数据库连接失败"}), 500
    try:
        with conn.cursor() as cursor:
            if notification_id:
                # Closing a toast only marks SOS in-app notifications read.
                # Health warnings stay "待确认" until family clicks 我知道了.
                cursor.execute(
                    """UPDATE emergency_notifications
                       SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
                       WHERE notification_id = %s AND recipient_user_id = %s""",
                    (int(notification_id), int(user_id)),
                )
            conn.commit()
            return jsonify({"code": 200, "message": "已关闭提醒"})
    except Exception as exc:
        conn.rollback()
        return jsonify({"code": 500, "message": f"关闭提醒失败: {exc}"}), 500
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
            cursor.execute(
                """SELECT e.elder_id, e.region_adcode, e.address,
                          l.lng AS current_lng, l.lat AS current_lat,
                          ea.full_address AS saved_address,
                          ea.lng AS saved_lng, ea.lat AS saved_lat
                   FROM elders e
                   JOIN elder_location_state l ON l.elder_id = e.elder_id
                   LEFT JOIN elder_addresses ea
                     ON ea.elder_id = e.elder_id AND ea.is_current = TRUE
                   WHERE e.user_id = %s""",
                (user_id,),
            )
            elder = cursor.fetchone()
            if not elder:
                return jsonify({"code": 404, "message": "当前账号没有老人档案"}), 404
            resolved_region = _region_for_point(data.get("lng"), data.get("lat"))
            if not resolved_region:
                return jsonify({"code": 400, "message": "该区域尚未开通服务，无法更新定位"}), 400
            point = _valid_region_point(data.get("lng"), data.get("lat"), resolved_region)
            if not point:
                return jsonify({"code": 400, "message": "定位必须位于已开通服务区县范围内"}), 400
            elder_id = int(elder["elder_id"])
            previous_region = str(elder.get("region_adcode") or DEFAULT_REGION_ADCODE)
            # Registered district (elders.region_adcode) is immutable after signup.
            # Live/default pin updates only move location_state / display address.
            cursor.execute("SELECT elder_id FROM elder_location_state WHERE elder_id = %s", (elder_id,))
            values = (point[0], point[1], source, source == "fixed_home", elder_id)
            if cursor.fetchone():
                cursor.execute("""UPDATE elder_location_state SET lng = %s, lat = %s, location_source = %s,
                                  is_home_fixed = %s, updated_at = CURRENT_TIMESTAMP WHERE elder_id = %s""", values)
            else:
                cursor.execute("""INSERT INTO elder_location_state (elder_id, lng, lat, location_source, is_home_fixed)
                                  VALUES (%s, %s, %s, %s, %s)""", (elder_id, point[0], point[1], source, source == "fixed_home"))
            # Address-book rows stay untouched. Display text updates when the
            # client asks to sync (profile live locate) so family/admin see it.
            sync_display = bool(data.get("sync_display")) or source not in {"browser_gps", "virtual"}
            if address and sync_display:
                cursor.execute("UPDATE elders SET address = %s WHERE elder_id = %s", (address, elder_id))
            _event(cursor, None, "elder_location_updated", "老人服务位置已更新", {"elder_id": elder_id, "source": source})
            conn.commit()
            return jsonify({
                "code": 200,
                "message": "当前服务点已更新，家属端可见；注册区县保持不变",
                "data": {
                    "lng": point[0],
                    "lat": point[1],
                    "source": source,
                    "address": address or elder.get("address"),
                    "standing_region_adcode": resolved_region,
                    "registered_region_adcode": previous_region,
                },
            })
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
    use_home = bool(data.get("use_home")) or str(data.get("source") or "").strip().lower() in {
        "home_default", "default", "registered_home",
    }
    source = "home_default" if use_home else _location_source(data.get("source"))
    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute(
                """SELECT volunteer_id, service_region_adcode, availability, home_lng, home_lat
                   FROM volunteer_location_state WHERE volunteer_id = %s""",
                (volunteer_id,),
            )
            volunteer = cursor.fetchone()
            if not volunteer:
                return jsonify({"code": 404, "message": "当前账号没有志愿者定位档案"}), 404
            if use_home:
                home_lng = volunteer.get("home_lng")
                home_lat = volunteer.get("home_lat")
                if home_lng is None or home_lat is None:
                    return jsonify({"code": 400, "message": "尚未配置默认接单位置，请先在调度页设置虚拟出发地"}), 400
                lng, lat = float(home_lng), float(home_lat)
            else:
                lng, lat = data.get("lng"), data.get("lat")
            # Match/grab uses standing district from lng/lat; allow any opened region.
            resolved_region = _region_for_point(lng, lat)
            if not resolved_region:
                return jsonify({"code": 400, "message": "该区域尚未开通服务，无法更新定位"}), 400
            point = _valid_region_point(lng, lat, resolved_region)
            if not point:
                return jsonify({"code": 400, "message": "定位必须位于已开通服务区县范围内"}), 400
            cursor.execute("""UPDATE volunteer_location_state SET lng = %s, lat = %s, location_source = %s,
                              updated_at = CURRENT_TIMESTAMP WHERE volunteer_id = %s""", (point[0], point[1], source, volunteer_id))
            _event(cursor, None, "volunteer_location_updated", "志愿者位置已更新", {"volunteer_id": int(volunteer_id), "source": source})
            conn.commit()
            return jsonify({
                "code": 200,
                "message": "已恢复默认接单位置" if use_home else "当前位置已更新",
                "data": {"lng": point[0], "lat": point[1], "source": source, "standing_region_adcode": resolved_region},
            })
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
                return jsonify({"code": 400, "message": "家庭虚拟位置必须位于已开通服务区县范围内"}), 400
            auto_accept = bool(data.get("auto_accept_enabled"))
            # service_region_adcode is the signup registration district — never rewrite it here.
            if home:
                cursor.execute("""UPDATE volunteer_location_state SET home_lng = %s, home_lat = %s,
                                  auto_accept_enabled = %s, updated_at = CURRENT_TIMESTAMP WHERE volunteer_id = %s""",
                               (home[0], home[1], auto_accept, volunteer_id))
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


def _active_adcode_for_point(
    lng: float,
    lat: float,
    *,
    hint_adcode: str | None = None,
) -> str | None:
    """Resolve an opened district for a service point; prefer polygon match."""
    matched = resolve_region_adcode(lng, lat, REGION_CATALOG)
    canon = canonicalize_active_adcode(matched, REGION_CATALOG)
    if canon:
        return canon
    canon = canonicalize_active_adcode(hint_adcode, REGION_CATALOG)
    if canon:
        return canon
    try:
        geo = reverse_geocode(lng, lat, from_gps=False)
    except Exception:
        return None
    return canonicalize_active_adcode(str(geo.get("adcode") or ""), REGION_CATALOG)


def resolve_elder_service_point(
    cursor: Any,
    *,
    elder_id: int,
    location_mode: str = "address",
    address_id: int | None = None,
    lng: float | None = None,
    lat: float | None = None,
    address: str | None = None,
    sync_pin: bool = False,
) -> dict[str, Any]:
    """Resolve order/SOS service point from confirmed location (not signup district).

    Returns ``region_adcode``, ``lng``, ``lat``, ``address``. Raises ``ValueError``
    when the point is missing or the district is not opened.
    """
    cursor.execute("SELECT elder_id, region_adcode, address FROM elders WHERE elder_id = %s", (elder_id,))
    elder = cursor.fetchone()
    if not elder:
        raise ValueError("elder profile not found")
    mode = str(location_mode or "address").strip().lower()
    if mode == "live":
        mode = "current"
    if mode not in ("address", "current"):
        mode = "address"
    home_region = str(elder.get("region_adcode") or DEFAULT_REGION_ADCODE)
    service_address = str(address or "").strip() or None
    service_lng: float | None = None
    service_lat: float | None = None
    region_adcode: str | None = None
    pin_source = "address_book"
    home_fixed = True

    if mode == "current":
        point_lng, point_lat = lng, lat
        if point_lng is None or point_lat is None:
            cursor.execute(
                """SELECT lng, lat FROM elder_location_state WHERE elder_id = %s""",
                (elder_id,),
            )
            pin = cursor.fetchone() or {}
            point_lng, point_lat = pin.get("lng"), pin.get("lat")
        if point_lng is None or point_lat is None:
            raise ValueError("请先确认本次服务位置（默认地址或实时定位）")
        try:
            service_location = reverse_geocode(point_lng, point_lat, from_gps=False)
        except Exception as exc:
            raise ValueError(f"当前服务点不可用：{exc}") from exc
        service_lng = float(service_location["lng"])
        service_lat = float(service_location["lat"])
        region_adcode = _active_adcode_for_point(
            service_lng,
            service_lat,
            hint_adcode=str(service_location.get("adcode") or ""),
        )
        service_address = (
            service_address
            or str(elder.get("address") or "").strip()
            or str(service_location.get("formatted_address") or "长辈当前服务点")
        )
        pin_source = "browser_gps"
        home_fixed = False
    else:
        chosen = None
        if address_id is not None:
            cursor.execute(
                """SELECT full_address, lng, lat, region_adcode
                   FROM elder_addresses
                   WHERE address_id = %s AND elder_id = %s""",
                (int(address_id), elder_id),
            )
            chosen = cursor.fetchone()
            if not chosen:
                raise ValueError("所选地址不存在")
        else:
            cursor.execute(
                """SELECT full_address, lng, lat, region_adcode
                   FROM elder_addresses
                   WHERE elder_id = %s AND is_current = TRUE""",
                (elder_id,),
            )
            chosen = cursor.fetchone()
        if chosen and chosen.get("lng") is not None and chosen.get("lat") is not None:
            service_lng = float(chosen["lng"])
            service_lat = float(chosen["lat"])
            service_address = service_address or str(
                chosen.get("full_address") or elder.get("address") or "老人地址"
            )
            region_adcode = _active_adcode_for_point(
                service_lng,
                service_lat,
                hint_adcode=str(chosen.get("region_adcode") or home_region),
            )
        else:
            if lng is not None and lat is not None:
                service_lng = float(lng)
                service_lat = float(lat)
            else:
                cursor.execute(
                    """SELECT lng, lat FROM elder_location_state WHERE elder_id = %s""",
                    (elder_id,),
                )
                pin = cursor.fetchone() or {}
                service_lng = float(pin.get("lng") or 0) or None
                service_lat = float(pin.get("lat") or 0) or None
            service_address = service_address or str(elder.get("address") or "老人当前地址")
            if service_lng is not None and service_lat is not None:
                region_adcode = _active_adcode_for_point(
                    service_lng,
                    service_lat,
                    hint_adcode=home_region,
                )
        if not service_lng or not service_lat:
            raise ValueError("请先确认本次服务位置（默认地址或实时定位）")
        pin_source = "address_book"
        home_fixed = True

    if not region_adcode or not is_active_region(region_adcode, REGION_CATALOG):
        raise ValueError("该区域尚未开通服务，无法派单")

    if sync_pin and service_lng is not None and service_lat is not None:
        if service_address:
            cursor.execute(
                "UPDATE elders SET address = %s WHERE elder_id = %s",
                (service_address, elder_id),
            )
        cursor.execute("SELECT elder_id FROM elder_location_state WHERE elder_id = %s", (elder_id,))
        if cursor.fetchone():
            cursor.execute(
                """UPDATE elder_location_state
                   SET lng = %s, lat = %s, location_source = %s,
                       is_home_fixed = %s, updated_at = CURRENT_TIMESTAMP
                   WHERE elder_id = %s""",
                (service_lng, service_lat, pin_source, home_fixed, elder_id),
            )
        else:
            cursor.execute(
                """INSERT INTO elder_location_state
                   (elder_id, lng, lat, location_source, is_home_fixed)
                   VALUES (%s, %s, %s, %s, %s)""",
                (elder_id, service_lng, service_lat, pin_source, home_fixed),
            )

    return {
        "region_adcode": str(region_adcode),
        "lng": float(service_lng),
        "lat": float(service_lat),
        "address": service_address or "服务地址",
        "location_mode": mode,
    }


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
    location_mode: str = "address",
    address_id: int | None = None,
    lng: float | None = None,
    lat: float | None = None,
    urgent: bool = False,
    proxy_created_by: int | None = None,
    proxy_reason: str | None = None,
    manual_only: bool = False,
    incident_id: int | None = None,
    conversation_id: int | None = None,
    required_skills: list[str] | None = None,
) -> tuple[int, str]:
    """Create one order through the authoritative local dispatch engine.

    Elder, family and administrator submissions all use this function.  It is
    deliberately not a task-hall insert: candidates, phase windows, routes
    and later manual intervention therefore stay on one shared timeline.

    When ``incident_id`` / ``conversation_id`` are provided (紧急求助已先建群),
    they are bound before SOS force-assign so the volunteer joins that same
    chat instead of spawning a parallel service thread.

    Service point is snapshotted onto the order at create time
    (``service_lng`` / ``service_lat``). Later elder GPS moves do not replan
    an in-progress order.
    """
    if service_type not in SERVICE_CATALOG:
        raise ValueError("unsupported service type")
    cursor.execute("SELECT elder_id, region_adcode, address FROM elders WHERE elder_id = %s", (elder_id,))
    elder = cursor.fetchone()
    if not elder:
        raise ValueError("elder profile not found")
    catalog = SERVICE_CATALOG[service_type]
    # Family proxy 代下单 must stay on the normal Top1→Top3→Top10 path.
    # Admin SOS / other proxy paths may still set urgent=True.
    if proxy_created_by is not None:
        cursor.execute("SELECT role FROM users WHERE user_id = %s", (int(proxy_created_by),))
        proxy_account = cursor.fetchone()
        if proxy_account and str(proxy_account.get("role") or "") == "family":
            if bool(urgent) or bool(catalog.get("urgent")) or service_type == "SOS紧急救助":
                raise ValueError("家属代下单只能发普通服务，紧急求助请由长辈本人发起")
            urgent = False
    is_sos = bool(urgent) or bool(catalog.get("urgent"))
    point = resolve_elder_service_point(
        cursor,
        elder_id=int(elder_id),
        location_mode=location_mode,
        address_id=address_id,
        lng=lng,
        lat=lat,
        address=address,
        sync_pin=True,
    )
    region_adcode = str(point["region_adcode"])
    service_lng = float(point["lng"])
    service_lat = float(point["lat"])
    service_address = str(point["address"])

    skills = _normalize_required_skills(required_skills, catalog["skills"], urgent=is_sos)
    if not service_time:
        service_time = _shanghai_now().strftime("%Y-%m-%d %H:%M:%S")
    cursor.execute("""
        INSERT INTO orders
            (elder_id, created_by, service_type, service_time, service_hours, address, notes, status,
             region_adcode, proxy_created_by, proxy_reason, service_lng, service_lat)
        VALUES (%s, %s, %s, %s::timestamp, %s, %s, %s, 'pending', %s, %s, %s, %s, %s)
        RETURNING order_id
    """, (elder_id, created_by, service_type, service_time, service_hours or catalog["hours"], service_address, notes,
           region_adcode, proxy_created_by, proxy_reason, service_lng, service_lat))
    order_id = int(cursor.fetchone()["order_id"])
    is_scheduled = (not is_sos) and _appointment_is_future(service_time)
    cursor.execute("""
        INSERT INTO dispatch_orders
            (order_id, urgency, required_skills, dispatch_state, forced_assignment, region_adcode,
             dispatch_phase, phase_started_at, phase_expires_at, dispatch_version, priority_tier, last_expanded_at)
        VALUES (%s, %s, %s, %s, %s, %s, %s,
                CASE WHEN %s THEN NULL ELSE CURRENT_TIMESTAMP END,
                CASE WHEN %s OR %s THEN NULL ELSE CURRENT_TIMESTAMP + (%s * INTERVAL '1 second') END,
                1, %s, CURRENT_TIMESTAMP)
    """, (
        order_id, "sos" if is_sos else "normal", json.dumps(skills, ensure_ascii=False),
        "scheduled" if is_scheduled else "matching",
        is_sos, region_adcode,
        "scheduled" if is_scheduled else ("fallback" if is_sos else "top1"),
        is_scheduled,
        is_sos, is_scheduled, TOP1_WINDOW_SECONDS,
        PRIORITY_SOS if is_sos else PRIORITY_NORMAL,
    ))
    if incident_id:
        cursor.execute(
            """UPDATE emergency_incidents
               SET linked_order_id = %s, status = CASE WHEN status = 'resolved' THEN status ELSE 'dispatching' END
               WHERE incident_id = %s""",
            (order_id, int(incident_id)),
        )
    if conversation_id:
        cursor.execute(
            """UPDATE conversations
               SET order_id = %s,
                   incident_id = COALESCE(incident_id, %s),
                   status = 'active',
                   archived_at = NULL
               WHERE conversation_id = %s""",
            (order_id, int(incident_id) if incident_id else None, int(conversation_id)),
        )
    order = _order_context(cursor, order_id)
    if is_sos:
        if manual_only:
            _upsert_candidates(cursor, order)
            cursor.execute("UPDATE dispatch_orders SET dispatch_state = 'admin_escalated' WHERE order_id = %s", (order_id,))
            _event(cursor, order_id, "sos_admin_manual_dispatch", "管理员已启动 SOS 志愿服务，等待从技能匹配候选中人工指定。",
                   {"region_adcode": region_adcode, "proxy_created_by": proxy_created_by})
            return order_id, "SOS 志愿服务已进入管理员人工派单"
        _event(cursor, order_id, "sos_service_created", "创建了带具体内容的 SOS 紧急服务调度。",
               {"region_adcode": region_adcode, "proxy_created_by": proxy_created_by, "required_skills": skills})
        _force_assign_sos(cursor, order)
        return order_id, "SOS紧急服务已进入本区强制调度"
    if is_scheduled:
        when = _as_naive_shanghai(service_time)
        label = when.strftime("%Y-%m-%d %H:%M") if when else "约定时间"
        _event(
            cursor,
            order_id,
            "order_scheduled",
            f"已预约服务时间 {label}。到点后系统才会开始 Top1→Top3→Top10 找人。",
            {"service_time": label, "required_skills": skills},
        )
        return order_id, f"已预约，将在 {label} 自动开始找人"
    _upsert_candidates(cursor, order)
    if not _invite_candidates(cursor, order, "代下单" if proxy_created_by else "老人下单"):
        cursor.execute("UPDATE dispatch_orders SET dispatch_state = 'queued_waiting_capacity' WHERE order_id = %s", (order_id,))
    _event(cursor, order_id, "smart_order_created", "服务请求已进入本区智能调度队列。",
           {"region_adcode": region_adcode, "proxy_created_by": proxy_created_by, "proxy_reason": proxy_reason, "required_skills": skills})
    return order_id, "服务请求已进入智能推荐队列"


@dispatch_bp.route("/admin/incidents/<int:incident_id>/start-manual-sos-service", methods=["POST"])
@dispatch_bp.route("/admin/incidents/<int:incident_id>/start-auto-sos-service", methods=["POST"])
def start_auto_sos_service(incident_id: int):
    """Start SOS volunteer dispatch in auto-assign mode (no admin pick)."""
    data = request.get_json() or {}
    admin_user_id = data.get("admin_user_id")
    raw_skills = data.get("required_skills") or data.get("skills") or ["emergency_response", "medical_support"]
    if isinstance(raw_skills, str):
        raw_skills = [raw_skills]
    selected_skills = [str(tag).strip() for tag in raw_skills if str(tag).strip()]
    if not admin_user_id:
        return jsonify({"code": 400, "message": "缺少管理员身份"}), 400
    if not selected_skills:
        selected_skills = ["emergency_response", "medical_support"]
    unknown = [tag for tag in selected_skills if tag not in SKILL_LABELS]
    if unknown:
        return jsonify({"code": 400, "message": f"不支持的技能标签: {', '.join(unknown)}"}), 400
    conn = get_db_connection()
    if not conn:
        return jsonify({"code": 500, "message": "数据库连接失败"}), 500
    try:
        with conn.cursor() as cursor:
            cursor.execute("""SELECT incident_id, elder_id, region_adcode, description, linked_order_id, status,
                                     assigned_admin_id, service_address, service_lng, service_lat, location_mode
                              FROM emergency_incidents WHERE incident_id = %s FOR UPDATE""", (incident_id,))
            incident = cursor.fetchone()
            if not incident:
                return jsonify({"code": 404, "message": "紧急事件不存在"}), 404
            if incident["status"] == "resolved":
                return jsonify({"code": 409, "message": "已关闭的紧急事件不能启动志愿服务"}), 409
            if not _admin_can_manage_region(cursor, int(admin_user_id), str(incident["region_adcode"])):
                return jsonify({"code": 403, "message": "您无权处理该区县紧急事件"}), 403
            if not admin_is_root(cursor, int(admin_user_id)):
                if not _district_admin_owns_sos(cursor, int(admin_user_id), int(incident_id)):
                    return jsonify({"code": 403, "message": "该 SOS 已分配给其他区管理员"}), 403
            created = False
            if incident.get("linked_order_id"):
                order_id = int(incident["linked_order_id"])
                order = _order_context(cursor, order_id)
                if order and order.get("status") == "pending":
                    cursor.execute(
                        "UPDATE dispatch_orders SET required_skills = %s WHERE order_id = %s",
                        (json.dumps(selected_skills, ensure_ascii=False), order_id),
                    )
                    order = _order_context(cursor, order_id) or order
                    assigned = _force_assign_sos(cursor, order)
                    conn.commit()
                    return jsonify({
                        "code": 200,
                        "message": "已触发自动派单" if assigned else "暂无达标空闲志愿者，系统将继续自动排队重试",
                        "data": {"order_id": order_id, "assigned": bool(assigned), "required_skills": selected_skills},
                    })
                return jsonify({
                    "code": 200,
                    "message": "SOS 服务单已存在，系统按自动派单处理",
                    "data": {"order_id": order_id, "assigned": bool(order and order.get("volunteer_id")), "required_skills": selected_skills},
                })
            # Prefer immutable SOS snapshot; fall back to current pin only for legacy rows.
            snap_lng = incident.get("service_lng")
            snap_lat = incident.get("service_lat")
            snap_mode = str(incident.get("location_mode") or "").strip().lower()
            if snap_mode == "live":
                snap_mode = "current"
            if snap_mode not in ("address", "current"):
                snap_mode = "current" if snap_lng is not None and snap_lat is not None else "address"
            order_id, msg = create_smart_order_for_elder(
                cursor, elder_id=int(incident["elder_id"]), created_by=int(admin_user_id),
                service_type="SOS紧急救助", notes=str(incident.get("description") or "紧急求助"),
                urgent=True, proxy_created_by=int(admin_user_id), proxy_reason="管理员接警后启动自动 SOS 志愿服务",
                location_mode=snap_mode,
                address=str(incident.get("service_address") or "").strip() or None,
                lng=float(snap_lng) if snap_lng is not None else None,
                lat=float(snap_lat) if snap_lat is not None else None,
                manual_only=False,
                incident_id=incident_id,
                required_skills=selected_skills,
            )
            created = True
            cursor.execute(
                "UPDATE emergency_incidents SET linked_order_id = %s, status = 'dispatching' WHERE incident_id = %s",
                (order_id, incident_id),
            )
            cursor.execute(
                """INSERT INTO conversation_messages (conversation_id, sender_user_id, message_type, content)
                   SELECT conversation_id, %s, 'system', '管理员已启动 SOS 志愿服务，系统正在自动派单。'
                   FROM conversations WHERE incident_id = %s AND conversation_type = 'sos'""",
                (int(admin_user_id), incident_id),
            )
            order = _order_context(cursor, order_id)
            assigned = bool(order and order.get("volunteer_id"))
            conn.commit()
            return jsonify({
                "code": 200,
                "message": msg if assigned else "已创建 SOS 服务单，暂无达标人选，系统将自动排队重试",
                "data": {
                    "order_id": order_id,
                    "created": created,
                    "assigned": assigned,
                    "required_skills": selected_skills,
                },
            })
    except Exception as exc:
        conn.rollback()
        return jsonify({"code": 500, "message": f"启动 SOS 自动派单失败: {exc}"}), 500
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
            cursor.execute("SELECT elder_id, region_adcode, address FROM elders WHERE user_id = %s", (user_id,))
            elder = cursor.fetchone()
            if not elder:
                return jsonify({"code": 404, "message": "当前账号没有老人档案"}), 404
            home_region = str(elder.get("region_adcode") or DEFAULT_REGION_ADCODE)
            catalog = SERVICE_CATALOG[service_type]
            skills = _normalize_required_skills(data.get("required_skills"), catalog["skills"], urgent=urgent)
            service_time = data.get("service_time") or _shanghai_now().strftime("%Y-%m-%d %H:%M:%S")
            notes = str(data.get("notes") or data.get("situation") or "").strip()[:500]
            location_mode = str(data.get("location_mode") or "address").strip().lower()
            if location_mode == "live":
                # Frontend resolveBrowserLocation already returns GCJ-02 coords.
                try:
                    service_location = reverse_geocode(data.get("lng"), data.get("lat"), from_gps=False)
                except Exception as exc:
                    return jsonify({"code": 400, "message": f"实时位置不可用：{exc}"}), 400
                live_adcode = str(service_location.get("adcode") or "").strip()
                if not live_adcode:
                    return jsonify({"code": 400, "message": "无法识别实时定位所属区域"}), 400
                if not is_active_region(live_adcode, REGION_CATALOG):
                    return jsonify({"code": 400, "message": "该区域尚未开通服务，无法派单"}), 400
                # Live-point orders use the standing district, even when it
                # differs from the elder's registered home district.
                region_adcode = live_adcode
                service_lng = float(service_location["lng"])
                service_lat = float(service_location["lat"])
                service_address = str(service_location.get("formatted_address") or "老人实时位置")
                cursor.execute("SELECT elder_id FROM elder_location_state WHERE elder_id = %s", (elder["elder_id"],))
                if cursor.fetchone():
                    cursor.execute(
                        """UPDATE elder_location_state
                           SET lng = %s, lat = %s, location_source = 'browser_gps',
                               is_home_fixed = FALSE, updated_at = CURRENT_TIMESTAMP
                           WHERE elder_id = %s""",
                        (service_lng, service_lat, elder["elder_id"]),
                    )
                else:
                    cursor.execute(
                        """INSERT INTO elder_location_state
                           (elder_id, lng, lat, location_source, is_home_fixed)
                           VALUES (%s, %s, %s, 'browser_gps', FALSE)""",
                        (elder["elder_id"], service_lng, service_lat),
                    )
            else:
                # Must join from elders: origin/master used elder["current_lng"] without
                # selecting it, which raised KeyError and surfaced as 调度失败.
                cursor.execute(
                    """SELECT l.lng AS current_lng, l.lat AS current_lat,
                              ea.full_address AS saved_address,
                              ea.lng AS saved_lng, ea.lat AS saved_lat,
                              ea.region_adcode AS saved_region_adcode
                       FROM elders e
                       LEFT JOIN elder_location_state l ON l.elder_id = e.elder_id
                       LEFT JOIN elder_addresses ea
                         ON ea.elder_id = e.elder_id AND ea.is_current = TRUE
                       WHERE e.elder_id = %s""",
                    (elder["elder_id"],),
                )
                location_row = cursor.fetchone() or {}
                service_lng = float(location_row.get("saved_lng") or location_row.get("current_lng") or 0)
                service_lat = float(location_row.get("saved_lat") or location_row.get("current_lat") or 0)
                if not service_lng or not service_lat:
                    return jsonify({"code": 400, "message": "尚未配置可用服务地址，请先在个人中心设置地址"}), 400
                service_address = str(
                    location_row.get("saved_address") or elder.get("address") or "老人当前地址"
                )
                region_adcode = str(
                    location_row.get("saved_region_adcode") or home_region or DEFAULT_REGION_ADCODE
                ).strip()
                if not is_active_region(region_adcode, REGION_CATALOG):
                    return jsonify({"code": 400, "message": "该区域尚未开通服务，无法派单"}), 400
                if location_row.get("saved_address"):
                    cursor.execute(
                        "UPDATE elders SET address = %s WHERE elder_id = %s",
                        (location_row["saved_address"], elder["elder_id"]),
                    )
                cursor.execute("SELECT elder_id FROM elder_location_state WHERE elder_id = %s", (elder["elder_id"],))
                if cursor.fetchone():
                    cursor.execute(
                        """UPDATE elder_location_state
                           SET lng = %s, lat = %s, location_source = 'address_book',
                               is_home_fixed = TRUE, updated_at = CURRENT_TIMESTAMP
                           WHERE elder_id = %s""",
                        (service_lng, service_lat, elder["elder_id"]),
                    )
                else:
                    cursor.execute(
                        """INSERT INTO elder_location_state
                           (elder_id, lng, lat, location_source, is_home_fixed)
                           VALUES (%s, %s, %s, 'address_book', TRUE)""",
                        (elder["elder_id"], service_lng, service_lat),
                    )
            cursor.execute("""
                INSERT INTO orders
                    (elder_id, created_by, service_type, service_time, service_hours,
                     address, notes, status, region_adcode, service_lng, service_lat)
                VALUES (%s, %s, %s, %s, %s, %s, %s, 'pending', %s, %s, %s)
                RETURNING order_id
            """, (
                elder["elder_id"],
                user_id,
                service_type,
                service_time,
                data.get("service_hours") or catalog["hours"],
                service_address,
                notes,
                region_adcode,
                service_lng,
                service_lat,
            ))
            order_id = int(cursor.fetchone()["order_id"])
            is_scheduled = (not urgent) and _appointment_is_future(service_time)
            cursor.execute("""
                INSERT INTO dispatch_orders
                    (order_id, urgency, required_skills, dispatch_state, forced_assignment,
                     dispatch_phase, phase_started_at, phase_expires_at, dispatch_version, priority_tier, last_expanded_at)
                VALUES (%s, %s, %s, %s, %s, %s,
                        CASE WHEN %s THEN NULL ELSE CURRENT_TIMESTAMP END,
                        CASE WHEN %s OR %s THEN NULL ELSE CURRENT_TIMESTAMP + (%s * INTERVAL '1 second') END,
                        1, %s, CURRENT_TIMESTAMP)
            """, (
                order_id,
                "sos" if urgent else "normal",
                json.dumps(skills, ensure_ascii=False),
                "scheduled" if is_scheduled else "matching",
                urgent,
                "scheduled" if is_scheduled else ("fallback" if urgent else "top1"),
                is_scheduled,
                urgent, is_scheduled, TOP1_WINDOW_SECONDS,
                PRIORITY_SOS if urgent else PRIORITY_NORMAL,
            ))
            cursor.execute("UPDATE dispatch_orders SET region_adcode = %s WHERE order_id = %s",
                           (region_adcode, order_id))
            order = _order_context(cursor, order_id)
            if urgent:
                _event(cursor, order_id, "sos_created", "老人发起SOS，开始强制派单。", {"required_skills": skills})
                _force_assign_sos(cursor, order)
                message = "SOS已强制派单"
            elif is_scheduled:
                when = _as_naive_shanghai(service_time)
                label = when.strftime("%Y-%m-%d %H:%M") if when else "约定时间"
                _event(
                    cursor,
                    order_id,
                    "order_scheduled",
                    f"已预约服务时间 {label}。到点后系统才会开始 Top1→Top3→Top10 找人。",
                    {"service_time": label, "required_skills": skills},
                )
                message = f"已预约，将在 {label} 自动开始找人"
            else:
                _upsert_candidates(cursor, order)
                auto_assigned = _invite_candidates(cursor, order, "老人发起服务请求")
                if not auto_assigned:
                    cursor.execute("UPDATE dispatch_orders SET dispatch_state = 'waiting_response' WHERE order_id = %s", (order_id,))
                _event(cursor, order_id, "order_created", f"已建立{service_type}请求，按所选技能硬过滤后开始智能推荐。", {"required_skills": skills})
                message = "请求已进入智能推荐队列"
            conn.commit()
            return jsonify({"code": 200, "message": message, "data": {"order_id": order_id, "required_skills": skills, "scheduled": is_scheduled}})
    except Exception as exc:
        conn.rollback()
        return jsonify({"code": 500, "message": f"创建调度请求失败: {exc}"}), 500
    finally:
        conn.close()


@dispatch_bp.route("/admin/orders/<int:order_id>/dispatch-trail", methods=["GET"])
def admin_order_dispatch_trail(order_id: int):
    """Let district admins inspect Top1/Top3/Top10 invite seats and fallback assignee."""
    admin_user_id = request.args.get("admin_user_id", type=int)
    if not admin_user_id:
        return jsonify({"code": 400, "message": "缺少管理员身份"}), 400
    conn = get_db_connection()
    if not conn:
        return jsonify({"code": 500, "message": "数据库连接失败"}), 500
    try:
        with conn.cursor() as cursor:
            order = _order_context(cursor, order_id)
            if not order:
                return jsonify({"code": 404, "message": "订单不存在"}), 404
            if not _admin_can_manage_region(cursor, int(admin_user_id), str(order["region_adcode"])):
                return jsonify({"code": 403, "message": "您无权查看该区县订单调度轨迹"}), 403
            trail = _build_order_dispatch_trail(cursor, order_id)
            conn.commit()
            return jsonify({"code": 200, "message": "调度轨迹已生成", "data": trail})
    except Exception as exc:
        conn.rollback()
        return jsonify({"code": 500, "message": f"获取调度轨迹失败: {exc}"}), 500
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
            if not order:
                return jsonify({"code": 404, "message": "订单不存在"}), 404
            if order["status"] != "pending":
                volunteer_name = order.get("volunteer_name") or order.get("linked_volunteer_name")
                if not volunteer_name and order.get("volunteer_id"):
                    cursor.execute("SELECT real_name FROM users WHERE user_id = %s", (int(order["volunteer_id"]),))
                    named = cursor.fetchone()
                    volunteer_name = (named or {}).get("real_name")
                if order.get("volunteer_id"):
                    label = volunteer_name or f"#{order['volunteer_id']}"
                    return jsonify({
                        "code": 409,
                        "message": f"该单已自动派给 {label}（状态：{order['status']}），无需再人工派单；如需换人请用换人重派",
                    }), 409
                return jsonify({"code": 409, "message": f"该订单当前状态为 {order['status']}，不可人工派单"}), 409
            if not _admin_can_manage_region(cursor, int(admin_user_id), str(order["region_adcode"])):
                return jsonify({"code": 403, "message": "您无权处理该区县订单"}), 403
            # Initial assign is automatic for all dispatch orders; admin may only redispatch mid-service.
            if str(order.get("urgency") or "") == "sos":
                return jsonify({"code": 409, "message": "SOS 已改为系统自动派单，管理员不能手动指定志愿者"}), 409
            return jsonify({"code": 409, "message": "普通订单不进入人工台，由系统加速调度与抢单"}), 409
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
                       o.service_type, o.status, o.notes, d.urgency, d.forced_assignment, d.dispatch_phase, e.name AS elder_name, e.personality_bio,
                       e.address AS elder_address,
                       COALESCE(o.service_lng, el.lng) AS elder_lng,
                       COALESCE(o.service_lat, el.lat) AS elder_lat,
                       d.required_skills, r.route_json
                FROM orders o JOIN dispatch_orders d ON d.order_id = o.order_id
                LEFT JOIN dispatch_candidates c ON c.order_id = o.order_id AND c.volunteer_id = %s
                JOIN elders e ON e.elder_id = o.elder_id
                JOIN elder_location_state el ON el.elder_id = e.elder_id
                LEFT JOIN dispatch_routes r ON r.order_id = o.order_id
                WHERE ((o.status = 'pending' AND d.urgency <> 'sos'
                        AND c.eligible = TRUE AND COALESCE(c.skill_match, '') = '精确匹配'
                        AND c.response_status = 'invited'
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
                item["notes"] = str(item.get("notes") or "").strip()
                item["required_skills"] = json.loads(item["required_skills"])
                item["required_skill_labels"] = [SKILL_LABELS.get(tag, tag) for tag in item["required_skills"]]
                item["route"] = json.loads(item.pop("route_json")) if item.get("route_json") else None
                elder_lng = item.pop("elder_lng", None)
                elder_lat = item.pop("elder_lat", None)
                item["address"] = item.pop("elder_address")
                # Pending invites: keep distance/ETA for matching, hide exact pin.
                if item.get("status") in ("accepted", "in_progress") and elder_lng is not None and elder_lat is not None:
                    item["lng"] = float(elder_lng)
                    item["lat"] = float(elder_lat)
                    item["location_unlocked"] = True
                    item["amap_marker_url"] = _amap_marker_url(item["lng"], item["lat"], f"{item['elder_name']}服务点")
                else:
                    item["location_unlocked"] = False
                    item.pop("lng", None)
                    item.pop("lat", None)
                tasks.append(item)
            cursor.execute("""SELECT availability, fatigue_score, service_rating, assigned_today, location_source, home_lng, home_lat,
                              auto_accept_enabled FROM volunteer_location_state WHERE volunteer_id = %s""", (volunteer_id,))
            state = cursor.fetchone() or {"availability": "idle", "fatigue_score": 0, "service_rating": 0, "assigned_today": 0,
                                           "location_source": "simulated", "home_lng": None, "home_lat": None, "auto_accept_enabled": False}
            # Automatic mode is a 35-second fallback, not an override of the
            # protected manual windows.  An opted-in volunteer can therefore
            # still see and confirm a Top1/Top3/Top10 offer; only after those
            # windows expire may the system accept on the volunteer's behalf.
            # History for this volunteer: successfully completed jobs, plus
            # mid-service rejects that should surface as 已关闭 for the person
            # who was swapped out (even while the order continues with someone else).
            cursor.execute("""
                SELECT * FROM (
                    SELECT o.order_id, o.service_type, e.name AS elder_name, e.personality_bio,
                           COALESCE(o.address, e.address) AS address,
                           (
                               SELECT MAX(ev.created_at) FROM dispatch_events ev
                               WHERE ev.order_id = o.order_id
                                 AND ev.event_type IN (
                                     'service_completed',
                                     'elder_confirmed_completion',
                                     'family_confirmed_completion'
                                 )
                           ) AS closed_at,
                           'completed' AS close_status
                    FROM orders o
                    JOIN elders e ON e.elder_id = o.elder_id
                    WHERE o.volunteer_id = %s AND o.status = 'completed'
                    UNION ALL
                    SELECT o.order_id, o.service_type, e.name AS elder_name, e.personality_bio,
                           COALESCE(o.address, e.address) AS address,
                           COALESCE(
                               (
                                   SELECT MAX(ev.created_at) FROM dispatch_events ev
                                   WHERE ev.order_id = o.order_id
                                     AND ev.event_type IN (
                                         'service_rejected_redispatch',
                                         'mid_service_redispatched'
                                     )
                               ),
                               c.responded_at
                           ) AS closed_at,
                           'closed' AS close_status
                    FROM dispatch_candidates c
                    JOIN orders o ON o.order_id = c.order_id
                    JOIN elders e ON e.elder_id = o.elder_id
                    WHERE c.volunteer_id = %s
                      AND c.response_status = 'rejected'
                      AND NOT (o.volunteer_id = %s AND o.status = 'completed')
                ) history
                ORDER BY closed_at DESC NULLS LAST, order_id DESC
                LIMIT 30
            """, (volunteer_id, volunteer_id, volunteer_id))
            completed_tasks = [{
                "order_id": int(row["order_id"]), "service_type": row["service_type"],
                "elder_name": row["elder_name"], "address": row["address"],
                "completed_at": _iso(row["closed_at"]),
                "close_status": row["close_status"],
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
                # 接单后即出发：志愿者不可取消；老人端可取消（pending/accepted）。
                return jsonify({"code": 403, "message": "已接单出发后不能取消，如需结束请由老人取消本次帮助"}), 403
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
                    return jsonify({"code": 409, "message": "请先到达服务点并进入服务中，再完成订单"}), 409
                cursor.execute(
                    "SELECT availability FROM volunteer_location_state WHERE volunteer_id = %s",
                    (volunteer_id,),
                )
                live = cursor.fetchone()
                if not live or str(live.get("availability") or "") != "serving":
                    return jsonify({
                        "code": 409,
                        "message": "仅在「正在服务」状态可完成服务并返家；请先到达老人服务点进入服务中",
                    }), 409
                if str(order.get("dispatch_state") or "") != "serving":
                    return jsonify({
                        "code": 409,
                        "message": "订单尚未进入服务中状态，暂时不能完成并返家",
                    }), 409
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
                _archive_order_conversations(cursor, order_id, "服务已完成，会话已结束。老人/家属/志愿者可删除本会话；管理员仍保留归档。")
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
                return jsonify({"code": 403, "message": "该单未向你开放（技能不符的订单不会出现在列表中，请刷新）"}), 403
            if action == "decline" and bool(order["forced_assignment"]):
                return jsonify({
                    "code": 403,
                    "message": "SOS 强制派单仅派给已开自动接单的志愿者，不可在线拒绝；如有特殊原因请联系管理员或事后申诉",
                }), 403
            if action == "decline":
                cursor.execute("""UPDATE dispatch_candidates SET response_status = 'declined', responded_at = CURRENT_TIMESTAMP
                                  WHERE order_id = %s AND volunteer_id = %s""", (order_id, volunteer_id))
                _event(cursor, order_id, "candidate_declined", "志愿者拒绝推荐，系统继续推送下一位候选。", {"volunteer_id": volunteer_id})
                _invite_candidates(cursor, order, "候选志愿者拒绝")
                conn.commit()
                return jsonify({"code": 200, "message": "已记录拒绝，已向下一位候选推送"})
            # SOS is auto-assigned only — never a manual grab target.
            if action == "accept" and str(order.get("urgency") or "") == "sos" and order["status"] == "pending":
                return jsonify({"code": 409, "message": "SOS 紧急单由系统自动派单，不支持抢单"}), 409
            if order["status"] != "pending":
                return jsonify({"code": 409, "message": _explain_accept_conflict(cursor, order_id, int(volunteer_id))}), 409
            if candidate["response_status"] not in ("invited", "forced"):
                return jsonify({"code": 403, "message": _explain_accept_conflict(cursor, order_id, int(volunteer_id))}), 403
            if str(candidate.get("skill_match") or "") not in ("精确匹配", "") and not candidate["eligible"]:
                return jsonify({"code": 403, "message": "该单未向你开放，请刷新列表"}), 403
            sos_hold = _waiting_sos_capacity_hold(cursor, int(volunteer_id), order_id)
            if sos_hold and str(order.get("urgency") or "") != "sos":
                return jsonify({
                    "code": 409,
                    "message": f"P0 SOS #{sos_hold['order_id']} 正在等待自动派单，系统已优先保留你的运力，暂不可接普通单",
                }), 409
            route = _accept_candidate(cursor, order, int(volunteer_id))
            if route is None:
                conn.rollback()
                detail = _explain_accept_conflict(cursor, order_id, int(volunteer_id))
                return jsonify({"code": 409, "message": detail}), 409
            conn.commit()
            return jsonify({"code": 200, "message": "接单成功，路线已生成", "data": route})
    except Exception as exc:
        conn.rollback()
        return jsonify({"code": 500, "message": f"处理接单响应失败: {exc}"}), 500
    finally:
        conn.close()


def _close_emergency_for_cancelled_order(
    cursor: Any,
    order_id: int,
    actor_user_id: int | None,
    summary: str,
) -> None:
    """Resolve linked SOS incidents/alerts so volunteer/admin tasks disappear with the order."""
    cursor.execute(
        """SELECT incident_id FROM emergency_incidents
           WHERE linked_order_id = %s AND status <> 'resolved' FOR UPDATE""",
        (order_id,),
    )
    rows = cursor.fetchall() or []
    for row in rows:
        incident_id = int(row["incident_id"])
        cursor.execute(
            """UPDATE emergency_incidents
               SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP,
                   resolved_by = %s, resolution_summary = %s
               WHERE incident_id = %s""",
            (actor_user_id, summary[:500], incident_id),
        )
        cursor.execute("UPDATE alerts SET is_handled = TRUE WHERE emergency_incident_id = %s", (incident_id,))
        cursor.execute(
            """INSERT INTO conversation_messages (conversation_id, sender_user_id, message_type, content)
               SELECT conversation_id, %s, 'system', %s
               FROM conversations WHERE incident_id = %s AND conversation_type = 'sos'""",
            (actor_user_id, f"紧急求助已取消：{summary}", incident_id),
        )
        cursor.execute(
            """UPDATE conversations SET status = 'archived', archived_at = CURRENT_TIMESTAMP
               WHERE incident_id = %s AND conversation_type = 'sos' AND status = 'active'""",
            (incident_id,),
        )


def finalize_cancelled_dispatch_order(
    cursor: Any,
    order_id: int,
    *,
    actor_user_id: int | None = None,
    event_type: str = "order_cancelled",
    event_message: str = "服务请求已取消，已停止后续调度。",
    archive_message: str = "服务已取消，会话已结束。老人/家属/志愿者可删除本会话；管理员仍保留归档。",
    emergency_summary: str = "老人/家属已取消紧急服务，关联任务已关闭",
) -> None:
    """Cancel an intelligent order and immediately drop volunteer/admin follow-up work."""
    order = _order_context(cursor, order_id) or {}
    volunteer_id = int(order.get("volunteer_id") or 0)
    if volunteer_id:
        _materialize_dispatch_position(cursor, order_id, volunteer_id)
        cursor.execute("DELETE FROM dispatch_routes WHERE order_id = %s", (order_id,))
        return_route = _create_return_route(cursor, volunteer_id)
        cursor.execute(
            """UPDATE volunteer_location_state
               SET availability = %s, updated_at = CURRENT_TIMESTAMP
               WHERE volunteer_id = %s""",
            ("returning" if return_route else "idle", volunteer_id),
        )
        if order.get("status") in ("accepted", "in_progress"):
            _mute_volunteer_in_order_chats(
                cursor,
                order_id,
                volunteer_id,
                "服务请求已取消，您已离开本群，无法继续发言。",
            )
    cursor.execute("UPDATE orders SET status = 'cancelled' WHERE order_id = %s", (order_id,))
    cursor.execute("UPDATE dispatch_orders SET dispatch_state = 'cancelled' WHERE order_id = %s", (order_id,))
    cursor.execute(
        """UPDATE dispatch_candidates
           SET response_status = 'expired', eligible = FALSE, responded_at = CURRENT_TIMESTAMP
           WHERE order_id = %s
             AND response_status NOT IN ('expired', 'rejected')""",
        (order_id,),
    )
    _close_emergency_for_cancelled_order(cursor, order_id, actor_user_id, emergency_summary)
    _event(cursor, order_id, event_type, event_message, {"actor_user_id": actor_user_id, "volunteer_id": volunteer_id or None})
    _archive_order_conversations(cursor, order_id, archive_message)


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
            finalize_cancelled_dispatch_order(
                cursor,
                order_id,
                actor_user_id=int(user_id),
                event_type="elder_order_cancelled",
                event_message="老人已取消服务请求，已停止后续调度；志愿者任务已同步清除。",
                emergency_summary="老人已取消紧急服务，关联志愿者任务已关闭",
            )
            conn.commit()
            return jsonify({"code": 200, "message": "订单已取消，相关任务已同步关闭"})
    except Exception as exc:
        conn.rollback()
        return jsonify({"code": 500, "message": f"取消订单失败: {exc}"}), 500
    finally:
        conn.close()


@dispatch_bp.route("/orders/<int:order_id>/redispatch", methods=["POST"])
def redispatch_dispatch_order(order_id: int):
    """Default mid-service path: 3★ reject current volunteer and re-enter core queue."""
    data = request.get_json() or {}
    user_id = data.get("user_id")
    reason = str(data.get("reason") or "服务中出现问题，需要更换志愿者").strip()[:300]
    if not user_id:
        return jsonify({"code": 400, "message": "缺少操作人账号"}), 400
    conn = get_db_connection()
    if not conn:
        return jsonify({"code": 500, "message": "数据库连接失败"}), 500
    try:
        with conn.cursor() as cursor:
            cursor.execute("SELECT order_id FROM orders WHERE order_id = %s FOR UPDATE", (order_id,))
            if not cursor.fetchone():
                return jsonify({"code": 404, "message": "订单不存在"}), 404
            order = _order_context(cursor, order_id)
            if not order:
                return jsonify({"code": 404, "message": "不是智能调度订单"}), 404
            allowed, role = _actor_can_touch_order(cursor, order, int(user_id))
            if not allowed:
                return jsonify({"code": 403, "message": "无权对该订单发起重派"}), 403
            # Volunteers may self-report issues; elders/family/admin always can.
            if role == "volunteer" and int(order.get("volunteer_id") or 0) != int(user_id):
                return jsonify({"code": 403, "message": "仅当前接单志愿者可申请本单重派"}), 403
            result = _mid_service_redispatch(
                cursor,
                order,
                actor_user_id=int(user_id),
                reason=reason,
                source=str(role or "user"),
            )
            conn.commit()
            return jsonify({"code": 200, "message": result["message"], "data": result})
    except ValueError as exc:
        conn.rollback()
        return jsonify({"code": 409, "message": str(exc)}), 409
    except Exception as exc:
        conn.rollback()
        return jsonify({"code": 500, "message": f"重派失败: {exc}"}), 500
    finally:
        conn.close()


@dispatch_bp.route("/orders/<int:order_id>/request-admin", methods=["POST"])
def request_admin_for_dispatch_order(order_id: int):
    """Optional admin path: open SOS-identical conversation; may upgrade normal→SOS.

    Does not block the default redispatch path. Pass also_redispatch=true to
    release the current volunteer into the core SOS queue after opening the desk.
    """
    data = request.get_json() or {}
    user_id = data.get("user_id")
    reason = str(data.get("reason") or "服务中需要管理员协助").strip()[:300]
    also_redispatch = bool(data.get("also_redispatch"))
    if not user_id:
        return jsonify({"code": 400, "message": "缺少操作人账号"}), 400
    conn = get_db_connection()
    if not conn:
        return jsonify({"code": 500, "message": "数据库连接失败"}), 500
    try:
        with conn.cursor() as cursor:
            cursor.execute("SELECT order_id FROM orders WHERE order_id = %s FOR UPDATE", (order_id,))
            if not cursor.fetchone():
                return jsonify({"code": 404, "message": "订单不存在"}), 404
            order = _order_context(cursor, order_id)
            if not order:
                return jsonify({"code": 404, "message": "不是智能调度订单"}), 404
            if str(order.get("status") or "") not in ("accepted", "in_progress", "pending"):
                return jsonify({"code": 409, "message": "当前订单状态不支持管理员介入"}), 409
            allowed, role = _actor_can_touch_order(cursor, order, int(user_id))
            if not allowed:
                # Pending orders have no volunteer yet; volunteers cannot request then.
                if role == "volunteer":
                    return jsonify({"code": 403, "message": "仅当前服务相关方可请求管理员介入"}), 403
                return jsonify({"code": 403, "message": "无权请求管理员介入"}), 403
            intervention = _ensure_sos_intervention_for_order(
                cursor,
                order,
                requester_user_id=int(user_id),
                reason=reason,
            )
            redispatch_result = None
            if also_redispatch and order.get("volunteer_id") and str(order.get("status") or "") in ("accepted", "in_progress"):
                # Refresh context after possible urgency upgrade.
                order = _order_context(cursor, order_id) or order
                redispatch_result = _mid_service_redispatch(
                    cursor,
                    order,
                    actor_user_id=int(user_id),
                    reason=reason,
                    source=f"admin_intervene:{role}",
                )
            conn.commit()
            was_native_sos = str((_order_context(cursor, order_id) or order).get("urgency") or "") == "sos" and not intervention.get("upgraded")
            if intervention.get("upgraded"):
                msg = "已在本群升级为 SOS，管理员已加入（未新开聊天）"
            elif was_native_sos:
                msg = "已在原 SOS 会话联系管理员（无需升级）"
            elif not intervention.get("created"):
                msg = "已在本群联系管理员，管理员已加入（未新开聊天）"
            else:
                msg = "已打开紧急协同会话"
            return jsonify({
                "code": 200,
                "message": msg,
                "data": {
                    **intervention,
                    "redispatch": redispatch_result,
                },
            })
    except ValueError as exc:
        conn.rollback()
        return jsonify({"code": 409, "message": str(exc)}), 409
    except Exception as exc:
        conn.rollback()
        return jsonify({"code": 500, "message": f"请求管理员介入失败: {exc}"}), 500
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
            if order["status"] not in ("accepted", "in_progress") or not order.get("volunteer_id"):
                return jsonify({"code": 409, "message": "志愿者接单后即可由老人确认完成；当前订单状态不可确认"}), 409
            volunteer_id = int(order["volunteer_id"])

            hours = float(order.get("service_hours") or 1)
            # Elder confirmation may finish an accepted or in-progress visit.
            # Snap to serving completion so volunteer return / fatigue match
            # the normal volunteer-complete path.
            if order["status"] == "accepted":
                cursor.execute("UPDATE orders SET status = 'in_progress' WHERE order_id = %s", (order_id,))
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
            _archive_order_conversations(cursor, order_id, "老人已确认服务完成，会话已结束。老人/家属/志愿者可删除本会话；管理员仍保留归档。")
            conn.commit()
            return jsonify({"code": 200, "message": "已确认服务完成，志愿者正在返家，家属可审核服务时长", "data": {"return_route": return_route}})
    except Exception as exc:
        conn.rollback()
        return jsonify({"code": 500, "message": f"确认服务完成失败: {exc}"}), 500
    finally:
        conn.close()


@dispatch_bp.route("/orders/<int:order_id>/family-complete", methods=["POST"])
def family_complete_dispatch_order(order_id: int):
    """Let a bound family member confirm an in-progress service is finished."""
    data = request.get_json() or {}
    user_id = data.get("user_id")
    if not user_id:
        return jsonify({"code": 400, "message": "缺少家属账号"}), 400
    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute("SELECT order_id FROM orders WHERE order_id = %s FOR UPDATE", (order_id,))
            if not cursor.fetchone():
                return jsonify({"code": 404, "message": "订单不存在"}), 404
            order = _order_context(cursor, order_id)
            if not order:
                return jsonify({"code": 404, "message": "不是智能调度订单"}), 404
            allowed, role = _actor_can_touch_order(cursor, order, int(user_id))
            if not allowed or role != "family":
                return jsonify({"code": 403, "message": "无权确认该订单"}), 403
            if order["status"] not in ("accepted", "in_progress") or not order.get("volunteer_id"):
                return jsonify({"code": 409, "message": "志愿者接单后即可由家属确认完成；当前订单状态不可确认"}), 409
            volunteer_id = int(order["volunteer_id"])

            hours = float(order.get("service_hours") or 1)
            if order["status"] == "accepted":
                cursor.execute("UPDATE orders SET status = 'in_progress' WHERE order_id = %s", (order_id,))
            cursor.execute("UPDATE orders SET status = 'completed' WHERE order_id = %s", (order_id,))
            cursor.execute("UPDATE dispatch_orders SET dispatch_state = 'completed' WHERE order_id = %s", (order_id,))
            _mark_sos_service_completed(cursor, order_id, "family")
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
            _event(cursor, order_id, "family_confirmed_completion", "家属已确认服务完成；位置共享已停止，可继续审核志愿时长。", {"family_user_id": int(user_id), "volunteer_id": volunteer_id})
            if return_route:
                _event(cursor, order_id, "return_journey_started", "已生成紫色返家路线；返程展示后可继续自动匹配下一单。", {"volunteer_id": volunteer_id})
            _archive_order_conversations(cursor, order_id, "家属已确认服务完成，会话已结束。老人/家属/志愿者可删除本会话；管理员仍保留归档。")
            conn.commit()
            return jsonify({"code": 200, "message": "已确认服务完成，志愿者正在返家，可继续审核服务时长", "data": {"return_route": return_route}})
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
    navigation_mode = str(data.get("navigation_mode") or "driving").strip().lower()
    if navigation_mode not in {"driving", "riding", "walking"}:
        return jsonify({"code": 400, "message": "不支持的导航方式"}), 400
    restart_from_current = bool(data.get("restart_from_current"))
    try:
        eta_minutes = max(1, int(round(float(data.get("eta_minutes") or 1))))
    except (TypeError, ValueError):
        eta_minutes = 1
    try:
        distance_km = max(0.0, float(data.get("distance_km") or 0))
    except (TypeError, ValueError):
        distance_km = 0.0
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
                existing_segments = route.get("traffic_segments") or []
                # Two map surfaces may resolve the same route concurrently.
                # A response without TMC data must not erase colours already
                # published by a complete response. Explicit fresh TMC data is
                # still accepted so real congestion can genuinely clear.
                if existing_segments and not segments:
                    segments = existing_segments
                # Returning is intentionally always simulated as driving.
                route.update({
                    "path": path,
                    "traffic_segments": segments,
                    "geometry_source": "amap",
                    "navigation_mode": "driving",
                    "eta_minutes": eta_minutes,
                    "distance_km": distance_km or float(route.get("distance_km") or 0),
                })
                if restart_from_current:
                    route["progress"] = 0
                    route["motion_seconds"] = _demo_motion_seconds(eta_minutes, returning=True)
                    route.pop("arrival_pending_since", None)
                cursor.execute("UPDATE volunteer_return_routes SET route_json = %s, eta_minutes = %s, updated_at = CURRENT_TIMESTAMP WHERE volunteer_id = %s",
                               (json.dumps(route, ensure_ascii=False), eta_minutes, volunteer_id))
            else:
                cursor.execute("SELECT route_json FROM dispatch_routes WHERE order_id = %s FOR UPDATE", (order_id,))
                row = cursor.fetchone()
                if not row:
                    return jsonify({"code": 404, "message": "服务路线不存在"}), 404
                route = json.loads(row["route_json"])
                existing_segments = route.get("traffic_segments") or []
                if (
                    str(route.get("navigation_mode") or "driving") == navigation_mode
                    and existing_segments
                    and not segments
                ):
                    segments = existing_segments
                route.update({
                    "path": path,
                    "traffic_segments": segments,
                    "geometry_source": "amap",
                    "navigation_mode": navigation_mode,
                    "eta_minutes": eta_minutes,
                    "distance_km": distance_km or float(route.get("distance_km") or 0),
                })
                if restart_from_current:
                    route["progress"] = 0
                    route["motion_seconds"] = _demo_motion_seconds(eta_minutes)
                    route.pop("arrival_pending_since", None)
                cursor.execute("UPDATE dispatch_routes SET route_json = %s, eta_minutes = %s, replanned_at = CURRENT_TIMESTAMP WHERE order_id = %s",
                               (json.dumps(route, ensure_ascii=False), eta_minutes, order_id))
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
