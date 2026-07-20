# app.py
import json
import os
import threading
import time

from flask import Flask, jsonify, request
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
from routes.dispatch import dispatch_bp, ensure_dispatch_schema, run_dispatch_clock_tick
from db import get_db_connection

app = Flask(__name__)
# 允许前端跨域请求
CORS(app, supports_credentials=True)

# 注册所有蓝图，并分配基础路由前缀
app.register_blueprint(auth_bp, url_prefix='/api/auth')
app.register_blueprint(elder_bp, url_prefix='/api/elder')
app.register_blueprint(family_bp, url_prefix='/api/family')
app.register_blueprint(volunteer_bp, url_prefix='/api/volunteer')
app.register_blueprint(admin_bp, url_prefix='/api/admin')
app.register_blueprint(public_bp, url_prefix='/api/public')
app.register_blueprint(profile_bp, url_prefix='/api/profile')
app.register_blueprint(conversation_bp, url_prefix='/api/conversations')
app.register_blueprint(dispatch_bp, url_prefix='/api/dispatch')


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
    # 开启 debug=True，以后你修改任何 Python 代码，按 Ctrl+S 保存后，服务器会自动重启
    debug = os.getenv('FLASK_DEBUG', 'true').lower() in ('1', 'true', 'yes')
    app.run(host='0.0.0.0', port=int(os.getenv('PORT', '5000')), debug=debug)
