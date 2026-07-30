# app.py
import json
import os
import threading
import time
from datetime import timedelta

from flask import Flask, g, jsonify, request, session
try:
    from flask_cors import CORS
except ImportError:
    def CORS(app, **kwargs):
        return app
from routes.profile import profile_bp
# 引入所有写好的路由蓝图
from routes.auth import auth_bp
from routes.elder import elder_bp
from routes.family import family_bp
from routes.volunteer import volunteer_bp
from routes.admin import admin_bp
from routes.public import public_bp
from routes.conversation import conversation_bp
from routes.ai import ai_bp
from routes.dispatch import dispatch_bp, ensure_dispatch_schema, run_dispatch_clock_tick
from routes.report import report_bp
from auth_security import (
    PORTAL_SESSION_HEADER,
    migrate_legacy_password_hashes,
    verify_portal_session_token,
)
from db import get_db_connection

app = Flask(__name__)
app.config.update(
    SECRET_KEY=os.getenv("SECRET_KEY", "dev-only-change-before-production"),
    SESSION_COOKIE_NAME="eldercare_session",
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=os.getenv("SESSION_COOKIE_SECURE", "false").lower() == "true",
    PERMANENT_SESSION_LIFETIME=timedelta(days=30),
    SESSION_REFRESH_EACH_REQUEST=True,
)
if app.config["SECRET_KEY"] == "dev-only-change-before-production":
    print("⚠️ 当前使用本地开发会话密钥；公网部署必须设置随机 SECRET_KEY")
# The browser normally talks to /api through the same-origin Nginx proxy.
# Explicit origins are retained only for local development or a separately
# hosted front end; wildcard credentialed CORS is intentionally forbidden.
cors_origins = [
    origin.strip()
    for origin in os.getenv(
        "CORS_ORIGINS",
        "http://127.0.0.1:3000,http://localhost:3000",
    ).split(",")
    if origin.strip()
]
CORS(app, supports_credentials=True, origins=cors_origins)

# 注册所有蓝图，并分配基础路由前缀
app.register_blueprint(auth_bp, url_prefix='/api/auth')
app.register_blueprint(elder_bp, url_prefix='/api/elder')
app.register_blueprint(family_bp, url_prefix='/api/family')
app.register_blueprint(volunteer_bp, url_prefix='/api/volunteer')
app.register_blueprint(admin_bp, url_prefix='/api/admin')
app.register_blueprint(public_bp, url_prefix='/api/public')
app.register_blueprint(profile_bp, url_prefix='/api/profile')
app.register_blueprint(conversation_bp, url_prefix='/api/conversations')
app.register_blueprint(ai_bp, url_prefix='/api')
app.register_blueprint(dispatch_bp, url_prefix='/api/dispatch')
app.register_blueprint(report_bp, url_prefix='/api/elder')


_PUBLIC_API_PATHS = {
    "/api/auth/login",
    "/api/auth/logout",
    "/api/auth/session",
    "/api/auth/register",
    "/api/auth/forgot-password",
    "/api/auth/regions/children",
}


@app.before_request
def require_authenticated_api_session():
    """Reject anonymous access to business APIs.

    A signed tab-scoped header takes precedence over the shared HttpOnly cookie,
    allowing different demo accounts to remain open in different tabs. Public
    home, registration and password-recovery endpoints remain available.
    Per-role and per-resource checks continue to live in their route handlers.
    """
    if request.method == "OPTIONS" or not request.path.startswith("/api/"):
        return None
    portal_token = str(request.headers.get(PORTAL_SESSION_HEADER) or "").strip()
    if portal_token:
        portal_identity = verify_portal_session_token(portal_token)
        if not portal_identity:
            if request.path != "/api/auth/login":
                return jsonify({"code": 401, "message": "当前标签页登录状态已失效，请重新登录"}), 401
        else:
            # Browser cookies are shared by tabs. Restore the identity carried
            # by this tab before any route-level authorization runs.
            g.portal_session_identity = portal_identity
            session.permanent = True
            session["user_id"] = int(portal_identity["user_id"])
            session["role"] = str(portal_identity["role"])
    if request.path in _PUBLIC_API_PATHS or request.path.startswith("/api/public/"):
        return None
    if not session.get("user_id"):
        return jsonify({"code": 401, "message": "登录状态已失效，请重新登录"}), 401
    return None


