# routes/auth.py
from flask import Blueprint, request, jsonify
from db import get_db_connection
from utils import api_response, get_validated_data

auth_bp = Blueprint('auth', __name__)

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
                address = data.get('address', '未填写')
                # 允许自定义高压报警线，没传默认 140
                alert_sys = data.get('alert_sys_threshold', 140) 
                
                sql_elder = """
                    INSERT INTO elders (user_id, name, age, gender, address, alert_sys_threshold) 
                    VALUES (%s, %s, %s, %s, %s, %s)
                """
                cursor.execute(sql_elder, (new_user_id, real_name, age, gender, address, alert_sys))
            
            elif role == 'volunteer':
                id_card = data.get('id_card')
                skills = data.get('skills', '热心群众')
                if not id_card:
                    conn.rollback()
                    return api_response({"code": 400, "message": "志愿者必须填写身份证号"}, 400)
                
                sql_vol = """
                    INSERT INTO volunteers_profile (user_id, id_card, skills, audit_status) 
                    VALUES (%s, %s, %s, 'pending')
                """
                cursor.execute(sql_vol, (new_user_id, id_card, skills))

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