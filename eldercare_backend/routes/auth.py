# routes/auth.py
import json
import math
import os

from flask import Blueprint, request, jsonify, session
from db import get_db_connection
from auth_security import (
    PORTAL_SESSION_HEADER,
    hash_password,
    is_ip_blocked,
    issue_portal_session_token,
    resolve_client_ip,
    validate_new_password,
    verify_password,
    verify_portal_session_token,
)
from utils import api_response, get_validated_data
from region_service import fetch_district_children, geocode_address, is_active_region

auth_bp = Blueprint('auth', __name__)

_ALLOWED_REGISTER_ROLES = {'elder', 'volunteer', 'family', 'admin'}


def _login_response_data(cursor, user):
    review_status = 'none'
    is_root = False
    region_scopes: list[str] = []
    if user['role'] == 'volunteer':
        cursor.execute("SELECT audit_status FROM volunteers_profile WHERE user_id = %s", (user['user_id'],))
        profile = cursor.fetchone()
        if profile:
            review_status = 'pending_review' if profile['audit_status'] == 'pending' else profile['audit_status']
    if user['role'] == 'admin':
        cursor.execute(
            "SELECT region_adcode FROM admin_region_scope WHERE admin_user_id = %s",
            (user['user_id'],),
        )
        region_scopes = [str(row['region_adcode']) for row in cursor.fetchall()]
        is_root = '*' in region_scopes
    return {
        "user_id": user['user_id'],
        "username": user['username'],
        "role": user['role'],
        "real_name": user['real_name'],
        "email": user.get('email'),
        "review_status": review_status,
        "is_root": is_root,
        "region_scopes": region_scopes,
    }


@auth_bp.route('/regions/children', methods=['GET'])
def public_region_children():
    keywords = (request.args.get('keywords') or '中华人民共和国').strip()
    try:
        return jsonify({
            "code": 200,
            "message": "ok",
            "data": fetch_district_children(keywords, 1),
        })
    except Exception as exc:
        return jsonify({"code": 502, "message": str(exc), "data": []}), 502


