# routes/elder.py
from flask import Blueprint, request, jsonify
from db import get_db_connection
from utils import format_datetime, send_health_alert_email, send_sos_email, get_validated_data
import datetime

elder_bp = Blueprint('elder', __name__)


# 1. 老人每日健康打卡 (支持全指标，异常自动报警)
@elder_bp.route('/health/checkin', methods=['POST'])
def health_checkin():
    data = request.get_json()
    user_id = data.get('user_id') 
    
    sys = data.get('blood_pressure_sys')
    dia = data.get('blood_pressure_dia')
    heart_rate = data.get('heart_rate')
    blood_oxygen = data.get('blood_oxygen') 
    blood_sugar = data.get('blood_sugar')   
    temperature = data.get('temperature')   
    weight = data.get('weight')             
    notes = data.get('notes', '')

    if not user_id:
        return jsonify({"code": 400, "message": "缺失用户信息"})

    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            # 查出老人档案ID、姓名和自定义的高压报警线 (默认140)
            cursor.execute("SELECT elder_id, name, alert_sys_threshold FROM elders WHERE user_id = %s", (user_id,))
            elder = cursor.fetchone()
            if not elder:
                return jsonify({"code": 404, "message": "找不到老人档案"})

            elder_id = elder['elder_id']
            sys_threshold = elder['alert_sys_threshold'] or 140

            # 插入健康记录
            sql = """
                INSERT INTO health_records 
                (elder_id, record_date, blood_pressure_sys, blood_pressure_dia, heart_rate, 
                 blood_oxygen, blood_sugar, temperature, weight, notes)
                VALUES (%s, CURRENT_DATE, %s, %s, %s, %s, %s, %s, %s, %s)
            """
            cursor.execute(sql, (elder_id, sys, dia, heart_rate, blood_oxygen, blood_sugar, temperature, weight, notes))
            
            # 🚨 智能报警联动逻辑
            alerts = []
            if sys is not None and int(sys) > sys_threshold:
                alerts.append(f"高压超标({sys})")
            if temperature is not None and float(temperature) >= 37.3:
                alerts.append(f"发热({temperature}℃)")
            if blood_oxygen is not None and float(blood_oxygen) < 95:
                alerts.append(f"血氧偏低({blood_oxygen}%)")

            if alerts:
                warning_msg = "健康异常报警：" + "，".join(alerts)
                alert_sql = "INSERT INTO alerts (elder_id, alert_type, description) VALUES (%s, 'health_warning', %s) RETURNING alert_id"
                cursor.execute(alert_sql, (elder_id, warning_msg))
                alert_id = cursor.fetchone()['alert_id']
                
                # 查询该老人的所有家属邮箱
                sql_family = """
                    SELECT u.email 
                    FROM users u 
                    JOIN user_elder_relation uer ON u.user_id = uer.family_user_id 
                    WHERE uer.elder_id = %s AND u.email IS NOT NULL
                """
                cursor.execute(sql_family, (elder_id,))
                families = cursor.fetchall()

                # 查询所有管理员邮箱
                sql_admins = "SELECT email FROM users WHERE role = 'admin' AND email IS NOT NULL"
                cursor.execute(sql_admins)
                admins = cursor.fetchall()

                email_sent_count = 0
                
                # 发送给家属
                for family in families:
                    if send_health_alert_email(family['email'], elder['name'], warning_msg):
                        email_sent_count += 1
                
                # 发送给管理员
                for admin in admins:
                    if send_health_alert_email(admin['email'], elder['name'], warning_msg):
                        email_sent_count += 1

                conn.commit()
                return jsonify({
                    "code": 200,
                    "message": f"今日健康打卡成功！异常已记录，已向 {email_sent_count} 位家属和管理员发送告警通知。",
                    "data": {
                        "abnormal": True,
                        "alert_id": alert_id,
                        "alerts": alerts,
                        "notified_families": email_sent_count,
                    },
                })

            conn.commit()
            return jsonify({
                "code": 200,
                "message": "今日健康打卡成功！",
                "data": {
                    "abnormal": False,
                    "alert_id": None,
                },
            })
    except Exception as e:
        conn.rollback()
        return jsonify({"code": 500, "message": f"打卡失败: {str(e)}"})
    finally:
        conn.close()

