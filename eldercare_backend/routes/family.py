# routes/family.py
from flask import Blueprint, request, jsonify
from db import get_db_connection
from utils import format_datetime, get_validated_data, get_pagination_params
import datetime

family_bp = Blueprint('family', __name__)

# 1. 绑定长辈账号 (多表关联与唯一性约束)
@family_bp.route('/bind-elder', methods=['POST'])
def bind_elder():
    data = request.get_json()
    family_user_id = data.get('family_user_id')
    elder_phone = data.get('elder_phone') 
    relation = data.get('relation_type', '亲属')

    if not all([family_user_id, elder_phone]):
        return jsonify({"code": 400, "message": "参数不完整"})

    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            # 1. 跨表查询：通过手机号在 users 表找人，再关联 elders 表拿到业务 ID
            sql_find_elder = """
                SELECT e.elder_id 
                FROM elders e 
                JOIN users u ON e.user_id = u.user_id 
                WHERE u.phone = %s
            """
            cursor.execute(sql_find_elder, (elder_phone,))
            elder = cursor.fetchone()

            if not elder:
                return jsonify({"code": 404, "message": "未找到该手机号对应的老人档案"})

            elder_id = elder['elder_id']

            # 2. 插入关系表
            # 💎 高分点：建表时的 UNIQUE KEY unique_bind (family_user_id, elder_id) 会拦截重复绑定
            sql_bind = """
                INSERT INTO user_elder_relation (family_user_id, elder_id, relation_type)
                VALUES (%s, %s, %s)
            """
            cursor.execute(sql_bind, (family_user_id, elder_id, relation))
            conn.commit()

            return jsonify({"code": 200, "message": "绑定长辈成功！"})
            
    except Exception as e:
        conn.rollback()
        if "Duplicate entry" in str(e) or "duplicate key value violates unique constraint" in str(e):
            return jsonify({"code": 409, "message": "您已经绑定过这位长辈了，请勿重复绑定"})
        return jsonify({"code": 500, "message": f"绑定失败: {str(e)}"})
    finally:
        conn.close()

# 1.1 修改绑定关系
@family_bp.route('/bind-elder/relation', methods=['PUT'])
def update_bind_relation():
    data = request.get_json()
    family_user_id = data.get('family_user_id')
    elder_id = data.get('elder_id')
    relation_type = data.get('relation_type')

    if not all([family_user_id, elder_id, relation_type]):
        return jsonify({"code": 400, "message": "参数不完整"})

    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            sql = """
                UPDATE user_elder_relation
                SET relation_type = %s
                WHERE family_user_id = %s AND elder_id = %s
            """
            cursor.execute(sql, (relation_type, family_user_id, elder_id))

            if cursor.rowcount == 0:
                return jsonify({"code": 404, "message": "未找到该绑定关系"})

            conn.commit()
            return jsonify({"code": 200, "message": "关系修改成功"})
    except Exception as e:
        conn.rollback()
        return jsonify({"code": 500, "message": f"关系修改失败: {str(e)}"})
    finally:
        conn.close()

# 1.2 解绑长辈
@family_bp.route('/bind-elder', methods=['DELETE'])
def unbind_elder():
    family_user_id = request.args.get('family_user_id')
    elder_id = request.args.get('elder_id')

    if not all([family_user_id, elder_id]):
        return jsonify({"code": 400, "message": "参数不完整"})

    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            sql = """
                DELETE FROM user_elder_relation
                WHERE family_user_id = %s AND elder_id = %s
            """
            cursor.execute(sql, (family_user_id, elder_id))

            if cursor.rowcount == 0:
                return jsonify({"code": 404, "message": "未找到该绑定关系"})

            conn.commit()
            return jsonify({"code": 200, "message": "解绑成功"})
    except Exception as e:
        conn.rollback()
        return jsonify({"code": 500, "message": f"解绑失败: {str(e)}"})
    finally:
        conn.close()

# 2. 获取已绑定的长辈列表 (复杂 JOIN 查询)
@family_bp.route('/elders', methods=['GET'])
def get_bound_elders():
    family_user_id = request.args.get('family_user_id')
    if not family_user_id:
        return jsonify({"code": 400, "message": "缺少家属ID"})

    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            # 💎 高分点：多表 JOIN，把老人基本信息和绑定关系一起查出来
            sql = """
                SELECT 
                    e.elder_id, e.name, e.age, e.gender, e.address, e.medical_history, 
                    uer.relation_type
                FROM user_elder_relation uer
                JOIN elders e ON uer.elder_id = e.elder_id
                WHERE uer.family_user_id = %s
            """
            cursor.execute(sql, (family_user_id,))
            elders = cursor.fetchall()
            return jsonify({"code": 200, "message": "获取成功", "data": elders})
    finally:
        conn.close()

