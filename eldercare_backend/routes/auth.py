# routes/auth.py
import json
import math

from flask import Blueprint, request, jsonify
from db import get_db_connection
from utils import api_response, get_validated_data
from region_service import fetch_district_children, geocode_address

auth_bp = Blueprint('auth', __name__)


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
        if not str(data.get('skills') or '').strip():
            return api_response({"code": 400, "message": "请填写技能、证书或服务经验说明"}, 400)

    conn = get_db_connection()
    if conn is None:
        return api_response({"code": 500, "message": "数据库连接失败"}, 500)

    try:
        with conn.cursor() as cursor:
            # ============ 💎 数据库事务开始 ============
            # 1. 创建底层登录账号 (带上 email)
            sql_user = """
                INSERT INTO users (username, password_hash, role, real_name, phone, email)
                VALUES (%s, %s, %s, %s, %s, %s)
                RETURNING user_id
            """
            cursor.execute(sql_user, (username, password, role, real_name, phone, email))
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
    data = request.get_json()
    username = data.get('username')
    password = data.get('password')

    conn = get_db_connection()
    if conn is None:
        return api_response({"code": 500, "message": "数据库连接失败"}, 500)

    try:
        with conn.cursor() as cursor:
            sql = "SELECT user_id, password_hash, role, real_name, email FROM users WHERE username = %s"
            cursor.execute(sql, (username,))
            user = cursor.fetchone()

            if user and user['password_hash'] == password:
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

                return api_response({
                    "code": 200,
                    "message": "登录成功",
                    "data": {
                        "user_id": user['user_id'],
                        "username": username,
                        "role": user['role'],
                        "real_name": user['real_name'],
                        "email": user.get('email'),
                        "review_status": review_status,
                        "is_root": is_root,
                        "region_scopes": region_scopes,
                        "token": f"token-{user['user_id']}" 
                    }
                }, 200)
            else:
                return api_response({"code": 401, "message": "账号或密码错误"}, 401)
    finally:
        conn.close()

# 3. 忘记密码
@auth_bp.route('/forgot-password', methods=['POST'])
def forgot_password():
    data = request.get_json()
    username = data.get('username')
    phone = data.get('phone')
    new_password = data.get('new_password')

    conn = get_db_connection()
    if conn is None:
        return api_response({"code": 500, "message": "数据库连接失败"}, 500)

    try:
        with conn.cursor() as cursor:
            sql = "UPDATE users SET password_hash = %s WHERE username = %s AND phone = %s"
            cursor.execute(sql, (new_password, username, phone))
            if cursor.rowcount > 0:
                conn.commit()
                return api_response({"code": 200, "message": "密码重置成功"}, 200)
            return api_response({"code": 404, "message": "账号或预留手机号不匹配"}, 404)
    except Exception as e:
        conn.rollback()
        return api_response({"code": 500, "message": "重置密码失败"}, 500)
    finally:
        conn.close()