# 1. 🚀 多角色动态注册 (含事务与邮箱写入)
@auth_bp.route('/register', methods=['POST'])
def register():
    data = request.get_json()
    username = data.get('username')
    password = data.get('password')
    role = data.get('role')
    real_name = data.get('real_name')
    phone = data.get('phone')
    email = data.get('email') # [V5.0 新增核心字段]
    
    if not all([username, password, role, real_name, phone, email]):
        return api_response({"code": 400, "message": "基础信息(含邮箱)填写不完整"}, 400)
    if role not in _ALLOWED_REGISTER_ROLES:
        return api_response({"code": 400, "message": "注册角色无效"}, 400)
    password, password_error = validate_new_password(password)
    if password_error:
        return api_response({"code": 400, "message": password_error}, 400)

    if role == 'admin':
        if data.get('invite_code') != 'SHU2024ADMIN':
            return api_response({"code": 403, "message": "管理员邀请码错误！"}, 403)

    resolved_address = None
    volunteer_region_adcode = ''
    if role == 'elder':
        province_name = str(data.get('province_name') or '').strip()
        city_name = str(data.get('city_name') or '').strip()
        district_name = str(data.get('district_name') or '').strip()
        region_adcode = str(data.get('region_adcode') or '').strip()
        detail_address = str(data.get('detail_address') or data.get('address') or '').strip()
        if not all([province_name, city_name, district_name, region_adcode, detail_address]):
            return api_response({"code": 400, "message": "请完整选择省、市、区县并填写详细地址"}, 400)
        if not is_active_region(region_adcode):
            return api_response({
                "code": 400,
                "message": "所选区县尚未开通服务，请选择已开通区域或联系总管理员开通",
            }, 400)
        try:
            resolved_address = geocode_address(
                f"{province_name}{city_name}{district_name}{detail_address}",
                region_adcode,
            )
        except Exception as exc:
            return api_response({"code": 400, "message": f"地址核验失败：{exc}"}, 400)
        if str(resolved_address.get('adcode') or '') != region_adcode:
            actual = resolved_address.get('district_name') or resolved_address.get('adcode') or '其他区县'
            return api_response({
                "code": 400,
                "message": f"该地址定位在「{actual}」，不属于所选「{district_name}」，请重新选择或填写",
            }, 400)
        resolved_address.update({
            'province_name': province_name,
            'city_name': city_name,
            'district_name': district_name,
            'region_adcode': region_adcode,
            'detail_address': detail_address,
        })
    elif role == 'volunteer':
        volunteer_region_adcode = str(data.get('region_adcode') or '').strip()
        if not volunteer_region_adcode:
            return api_response({"code": 400, "message": "志愿者必须选择服务区县"}, 400)
        if not is_active_region(volunteer_region_adcode):
            return api_response({
                "code": 400,
                "message": "所选区县尚未开通志愿服务，请选择已开通区域或联系总管理员开通",
            }, 400)
        if not str(data.get('skills') or '').strip():
            return api_response({"code": 400, "message": "请填写技能、证书或服务经验说明"}, 400)

    conn = get_db_connection()
    if conn is None:
        return api_response({"code": 500, "message": "数据库连接失败"}, 500)

    try:
        with conn.cursor() as cursor:
            # ============ 💎 数据库事务开始 ============
            cursor.execute(
                "SELECT username, phone, email FROM users WHERE username = %s OR phone = %s OR email = %s LIMIT 1",
                (username, phone, email),
            )
            existing = cursor.fetchone()
            if existing:
                if str(existing.get('username') or '') == str(username):
                    return api_response({"code": 409, "message": "该账号已被注册，请更换用户名"}, 409)
                if str(existing.get('phone') or '') == str(phone):
                    return api_response({"code": 409, "message": "该手机号已被注册，请更换手机号"}, 409)
                return api_response({"code": 409, "message": "该邮箱已被注册，请更换邮箱"}, 409)

            # 1. 创建底层登录账号 (带上 email)
            sql_user = """
                INSERT INTO users (username, password_hash, role, real_name, phone, email)
                VALUES (%s, %s, %s, %s, %s, %s)
                RETURNING user_id
            """
            cursor.execute(sql_user, (username, hash_password(password), role, real_name, phone, email))
            new_user_id = cursor.fetchone()['user_id']

            # 2. 角色分流插入
            if role == 'elder':
                age = data.get('age', 60)
                gender = data.get('gender', '男')
                address = resolved_address['formatted_address']
                # 允许自定义高压报警线，没传默认 140
                alert_sys = data.get('alert_sys_threshold', 140) 
                
                sql_elder = """
                    INSERT INTO elders (user_id, name, age, gender, address, alert_sys_threshold, region_adcode)
                    VALUES (%s, %s, %s, %s, %s, %s, %s)
                    RETURNING elder_id
                """
                cursor.execute(sql_elder, (
                    new_user_id, real_name, age, gender, address, alert_sys,
                    resolved_address['region_adcode'],
                ))
                elder_id = int(cursor.fetchone()['elder_id'])
                cursor.execute(
                    """INSERT INTO elder_location_state
                       (elder_id, lng, lat, location_source, is_home_fixed)
                       VALUES (%s, %s, %s, 'amap_geocode', TRUE)""",
                    (elder_id, resolved_address['lng'], resolved_address['lat']),
                )
                cursor.execute(
                    """INSERT INTO elder_addresses
                       (elder_id, label, province_name, city_name, district_name,
                        region_adcode, detail_address, full_address, lng, lat, is_current)
                       VALUES (%s, '家', %s, %s, %s, %s, %s, %s, %s, %s, TRUE)""",
                    (
                        elder_id,
                        resolved_address['province_name'],
                        resolved_address['city_name'],
                        resolved_address['district_name'],
                        resolved_address['region_adcode'],
                        resolved_address['detail_address'],
                        resolved_address['formatted_address'],
                        resolved_address['lng'],
                        resolved_address['lat'],
                    ),
                )
            
            elif role == 'volunteer':
                id_card = data.get('id_card')
                skills = str(data.get('skills') or '').strip()[:500]
                if not id_card:
                    conn.rollback()
                    return api_response({"code": 400, "message": "志愿者必须填写身份证号"}, 400)
                
                sql_vol = """
                    INSERT INTO volunteers_profile (user_id, id_card, skills, audit_status) 
                    VALUES (%s, %s, %s, 'pending')
                """
                cursor.execute(sql_vol, (new_user_id, id_card, skills))
                cursor.execute(
                    """SELECT adcode, name, center_lng, center_lat, bounds_json
                       FROM administrative_regions
                       WHERE adcode = %s AND active = TRUE""",
                    (volunteer_region_adcode,),
                )
                service_region = cursor.fetchone()
                if not service_region:
                    conn.rollback()
                    return api_response({
                        "code": 400,
                        "message": "所选区县尚未开通志愿服务，请选择已配置区域或联系总管理员开通",
                    }, 400)
                center_lng = service_region.get('center_lng')
                center_lat = service_region.get('center_lat')
                if center_lng is None or center_lat is None:
                    bounds = json.loads(service_region.get('bounds_json') or '{}')
                    center_lng = (float(bounds['west']) + float(bounds['east'])) / 2
                    center_lat = (float(bounds['south']) + float(bounds['north'])) / 2
                angle = math.radians((int(new_user_id) * 47) % 360)
                initial_lng = round(float(center_lng) + math.cos(angle) * 0.006, 6)
                initial_lat = round(float(center_lat) + math.sin(angle) * 0.004, 6)
                cursor.execute(
                    """INSERT INTO volunteer_location_state
                       (volunteer_id, lng, lat, availability, location_source,
                        home_lng, home_lat, auto_accept_enabled, service_region_adcode)
                       VALUES (%s, %s, %s, 'offline', 'registration_virtual',
                               %s, %s, FALSE, %s)""",
                    (
                        new_user_id,
                        initial_lng,
                        initial_lat,
                        initial_lng,
                        initial_lat,
                        volunteer_region_adcode,
                    ),
                )

            conn.commit()
            # ============ 事务结束 ============

            if role == 'volunteer':
                return api_response({"code": 200, "message": "注册成功！账号状态为需要审核，管理员确认后即可接单。"}, 200)
            return api_response({"code": 200, "message": "注册成功！"}, 200)

    except Exception as e:
        conn.rollback()
        if "Duplicate entry" in str(e) or "duplicate key value violates unique constraint" in str(e):
            return api_response({"code": 409, "message": "该账号已被注册，请更换用户名"}, 409)
        return api_response({"code": 500, "message": f"注册失败: {str(e)}"}, 500)
    finally:
        conn.close()