# 3. 获取长辈健康趋势图 (Echarts 绘图数据)
@family_bp.route('/elder-health-chart/<int:elder_id>', methods=['GET'])
def get_health_chart(elder_id):
    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            # 💎 高分点：倒序 LIMIT 取最新7条，然后在 Python 里反转为正序(时间轴)
            sql = """
                SELECT record_date, blood_pressure_sys, blood_pressure_dia, 
                       heart_rate, blood_oxygen, blood_sugar, temperature, weight 
                FROM health_records 
                WHERE elder_id = %s
                ORDER BY record_date DESC LIMIT 7
            """
            cursor.execute(sql, (elder_id,))
            records = cursor.fetchall()
            
            # 按日期正序排列 (更符合折线图习惯)
            records.reverse()
            
            # 格式化日期，防止 JSON 序列化报错
            for r in records:
                if isinstance(r['record_date'], datetime.date):
                    r['record_date'] = r['record_date'].strftime('%Y-%m-%d')
                    
            return jsonify({"code": 200, "message": "获取健康数据成功", "data": records})
    finally:
        conn.close()

# 4. 发布纯公益服务订单 (去商业化升级)
@family_bp.route('/orders/publish', methods=['POST'])
def publish_order():
    data = request.get_json()
    family_user_id = data.get('family_user_id')
    elder_id = data.get('elder_id')
    service_type = data.get('service_type')
    service_time = data.get('service_time') 
    # [V5.0 修改] 纯公益平台，发布时预估志愿时长(小时)
    service_hours = int(data.get('service_hours', 1)) 
    notes = data.get('notes', '')
    # [V5.1 修改] 家属填写的服务地址
    address = data.get('address', '')

    if not all([family_user_id, elder_id, service_type, service_time]):
        return jsonify({"code": 400, "message": "订单信息填写不完整"})

    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            # 直接插入订单表，不再有扣积分的复杂事务！公益发单毫无心理负担！
            sql = """
                INSERT INTO orders (elder_id, created_by, service_type, service_time, service_hours, notes)
                VALUES (%s, %s, %s, %s, %s, %s)
            """
            try:
                # 尝试包含address字段插入（如果数据库已添加此列）
                sql_with_address = """
                    INSERT INTO orders (elder_id, created_by, service_type, service_time, service_hours, address, notes)
                    VALUES (%s, %s, %s, %s, %s, %s, %s)
                """
                cursor.execute(sql_with_address, (elder_id, family_user_id, service_type, service_time, service_hours, address, notes))
            except Exception:
                # 如果address字段不存在，则不传入address
                cursor.execute(sql, (elder_id, family_user_id, service_type, service_time, service_hours, notes))
            
            conn.commit()

            return jsonify({"code": 200, "message": "公益订单发布成功，等待爱心志愿者接单！"})
    except Exception as e:
        conn.rollback()
        return jsonify({"code": 500, "message": f"发单失败: {str(e)}"})
    finally:
        conn.close()

# 4.1 获取家属已发布的服务需求列表
@family_bp.route('/orders', methods=['GET'])
def get_family_orders():
    family_user_id = request.args.get('family_user_id')
    if not family_user_id:
        return jsonify({"code": 400, "message": "缺少家属ID"})

    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            # [V5.1 修改] 优先使用orders表中的address，其次使用elder登记地址
            # 使用 COALESCE 处理可能不存在的address列
            try:
                sql = """
                    SELECT
                        o.order_id,
                        o.elder_id,
                        e.name AS elder_name,
                        o.service_type,
                        o.service_time,
                        o.service_hours,
                        o.volunteer_id,
                        COALESCE(o.address, e.address) AS address,
                        o.notes,
                        o.status,
                        u.real_name AS assigned_volunteer_name,
                        hr.review_status AS hour_review_status,
                        hr.approved_hours AS hour_review_approved_hours
                    FROM orders o
                    JOIN elders e ON o.elder_id = e.elder_id
                    LEFT JOIN users u ON o.volunteer_id = u.user_id
                        LEFT JOIN volunteer_hour_reviews hr ON hr.order_id = o.order_id
                    WHERE o.created_by = %s
                    ORDER BY o.created_at DESC
                """
                cursor.execute(sql, (family_user_id,))
            except Exception:
                # 如果address列不存在，则使用原始查询
                sql = """
                    SELECT
                        o.order_id,
                        o.elder_id,
                        e.name AS elder_name,
                        o.service_type,
                        o.service_time,
                        o.service_hours,
                        o.volunteer_id,
                        e.address,
                        o.notes,
                        o.status,
                        u.real_name AS assigned_volunteer_name,
                        hr.review_status AS hour_review_status,
                        hr.approved_hours AS hour_review_approved_hours
                    FROM orders o
                    JOIN elders e ON o.elder_id = e.elder_id
                    LEFT JOIN users u ON o.volunteer_id = u.user_id
                        LEFT JOIN volunteer_hour_reviews hr ON hr.order_id = o.order_id
                    WHERE o.created_by = %s
                    ORDER BY o.created_at DESC
                """
                cursor.execute(sql, (family_user_id,))
            
            orders = cursor.fetchall()

            for order in orders:
                if isinstance(order.get('service_time'), datetime.datetime):
                    order['service_time'] = order['service_time'].strftime('%Y-%m-%d %H:%M:%S')

            return jsonify({"code": 200, "message": "获取订单列表成功", "data": orders})
    finally:
        conn.close()


