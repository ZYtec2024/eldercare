"""Password handling shared by authentication and demo-data migrations."""

from __future__ import annotations

import hmac
import ipaddress
import os
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
                    raw_ip VARCHAR(128) NULL,
                    ip_source VARCHAR(32) NULL,
                    login_success BOOLEAN NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            cursor.execute(
                """
                SELECT column_name
                FROM information_schema.columns
                WHERE table_name = 'login_audit_logs'
                  AND column_name IN ('raw_ip', 'ip_source')
                """
            )
            existing_columns = {row["column_name"] for row in cursor.fetchall() or []}
            if "raw_ip" not in existing_columns:
                cursor.execute("ALTER TABLE login_audit_logs ADD COLUMN raw_ip VARCHAR(128) NULL")
            if "ip_source" not in existing_columns:
                cursor.execute("ALTER TABLE login_audit_logs ADD COLUMN ip_source VARCHAR(32) NULL")
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


def _parse_ip(value: Any) -> ipaddress._BaseAddress | None:
    raw = str(value or "").strip().split(",", 1)[0].strip()
    if not raw:
        return None
    try:
        return ipaddress.ip_address(raw)
    except ValueError:
        return None


def _trusted_proxy_networks() -> list[ipaddress._BaseNetwork]:
    """CIDRs that may set X-Forwarded-For / X-Real-IP (Docker / host nginx)."""
    configured = os.getenv(
        "TRUSTED_PROXY_CIDRS",
        "127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16",
    )
    networks: list[ipaddress._BaseNetwork] = []
    for part in configured.split(","):
        text = part.strip()
        if not text:
            continue
        try:
            networks.append(ipaddress.ip_network(text, strict=False))
        except ValueError:
            continue
    return networks


def _is_trusted_proxy(ip_text: str) -> bool:
    parsed = _parse_ip(ip_text)
    if parsed is None:
        return False
    return any(parsed in network for network in _trusted_proxy_networks())


def _ignore_client_ips() -> set[str]:
    """Optional known wrong edge IPs (e.g. fixed WAN of the VM itself)."""
    configured = os.getenv("IGNORE_CLIENT_IPS", "")
    return {part.strip() for part in configured.split(",") if part.strip()}


def resolve_client_ip(headers: Any, remote_addr: Any) -> tuple[str, str, str]:
    """Return (raw_ip, masked_ip, source) for login risk review.

    Only trust proxy headers when the TCP peer is a private/trusted reverse
    proxy. Prefer CF/True-Client/X-Real-IP, then the first public hop in
    X-Forwarded-For that is not listed in IGNORE_CLIENT_IPS (e.g. the VM WAN).
    """
    remote = str(remote_addr or "").strip()
    ignore = _ignore_client_ips()

    def _accept(
        candidate: Any,
        source: str,
        *,
        skip_trusted: bool = False,
    ) -> tuple[str, str, str] | None:
        cleaned = str(candidate or "").strip().split(",", 1)[0].strip()
        if not cleaned or cleaned in ignore or _parse_ip(cleaned) is None:
            return None
        # Nested Docker proxies often put the bridge IP into X-Real-IP; skip
        # those and keep looking (usually the public hop is still in XFF).
        if skip_trusted and _is_trusted_proxy(cleaned):
            return None
        return cleaned, mask_client_ip(cleaned), source

    # Direct connection (or unknown peer): do not honor spoofable headers.
    if remote and not _is_trusted_proxy(remote):
        hit = _accept(remote, "remote")
        if hit:
            return hit

    for header_name, source in (
        ("CF-Connecting-IP", "cf"),
        ("True-Client-IP", "true-client"),
        ("X-Real-IP", "real-ip"),
    ):
        hit = _accept(headers.get(header_name), source, skip_trusted=True)
        if hit:
            return hit

    forwarded = str(headers.get("X-Forwarded-For") or "").strip()
    if forwarded:
        parts = [part.strip() for part in forwarded.split(",") if part.strip()]
        for part in parts:
            if _is_trusted_proxy(part) or part in ignore:
                continue
            hit = _accept(part, "forwarded")
            if hit:
                return hit
        hit = _accept(parts[0], "forwarded")
        if hit:
            return hit

    hit = _accept(remote, "remote")
    if hit:
        return hit
    return "unknown", mask_client_ip("unknown"), "remote"


def ensure_ip_blocklist_schema() -> None:
    """Create the risk-IP blocklist used by login and API guards."""
    conn = get_db_connection()
    if conn is None:
        return
    try:
        with conn.cursor() as cursor:
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS ip_blocklist (
                    block_id SERIAL PRIMARY KEY,
                    ip_address VARCHAR(64) NOT NULL UNIQUE,
                    reason VARCHAR(255) NULL,
                    created_by INT NULL REFERENCES users(user_id) ON DELETE SET NULL,
                    is_active BOOLEAN NOT NULL DEFAULT TRUE,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            cursor.execute(
                "CREATE INDEX IF NOT EXISTS idx_ip_blocklist_active ON ip_blocklist(is_active, ip_address)"
            )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def is_ip_blocked(raw_ip: str) -> bool:
    """Return True when an exact IP is currently blocked."""
    cleaned = str(raw_ip or "").strip().split(",", 1)[0].strip()
    if not cleaned or cleaned == "unknown":
        return False
    conn = get_db_connection()
    if conn is None:
        return False
    try:
        with conn.cursor() as cursor:
            cursor.execute(
                """
                SELECT 1 FROM ip_blocklist
                WHERE is_active = TRUE AND ip_address = %s
                LIMIT 1
                """,
                (cleaned,),
            )
            return cursor.fetchone() is not None
    except Exception:
        return False
    finally:
        conn.close()


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