# 2. 登录 (同步志愿者审核状态)
@auth_bp.route('/login', methods=['POST'])
def login():
    data = request.get_json(silent=True) or {}
    username = data.get('username')
    password = data.get('password')
    if not username or not password:
        return api_response({"code": 400, "message": "请输入账号和密码"}, 400)

    conn = get_db_connection()
    if conn is None:
        return api_response({"code": 500, "message": "数据库连接失败"}, 500)

    try:
        with conn.cursor() as cursor:
            sql = "SELECT user_id, username, password_hash, role, real_name, email FROM users WHERE username = %s"
            cursor.execute(sql, (username,))
            user = cursor.fetchone()
            raw_ip, masked_ip, ip_source = resolve_client_ip(request.headers, request.remote_addr)
            if is_ip_blocked(raw_ip):
                cursor.execute(
                    """INSERT INTO login_audit_logs
                       (user_id, username, role, masked_ip, raw_ip, ip_source, login_success)
                       VALUES (%s, %s, %s, %s, %s, %s, FALSE)""",
                    (
                        user.get('user_id') if user else None,
                        str(username)[:50],
                        user.get('role') if user else None,
                        masked_ip,
                        raw_ip,
                        ip_source,
                    ),
                )
                conn.commit()
                return api_response({"code": 403, "message": "当前网络地址存在风险，已被限制登录"}, 403)

            if user and verify_password(user.get('password_hash'), password):
                # Compatibility for an old volume that was not reached by the
                # startup migration. Successful verification upgrades it now.
                if not str(user.get('password_hash') or '').startswith(('scrypt:', 'pbkdf2:')):
                    cursor.execute(
                        "UPDATE users SET password_hash = %s WHERE user_id = %s",
                        (hash_password(str(password)), user['user_id']),
                    )
                cursor.execute(
                    """INSERT INTO login_audit_logs
                       (user_id, username, role, masked_ip, raw_ip, ip_source, login_success)
                       VALUES (%s, %s, %s, %s, %s, %s, TRUE)""",
                    (user['user_id'], username, user['role'], masked_ip, raw_ip, ip_source),
                )
                conn.commit()
                session.clear()
                session.permanent = True
                session['user_id'] = int(user['user_id'])
                session['role'] = str(user['role'])
                response_data = _login_response_data(cursor, user)
                response_data["portal_session_token"] = issue_portal_session_token(
                    user['user_id'],
                    user['role'],
                )
                return api_response({
                    "code": 200,
                    "message": "登录成功",
                    "data": response_data,
                }, 200)
            else:
                cursor.execute(
                    """INSERT INTO login_audit_logs
                       (user_id, username, role, masked_ip, raw_ip, ip_source, login_success)
                       VALUES (%s, %s, %s, %s, %s, %s, FALSE)""",
                    (
                        user.get('user_id') if user else None,
                        str(username)[:50],
                        user.get('role') if user else None,
                        masked_ip,
                        raw_ip,
                        ip_source,
                    ),
                )
                conn.commit()
                return api_response({"code": 401, "message": "账号或密码错误"}, 401)
    finally:
        conn.close()