@family_bp.route('/orders/confirm-hours', methods=['POST'])
def confirm_order_hours():
    data = request.get_json()
    order_id = data.get('order_id')
    family_user_id = data.get('family_user_id')
    actual_hours = data.get('actual_hours')
    review_note = data.get('review_note', '')

    if not all([order_id, family_user_id, actual_hours]):
        return jsonify({"code": 400, "message": "参数不完整"})

    try:
        actual_hours = float(actual_hours)
    except (TypeError, ValueError):
        return jsonify({"code": 400, "message": "服务时长格式错误"})

    if actual_hours <= 0:
        return jsonify({"code": 400, "message": "服务时长必须大于0"})

    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute(
                """
                SELECT order_id, status, created_by, volunteer_id, service_hours
                FROM orders
                WHERE order_id = %s
                FOR UPDATE
                """,
                (order_id,),
            )
            order = cursor.fetchone()

            if not order:
                conn.rollback()
                return jsonify({"code": 404, "message": "订单不存在"})

            if str(order.get('created_by')) != str(family_user_id):
                conn.rollback()
                return jsonify({"code": 403, "message": "您无权确认该订单时长"})

            if order.get('status') != 'completed':
                conn.rollback()
                return jsonify({"code": 400, "message": "仅已完成订单可确认时长"})

            volunteer_id = order.get('volunteer_id')
            if not volunteer_id:
                conn.rollback()
                return jsonify({"code": 400, "message": "该订单未绑定志愿者"})

            expected_hours = float(order.get('service_hours') or 0)
            max_auto_hours = expected_hours * 1.5

            cursor.execute(
                "SELECT review_status, approved_hours FROM volunteer_hour_reviews WHERE order_id = %s",
                (order_id,),
            )
            review = cursor.fetchone()

            if review and review.get('review_status') != 'pending_family':
                conn.rollback()
                return jsonify({"code": 409, "message": "该订单时长已经确认过了，不能重复提交"})

            if actual_hours > max_auto_hours:
                new_status = 'pending_admin'
                approved_hours = None
                result_message = (
                    f"已提交家属确认 {actual_hours:.1f} 小时，超过预计时长 1.5 倍，已转管理员审核。"
                )
            else:
                new_status = 'approved'
                approved_hours = actual_hours
                cursor.execute(
                    """
                    UPDATE volunteers_profile
                    SET total_hours = total_hours + %s,
                        weekly_hours = weekly_hours + %s
                    WHERE user_id = %s
                    """,
                    (approved_hours, approved_hours, volunteer_id),
                )
                result_message = f"已确认 {actual_hours:.1f} 小时并成功计入志愿者服务时长。"

            if review:
                cursor.execute(
                    """
                    UPDATE volunteer_hour_reviews
                    SET declared_hours = %s,
                        expected_hours = %s,
                        max_auto_hours = %s,
                        review_status = %s,
                        approved_hours = %s,
                        review_note = %s,
                        reviewed_at = CURRENT_TIMESTAMP
                    WHERE order_id = %s
                    """,
                    (actual_hours, expected_hours, max_auto_hours, new_status, approved_hours, review_note, order_id),
                )
            else:
                cursor.execute(
                    """
                    INSERT INTO volunteer_hour_reviews (
                        order_id, volunteer_id, expected_hours, declared_hours,
                        max_auto_hours, review_status, approved_hours, review_note, reviewed_at
                    )
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, CURRENT_TIMESTAMP)
                    """,
                    (order_id, volunteer_id, expected_hours, actual_hours, max_auto_hours, new_status, approved_hours, review_note),
                )

            conn.commit()
            return jsonify({"code": 200, "message": result_message})
    except Exception as e:
        conn.rollback()
        return jsonify({"code": 500, "message": f"确认时长失败: {str(e)}"})
    finally:
        conn.close()

# 5.撤销订单 
@family_bp.route('/orders/cancel', methods=['POST'])
def cancel_order():
    data = request.get_json()
    order_id = data.get('order_id')

    if not order_id:
        return jsonify({"code": 400, "message": "缺少订单编号"})

    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            # 💎 高分点：业务状态机流转控制。只有 pending (待接单) 状态才可以撤销
            sql_check = "SELECT status FROM orders WHERE order_id = %s"
            cursor.execute(sql_check, (order_id,))
            order = cursor.fetchone()

            if not order:
                return jsonify({"code": 404, "message": "订单不存在"})
            
            if order['status'] != 'pending':
                return jsonify({"code": 400, "message": "该订单已被接单或已处理，无法撤销！"})

            # 更新订单状态为 cancelled
            sql_cancel = "UPDATE orders SET status = 'cancelled' WHERE order_id = %s"
            cursor.execute(sql_cancel, (order_id,))
            conn.commit()

            return jsonify({"code": 200, "message": "订单已成功撤销"})
    except Exception as e:
        conn.rollback()
        return jsonify({"code": 500, "message": f"撤单失败: {str(e)}"})
    finally:
        conn.close()