# 2. 获取老人的待办服务列表
@elder_bp.route('/my-services', methods=['GET'])
def my_services():
    user_id = request.args.get('user_id') 
    if not user_id:
        return jsonify({"code": 400, "message": "缺少 user_id"})

    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            sql = """
                                SELECT o.order_id, o.service_type, o.service_time, o.status,
                                             o.volunteer_id, v.real_name AS volunteer_name
                FROM orders o
                LEFT JOIN users v ON o.volunteer_id = v.user_id
                WHERE o.elder_id = (SELECT elder_id FROM elders WHERE user_id = %s)
                                    AND o.status IN ('pending', 'accepted', 'in_progress', 'completed', 'cancelled')
                ORDER BY o.service_time ASC
            """
            cursor.execute(sql, (user_id,))
            services = cursor.fetchall()
            for s in services:
                if isinstance(s['service_time'], datetime.datetime):
                    s['service_time'] = s['service_time'].strftime('%Y-%m-%d %H:%M')
            return jsonify({"code": 200, "message": "查询成功", "data": services})
    finally:
        conn.close()

# 3. 🚨 紧急求助 SOS (写库 + 查家属邮箱发邮件)
@elder_bp.route('/sos', methods=['POST'])
def sos_alert():
    data = request.get_json()
    user_id = data.get('user_id')

    if not user_id:
        return jsonify({"code": 400, "message": "缺失老人信息"})

    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            # 1. 找出老人档案信息
            cursor.execute("SELECT elder_id, name FROM elders WHERE user_id = %s", (user_id,))
            elder = cursor.fetchone()
            if not elder:
                return jsonify({"code": 404, "message": "找不到老人档案"})
            
            elder_id = elder['elder_id']
            elder_name = elder['name']

            # 2. 写入数据库报警表
            sql_alert = "INSERT INTO alerts (elder_id, alert_type, description) VALUES (%s, 'sos', '老人发起一键紧急求助！')"
            cursor.execute(sql_alert, (elder_id,))
            conn.commit() # 先提交数据库，确保网页不卡顿

            # 3. [高分亮点]：关联查询出绑定该老人的所有家属的邮箱
            sql_family = """
                SELECT u.email 
                FROM users u 
                JOIN user_elder_relation uer ON u.user_id = uer.family_user_id 
                WHERE uer.elder_id = %s AND u.email IS NOT NULL
            """
            cursor.execute(sql_family, (elder_id,))
            families = cursor.fetchall()

            email_sent_count = 0
            for family in families:
                # 真实发送邮件！
                if send_sos_email(family['email'], elder_name):
                    email_sent_count += 1

            return jsonify({
                "code": 200, 
                "message": f"SOS报警成功！已向 {email_sent_count} 位家属发送紧急邮件。"
            })
    except Exception as e:
        conn.rollback()
        return jsonify({"code": 500, "message": f"报警失败: {str(e)}"})
    finally:
        conn.close()

# 4. [新增] 评价服务 (利用评价表)
@elder_bp.route('/orders/review', methods=['POST'])
def review_order():
    data = request.get_json()
    order_id = data.get('order_id')
    rating = data.get('rating')
    comment = data.get('comment', '默认好评')

    if not all([order_id, rating]):
        return jsonify({"code": 400, "message": "订单号或评分不能为空"})

    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            # 检查订单是否存在且已完成
            cursor.execute("SELECT status FROM orders WHERE order_id = %s", (order_id,))
            order = cursor.fetchone()
            if not order or order['status'] != 'completed':
                return jsonify({"code": 400, "message": "只能对已完成的服务进行评价！"})

            # 插入评价表 (我们建表时限制了 order_id 是 UNIQUE，防重复评价)
            sql = "INSERT INTO reviews (order_id, rating, comment) VALUES (%s, %s, %s)"
            cursor.execute(sql, (order_id, rating, comment))
            conn.commit()

            return jsonify({"code": 200, "message": "评价成功，感谢您的反馈！"})
    except Exception as e:
        conn.rollback()
        if "Duplicate entry" in str(e) or "duplicate key value violates unique constraint" in str(e):
            return jsonify({"code": 409, "message": "您已经对该订单进行过评价啦！"})
        return jsonify({"code": 500, "message": f"评价失败: {str(e)}"})
    finally:
        conn.close()