@auth_bp.route('/session', methods=['GET'])
def restore_login_session():
    portal_token = str(request.headers.get(PORTAL_SESSION_HEADER) or '').strip()
    portal_identity = verify_portal_session_token(portal_token) if portal_token else None
    if portal_token and not portal_identity:
        return api_response({"code": 401, "message": "当前标签页登录状态已失效"}, 401)
    user_id = portal_identity['user_id'] if portal_identity else session.get('user_id')
    if not user_id:
        return api_response({"code": 401, "message": "登录状态已失效"}, 401)
    conn = get_db_connection()
    if conn is None:
        return api_response({"code": 500, "message": "数据库连接失败"}, 500)
    try:
        with conn.cursor() as cursor:
            cursor.execute(
                """
                SELECT user_id, username, role, real_name, email
                FROM users
                WHERE user_id = %s
                """,
                (user_id,),
            )
            user = cursor.fetchone()
            if not user:
                session.clear()
                return api_response({"code": 401, "message": "账号不存在或已被移除"}, 401)
            response_data = _login_response_data(cursor, user)
            if portal_token:
                response_data["portal_session_token"] = portal_token
            else:
                # Upgrade a legacy cookie-only login to a tab-scoped session.
                response_data["portal_session_token"] = issue_portal_session_token(
                    user['user_id'],
                    user['role'],
                )
            return api_response({
                "code": 200,
                "message": "登录状态有效",
                "data": response_data,
            }, 200)
    finally:
        conn.close()


@auth_bp.route('/logout', methods=['POST'])
def logout():
    session.clear()
    return api_response({"code": 200, "message": "已退出登录"}, 200)


# 3. 修改密码（已登录用户）
@auth_bp.route('/change-password', methods=['POST'])
def change_password():
    data = request.get_json(silent=True) or {}
    user_id = data.get('user_id')
    old_password = data.get('old_password')
    new_password = data.get('new_password')
    if not user_id or not old_password or not new_password:
        return api_response({"code": 400, "message": "请填写原密码和新密码"}, 400)
    if int(user_id) != int(session.get('user_id') or 0):
        return api_response({"code": 403, "message": "只能修改当前登录账号的密码"}, 403)
    if str(old_password) == str(new_password):
        return api_response({"code": 400, "message": "新密码不能与原密码相同"}, 400)
    new_password, password_error = validate_new_password(new_password)
    if password_error:
        return api_response({"code": 400, "message": password_error}, 400)

    conn = get_db_connection()
    if conn is None:
        return api_response({"code": 500, "message": "数据库连接失败"}, 500)
    try:
        with conn.cursor() as cursor:
            cursor.execute(
                "SELECT user_id, password_hash FROM users WHERE user_id = %s",
                (user_id,),
            )
            user = cursor.fetchone()
            if not user:
                return api_response({"code": 404, "message": "用户不存在"}, 404)
            if not verify_password(user.get('password_hash'), old_password):
                return api_response({"code": 401, "message": "原密码不正确"}, 401)
            cursor.execute(
                "UPDATE users SET password_hash = %s WHERE user_id = %s",
                (hash_password(new_password), user_id),
            )
            conn.commit()
            return api_response({"code": 200, "message": "密码修改成功"}, 200)
    except Exception:
        conn.rollback()
        return api_response({"code": 500, "message": "密码修改失败"}, 500)
    finally:
        conn.close()


# 4. 忘记密码
@auth_bp.route('/forgot-password', methods=['POST'])
def forgot_password():
    if os.getenv('ALLOW_DEMO_PASSWORD_RESET', 'true').lower() not in ('1', 'true', 'yes'):
        return api_response({
            "code": 503,
            "message": "公网环境已关闭演示式密码重置，请联系管理员完成身份核验",
        }, 503)
    data = request.get_json(silent=True) or {}
    username = data.get('username')
    phone = data.get('phone')
    email = data.get('email')
    new_password = data.get('new_password')
    if not all([username, phone, email, new_password]):
        return api_response({"code": 400, "message": "请填写用户名、手机号、邮箱和新密码"}, 400)
    new_password, password_error = validate_new_password(new_password)
    if password_error:
        return api_response({"code": 400, "message": password_error}, 400)

    conn = get_db_connection()
    if conn is None:
        return api_response({"code": 500, "message": "数据库连接失败"}, 500)

    try:
        with conn.cursor() as cursor:
            sql = """
                UPDATE users
                SET password_hash = %s
                WHERE username = %s AND phone = %s AND LOWER(email) = LOWER(%s)
            """
            cursor.execute(sql, (hash_password(new_password), username, phone, email))
            if cursor.rowcount > 0:
                conn.commit()
                return api_response({"code": 200, "message": "密码重置成功"}, 200)
            return api_response({"code": 404, "message": "账号、手机号或邮箱不匹配"}, 404)
    except Exception as e:
        conn.rollback()
        return api_response({"code": 500, "message": "重置密码失败"}, 500)
    finally:
        conn.close()
