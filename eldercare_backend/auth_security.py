"""Password handling shared by authentication and demo-data migrations."""

from __future__ import annotations

import hmac
import ipaddress
import secrets
from typing import Any

from flask import current_app
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from werkzeug.security import check_password_hash, generate_password_hash

from db import get_db_connection


PASSWORD_HASH_METHOD = "scrypt"
PASSWORD_MIN_LENGTH = 8
PASSWORD_MAX_LENGTH = 128
_HASH_PREFIXES = ("scrypt:", "pbkdf2:")
PORTAL_SESSION_HEADER = "X-Portal-Session"
PORTAL_SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60
_PORTAL_SESSION_SALT = "eldercare.portal.session.v1"


def ensure_login_audit_schema() -> None:
    """Create the lightweight login audit table for existing data volumes."""
    conn = get_db_connection()
    if conn is None:
        return
    try:
        with conn.cursor() as cursor:
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS login_audit_logs (
                    audit_id SERIAL PRIMARY KEY,
                    user_id INT NULL REFERENCES users(user_id) ON DELETE SET NULL,
                    username VARCHAR(50) NOT NULL,
                    role VARCHAR(20) NULL,
                    masked_ip VARCHAR(64) NOT NULL,
                    login_success BOOLEAN NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            cursor.execute(
                "CREATE INDEX IF NOT EXISTS idx_login_audit_created_at ON login_audit_logs(created_at DESC)"
            )
            cursor.execute(
                "CREATE INDEX IF NOT EXISTS idx_login_audit_username ON login_audit_logs(username, created_at DESC)"
            )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def mask_client_ip(value: Any) -> str:
    """Retain enough network context for an audit without storing a full IP."""
    raw = str(value or "").strip().split(",", 1)[0].strip()
    if not raw:
        return "unknown"
    try:
        parsed = ipaddress.ip_address(raw)
    except ValueError:
        return "unknown"
    if isinstance(parsed, ipaddress.IPv4Address):
        first, _, _, last = raw.split(".")
        return f"{first}.***.***.{last}"
    groups = parsed.exploded.split(":")
    return f"{groups[0]}:{groups[1]}:****:****"


def _portal_session_serializer() -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(
        current_app.config["SECRET_KEY"],
        salt=_PORTAL_SESSION_SALT,
    )


def issue_portal_session_token(user_id: int, role: str) -> str:
    """Issue one signed identity for one browser tab."""
    return _portal_session_serializer().dumps({
        "user_id": int(user_id),
        "role": str(role),
        "nonce": secrets.token_urlsafe(12),
    })


def verify_portal_session_token(value: Any) -> dict[str, Any] | None:
    token = str(value or "").strip()
    if not token:
        return None
    try:
        payload = _portal_session_serializer().loads(
            token,
            max_age=PORTAL_SESSION_MAX_AGE_SECONDS,
        )
        user_id = int(payload.get("user_id") or 0)
        role = str(payload.get("role") or "")
        if user_id <= 0 or role not in {"admin", "elder", "family", "volunteer"}:
            return None
        return {"user_id": user_id, "role": role}
    except (BadSignature, SignatureExpired, TypeError, ValueError):
        return None


def validate_new_password(value: Any) -> tuple[str | None, str | None]:
    if not isinstance(value, str):
        return None, "密码格式无效"
    if len(value) < PASSWORD_MIN_LENGTH:
        return None, f"密码至少需要 {PASSWORD_MIN_LENGTH} 位"
    if len(value) > PASSWORD_MAX_LENGTH:
        return None, f"密码不能超过 {PASSWORD_MAX_LENGTH} 位"
    if not any(char.isalpha() for char in value) or not any(char.isdigit() for char in value):
        return None, "密码必须同时包含字母和数字"
    return value, None


def hash_password(password: str) -> str:
    return generate_password_hash(password, method=PASSWORD_HASH_METHOD)


def is_password_hash(stored_value: Any) -> bool:
    return str(stored_value or "").startswith(_HASH_PREFIXES)


def verify_password(stored_value: Any, candidate: Any) -> bool:
    stored = str(stored_value or "")
    supplied = str(candidate or "")
    if not stored or not supplied:
        return False
    if is_password_hash(stored):
        try:
            return check_password_hash(stored, supplied)
        except (ValueError, TypeError):
            return False
    # One-release compatibility for existing local volumes. Startup migration
    # normally removes every legacy value before the first request.
    return hmac.compare_digest(stored, supplied)


def migrate_legacy_password_hashes() -> int:
    """Replace all legacy plaintext values without changing their passwords."""
    conn = get_db_connection()
    if conn is None:
        return 0
    migrated = 0
    try:
        with conn.cursor() as cursor:
            cursor.execute("SELECT user_id, password_hash FROM users FOR UPDATE")
            for row in cursor.fetchall() or []:
                stored = row.get("password_hash")
                if not stored or is_password_hash(stored):
                    continue
                cursor.execute(
                    "UPDATE users SET password_hash = %s WHERE user_id = %s",
                    (hash_password(str(stored)), row["user_id"]),
                )
                migrated += 1
        conn.commit()
        return migrated
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