def init_db():
    """初始化数据库：添加缺失的列"""
    try:
        conn = get_db_connection()
        if not conn:
            print("⚠️ 数据库连接失败，跳过初始化")
            return
            
        with conn.cursor() as cursor:
            # 检查orders表是否有address列
            cursor.execute("""
                SELECT column_name FROM information_schema.columns 
                WHERE table_name='orders' AND column_name='address'
            """)
            
            if not cursor.fetchone():
                print("📝 检测到address列缺失，正在添加...")
                try:
                    cursor.execute("ALTER TABLE orders ADD COLUMN address VARCHAR(255) DEFAULT NULL")
                    conn.commit()
                    print("✓ address列已成功添加到orders表")
                except Exception as e:
                    print(f"⚠️ 添加address列时出错（可能已存在）: {e}")
                    conn.rollback()
            else:
                print("✓ address列已存在，数据库初始化完成")

            # 检查elders表是否有personality_bio列
            cursor.execute("""
                SELECT column_name FROM information_schema.columns
                WHERE table_name='elders' AND column_name='personality_bio'
            """)
            if not cursor.fetchone():
                print("📝 检测到elders表缺少personality_bio列，正在添加...")
                try:
                    cursor.execute("""
                        ALTER TABLE elders
                        ADD COLUMN personality_bio TEXT DEFAULT NULL,
                        ADD COLUMN bio_updated_by INT DEFAULT NULL,
                        ADD COLUMN bio_updated_at TIMESTAMP DEFAULT NULL
                    """)
                    conn.commit()
                    print("✓ personality_bio列已成功添加到elders表")
                except Exception as e:
                    print(f"⚠️ 添加personality_bio列时出错（可能已存在）: {e}")
                    conn.rollback()
            else:
                print("✓ personality_bio列已存在")

            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS volunteer_hour_reviews (
                    review_id SERIAL PRIMARY KEY,
                    order_id INT NOT NULL UNIQUE,
                    volunteer_id INT NOT NULL,
                    expected_hours NUMERIC(8,2) NOT NULL,
                    declared_hours NUMERIC(8,2) NOT NULL,
                    max_auto_hours NUMERIC(8,2) NOT NULL,
                    review_status VARCHAR(20) NOT NULL DEFAULT 'approved',
                    approved_hours NUMERIC(8,2),
                    review_note TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    reviewed_at TIMESTAMP NULL
                )
                """
            )
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS volunteer_award_requests (
                    request_id SERIAL PRIMARY KEY,
                    volunteer_id INT NOT NULL,
                    award_title VARCHAR(255) NOT NULL,
                    reason TEXT,
                    status VARCHAR(20) NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'approved', 'rejected')),
                    review_note TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    reviewed_at TIMESTAMP NULL,
                    FOREIGN KEY (volunteer_id) REFERENCES users(user_id) ON DELETE CASCADE
                )
                """
            )
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS ai_service_settings (
                    config_key VARCHAR(64) PRIMARY KEY,
                    config_value TEXT NOT NULL,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            conn.commit()
    except Exception as e:
        print(f"⚠️ 数据库初始化出错: {e}")
    finally:
        if conn:
            conn.close()

# 应用启动时运行数据库初始化
with app.app_context():
    init_db()
    ensure_dispatch_schema()
    migrated_passwords = migrate_legacy_password_hashes()
    if migrated_passwords:
        print(f"✓ 已将 {migrated_passwords} 个旧账号密码迁移为安全哈希")


def _dispatch_location_clock() -> None:
    """Run the simulated GPS/dispatch clock independently of browser polling."""
    while True:
        run_dispatch_clock_tick()
        time.sleep(1)


# The development server is started without Flask's reloader in this project.
# A daemon keeps the same persistent location state alive for every role.
threading.Thread(target=_dispatch_location_clock, name='dispatch-location-clock', daemon=True).start()


def snake_to_camel(name: str) -> str:
    parts = name.split('_')
    return parts[0] + ''.join(part.capitalize() for part in parts[1:]) if parts else name


def add_case_aliases(value):
    if isinstance(value, list):
        return [add_case_aliases(item) for item in value]

    if not isinstance(value, dict):
        return value

    normalized = {}
    for key, item in value.items():
        normalized[key] = add_case_aliases(item)

    for key, item in list(normalized.items()):
        if '_' not in key:
            continue

        alias = snake_to_camel(key)
        if alias not in normalized:
            normalized[alias] = item

    if 'list' in normalized and 'items' not in normalized:
        normalized['items'] = normalized['list']

    return normalized


@app.after_request
def normalize_json_response(response):
    if not request.path.startswith('/api/'):
        return response

    if not response.is_json:
        # Still advertise UTF-8 for plain JSON-like API payloads.
        if response.mimetype == 'application/json' and 'charset' not in (response.content_type or ''):
            response.headers['Content-Type'] = 'application/json; charset=utf-8'
        return response

    try:
        payload = response.get_json()
    except Exception:
        return response

    if payload is None:
        return response

    normalized = add_case_aliases(payload)
    # Explicit UTF-8 bytes + charset so Windows clients (PowerShell, Edge) do not
    # reinterpret Chinese as the system ANSI code page.
    response.set_data(json.dumps(normalized, ensure_ascii=False).encode('utf-8'))
    response.headers['Content-Type'] = 'application/json; charset=utf-8'
    return response


@app.after_request
def ensure_api_utf8_charset(response):
    """Guarantee charset on every /api response, including non-normalized ones."""
    if request.path.startswith('/api/'):
        content_type = response.headers.get('Content-Type', '')
        if content_type.startswith('application/json') and 'charset=' not in content_type.lower():
            response.headers['Content-Type'] = 'application/json; charset=utf-8'
    return response

# 测试服务器是否连通的根路由
@app.route('/')
def hello():
    return jsonify({
        "code": 200,
        "message": "🎉 恭喜！智慧伴老平台后端 API 运行正常！包含五大模块已全部加载。"
    })

if __name__ == '__main__':
    debug = os.getenv('FLASK_DEBUG', 'false').lower() in ('1', 'true', 'yes')
    app.run(host='0.0.0.0', port=int(os.getenv('PORT', '5000')), debug=debug)
