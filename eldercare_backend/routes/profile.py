# routes/profile.py
from flask import Blueprint, request, jsonify
from db import get_db_connection
from utils import get_validated_data

profile_bp = Blueprint('profile', __name__)

# 1. 获取个人详细信息 (多表 JOIN 经典运用)
@profile_bp.route('/info', methods=['GET'])
def get_profile_info():
    user_id = request.args.get('user_id')
    role = request.args.get('role')

    if not user_id or not role:
        return jsonify({"code": 400, "message": "参数不完整"})

    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            # 基础信息 (所有人都有)
            sql_base = "SELECT real_name, phone, email, created_at FROM users WHERE user_id = %s"
            cursor.execute(sql_base, (user_id,))
            user_info = cursor.fetchone()

            if not user_info:
                return jsonify({"code": 404, "message": "用户不存在"})

            # 根据角色拉取额外的扩展信息
            if role == 'elder':
                sql_ext = "SELECT age, gender, address, medical_history, alert_sys_threshold FROM elders WHERE user_id = %s"
                cursor.execute(sql_ext, (user_id,))
                elder_ext = cursor.fetchone()
                if elder_ext:
                    user_info.update(elder_ext) # 将字典合并返回前端

            elif role == 'volunteer':
                sql_ext = "SELECT id_card, skills, total_hours, weekly_hours, awards, likes_count FROM volunteers_profile WHERE user_id = %s"
                cursor.execute(sql_ext, (user_id,))
                vol_ext = cursor.fetchone()
                if vol_ext:
                    user_info.update(vol_ext)

            return jsonify({"code": 200, "message": "获取成功", "data": user_info})
    finally:
        conn.close()

# 2. 全局个人信息更新 (跨表级联更新事务)
@profile_bp.route('/update', methods=['POST'])
def update_profile():
    data = request.get_json()
    user_id = data.get('user_id')
    role = data.get('role')

    if not user_id or not role:
        return jsonify({"code": 400, "message": "缺失关键识别参数"})

    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            # ============ 💎 跨表更新事务开始 ============
            # 1. 更新 users 总表的通用字段 (手机号, 邮箱)
            phone = data.get('phone')
            email = data.get('email')
            if phone and email:
                sql_users = "UPDATE users SET phone = %s, email = %s WHERE user_id = %s"
                cursor.execute(sql_users, (phone, email, user_id))

            # 2. 角色特定表更新
            if role == 'elder':
                medical_history = data.get('medical_history')
                sys_threshold = data.get('alert_sys_threshold')
                if medical_history is not None:
                    sql_elder_history = "UPDATE elders SET medical_history = %s WHERE user_id = %s"
                    cursor.execute(sql_elder_history, (medical_history, user_id))

                if sys_threshold is not None:
                    sql_elder_threshold = "UPDATE elders SET alert_sys_threshold = %s WHERE user_id = %s"
                    cursor.execute(sql_elder_threshold, (sys_threshold, user_id))
            
            elif role == 'volunteer':
                skills = data.get('skills')
                if skills is not None:
                    sql_vol = "UPDATE volunteers_profile SET skills = %s WHERE user_id = %s"
                    cursor.execute(sql_vol, (skills, user_id))

            conn.commit()
            # ============ 事务结束 ============
            return jsonify({"code": 200, "message": "个人信息更新成功！"})
            
    except Exception as e:
        conn.rollback()
        return jsonify({"code": 500, "message": f"更新失败: {str(e)}"})
    finally:
        conn.close()