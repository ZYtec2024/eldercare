# routes/elder.py
from flask import Blueprint, request, jsonify
from db import get_db_connection
from region_service import is_active_region
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
                                             o.volunteer_id, v.real_name AS volunteer_name,
                                             d.dispatch_state,
                                             EXISTS(SELECT 1 FROM reviews r WHERE r.order_id = o.order_id) AS review_submitted
                FROM orders o
                LEFT JOIN users v ON o.volunteer_id = v.user_id
                LEFT JOIN dispatch_orders d ON d.order_id = o.order_id
                WHERE o.elder_id = (SELECT elder_id FROM elders WHERE user_id = %s)
                                    AND o.status IN ('pending', 'accepted', 'in_progress', 'completed', 'cancelled')
                ORDER BY o.service_time DESC
            """
            cursor.execute(sql, (user_id,))
            services = []
            for row in cursor.fetchall():
                service_time = row['service_time']
                if isinstance(service_time, datetime.datetime):
                    service_time = service_time.strftime('%Y-%m-%d %H:%M')
                status = row['status']
                can_complete = status in ('accepted', 'in_progress') and bool(row['volunteer_id'])
                services.append({
                    'orderId': int(row['order_id']),
                    'serviceType': row['service_type'],
                    'time': str(service_time or ''),
                    'status': status,
                    'volunteerId': int(row['volunteer_id']) if row['volunteer_id'] else None,
                    'volunteerName': row['volunteer_name'],
                    'dispatchState': row.get('dispatch_state'),
                    'reviewSubmitted': bool(row['review_submitted']),
                    'canReview': status == 'completed' and bool(row['volunteer_id']) and not bool(row['review_submitted']),
                    'canComplete': can_complete,
                })
            return jsonify({"code": 200, "message": "查询成功", "data": services})
    finally:
        conn.close()

# 3. 🚨 紧急求助 SOS (写库 + 查家属邮箱发邮件)
@elder_bp.route('/emergency/incidents', methods=['POST'])
def create_emergency_incident():
    """Create a local alert incident, optionally with a linked SOS service order."""
    data = request.get_json() or {}
    reporter_user_id = data.get('reporter_user_id') or data.get('user_id')
    elder_id = data.get('elder_id')
    incident_type = str(data.get('incident_type') or 'general_help')
    description = str(data.get('description') or '一键紧急求助')[:500]
    dispatch_service = bool(data.get('dispatch_service'))
    if not reporter_user_id:
        return jsonify({'code': 400, 'message': '缺少求助发起人'}), 400
    conn = get_db_connection()
    if not conn:
        return jsonify({'code': 500, 'message': '数据库连接失败'}), 500
    try:
        with conn.cursor() as cursor:
            cursor.execute('SELECT user_id, role FROM users WHERE user_id = %s', (reporter_user_id,))
            reporter = cursor.fetchone()
            if not reporter:
                return jsonify({'code': 404, 'message': '求助发起账号不存在'}), 404
            if not elder_id:
                cursor.execute('SELECT elder_id FROM elders WHERE user_id = %s', (reporter_user_id,))
                own_elder = cursor.fetchone()
                elder_id = own_elder['elder_id'] if own_elder else None
            cursor.execute('SELECT elder_id, user_id, name, region_adcode FROM elders WHERE elder_id = %s', (elder_id,))
            elder = cursor.fetchone()
            if not elder:
                return jsonify({'code': 404, 'message': '老人档案不存在'}), 404
            if reporter['role'] == 'family':
                cursor.execute('SELECT 1 FROM user_elder_relation WHERE family_user_id = %s AND elder_id = %s',
                               (reporter_user_id, elder_id))
                if not cursor.fetchone():
                    return jsonify({'code': 403, 'message': '您无权替该老人发起紧急求助'}), 403
            if reporter['role'] == 'elder' and int(elder['user_id']) != int(reporter_user_id):
                return jsonify({'code': 403, 'message': '老人账号只能为本人发起紧急求助'}), 403
            if reporter['role'] == 'admin':
                cursor.execute("SELECT 1 FROM admin_region_scope WHERE admin_user_id = %s AND region_adcode IN (%s, '*')",
                               (reporter_user_id, elder['region_adcode']))
                if not cursor.fetchone():
                    return jsonify({'code': 403, 'message': '您无权处理该区县紧急事件'}), 403
            if not is_active_region(elder.get('region_adcode')):
                return jsonify({'code': 400, 'message': '老人所属区县尚未开通或已停用，无法发起紧急求助'}), 400
            cursor.execute('''INSERT INTO emergency_incidents
                              (elder_id, region_adcode, incident_type, description, status, created_by)
                              VALUES (%s, %s, %s, %s, 'reported', %s) RETURNING incident_id''',
                           (elder_id, elder['region_adcode'], incident_type, description, reporter_user_id))
            incident_id = int(cursor.fetchone()['incident_id'])
            cursor.execute("""INSERT INTO alerts (elder_id, alert_type, description, emergency_incident_id)
                              VALUES (%s, 'sos', %s, %s) RETURNING alert_id""",
                           (elder_id, description, incident_id))
            alert_id = int(cursor.fetchone()['alert_id'])
            cursor.execute('SELECT family_user_id FROM user_elder_relation WHERE elder_id = %s', (elder_id,))
            recipient_ids = {int(row['family_user_id']) for row in cursor.fetchall()}
            # Root admins always receive every SOS; exactly one district admin is
            # assigned by least open-SOS load so the desk stays load-balanced.
            cursor.execute("SELECT admin_user_id FROM admin_region_scope WHERE region_adcode = '*'")
            root_admin_ids = {int(row['admin_user_id']) for row in cursor.fetchall()}
            recipient_ids.update(root_admin_ids)
            from routes.dispatch import _persist_sos_assigned_admin, _pick_least_loaded_district_admin
            assigned_admin_id = _pick_least_loaded_district_admin(cursor, str(elder['region_adcode']))
            if assigned_admin_id:
                recipient_ids.add(assigned_admin_id)
                _persist_sos_assigned_admin(cursor, incident_id, assigned_admin_id)
            for recipient_id in recipient_ids:
                cursor.execute('''INSERT INTO emergency_notifications
                                  (incident_id, recipient_user_id, recipient_role, notification_type)
                                  SELECT %s, u.user_id, u.role, 'in_app' FROM users u WHERE u.user_id = %s''',
                               (incident_id, recipient_id))
            cursor.execute('''INSERT INTO conversations (conversation_type, elder_id, incident_id)
                              VALUES ('sos', %s, %s) RETURNING conversation_id''', (elder_id, incident_id))
            conversation_id = int(cursor.fetchone()['conversation_id'])
            member_ids = recipient_ids | {int(elder['user_id']), int(reporter_user_id)}
            for member_id in member_ids:
                cursor.execute('SELECT role FROM users WHERE user_id = %s', (member_id,))
                member = cursor.fetchone()
                if member:
                    cursor.execute('''INSERT INTO conversation_members
                                      (conversation_id, user_id, role_in_conversation)
                                      VALUES (%s, %s, %s)''', (conversation_id, member_id, member['role']))
            assign_note = '已按本区平均负载指派分管理员跟进' if assigned_admin_id else '已通知总管理员'
            if assigned_admin_id:
                cursor.execute('SELECT real_name FROM users WHERE user_id = %s', (assigned_admin_id,))
                named = cursor.fetchone()
                if named and named.get('real_name'):
                    assign_note = f"已平均分配给分管理员 {named['real_name']} 跟进"
            cursor.execute('''INSERT INTO conversation_messages
                              (conversation_id, sender_user_id, message_type, content)
                              VALUES (%s, %s, 'system', %s)''',
                           (conversation_id, reporter_user_id, f'已发起紧急求助：{description}；{assign_note}'))
            order_id = None
            if dispatch_service:
                from routes.dispatch import create_smart_order_for_elder
                try:
                    order_id, _ = create_smart_order_for_elder(
                        cursor, elder_id=int(elder_id), created_by=int(reporter_user_id),
                        service_type='SOS紧急救助', notes=description, urgent=True,
                        proxy_created_by=int(reporter_user_id) if reporter['role'] != 'elder' else None,
                        proxy_reason='紧急求助代发' if reporter['role'] != 'elder' else None,
                        incident_id=incident_id,
                        conversation_id=conversation_id,
                        required_skills=data.get('required_skills') or data.get('preferred_skills'),
                    )
                except ValueError as exc:
                    conn.rollback()
                    return jsonify({'code': 400, 'message': str(exc)}), 400
                # create_smart_order already linked incident + conversation before assign.
            cursor.execute('''SELECT u.email FROM users u JOIN user_elder_relation r ON r.family_user_id = u.user_id
                              WHERE r.elder_id = %s AND u.email IS NOT NULL''', (elder_id,))
            family_emails = [row['email'] for row in cursor.fetchall()]
            conn.commit()
            for email in family_emails:
                try:
                    send_sos_email(email, elder['name'])
                except Exception:
                    pass
            return jsonify({'code': 200, 'message': '紧急事件已通知本区家属和管理员',
                            'data': {'incident_id': incident_id, 'alert_id': alert_id,
                                     'conversation_id': conversation_id, 'order_id': order_id}})
    except ValueError as exc:
        conn.rollback()
        return jsonify({'code': 400, 'message': str(exc)}), 400
    except Exception as exc:
        conn.rollback()
        return jsonify({'code': 500, 'message': f'创建紧急事件失败: {exc}'}), 500
    finally:
        conn.close()


@elder_bp.route('/emergency/incidents', methods=['GET'])
def list_emergency_incidents():
    """Return the SOS lifecycle visible to the elder, bound family, or scoped admin.

    The notification row is deliberately not used as the source of truth: an
    administrator acknowledging an SOS must remain visible to the elder until
    the incident has an explicit resolution.
    """
    raw_user_id = request.args.get('user_id')
    try:
        user_id = int(raw_user_id)
    except (TypeError, ValueError):
        return jsonify({'code': 400, 'message': '缺少查看人身份'}), 400

    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute('SELECT role FROM users WHERE user_id = %s', (user_id,))
            viewer = cursor.fetchone()
            if not viewer:
                return jsonify({'code': 404, 'message': '查看账号不存在'}), 404

            scope_sql = """
                (e.user_id = %s)
                OR EXISTS (SELECT 1 FROM user_elder_relation rel
                           WHERE rel.elder_id = e.elder_id AND rel.family_user_id = %s)
                OR (%s = 'admin' AND EXISTS (
                    SELECT 1 FROM admin_region_scope ars
                    WHERE ars.admin_user_id = %s AND ars.region_adcode = '*'
                ))
                OR (%s = 'admin' AND (
                    ei.assigned_admin_id = %s
                    OR EXISTS (
                        SELECT 1 FROM emergency_notifications en
                         WHERE en.incident_id = ei.incident_id AND en.recipient_user_id = %s
                    )
                ))
            """
            cursor.execute(f"""
                SELECT ei.incident_id, ei.incident_type, ei.description, ei.status,
                       ei.created_at, ei.acknowledged_at, ei.resolved_at, ei.resolution_summary,
                       e.name AS elder_name, e.address, o.order_id, o.status AS order_status,
                       c.conversation_id,
                       (SELECT a.alert_id FROM alerts a
                         WHERE a.emergency_incident_id = ei.incident_id
                         ORDER BY a.alert_id DESC LIMIT 1) AS alert_id
                FROM emergency_incidents ei
                JOIN elders e ON e.elder_id = ei.elder_id
                LEFT JOIN orders o ON o.order_id = ei.linked_order_id
                LEFT JOIN conversations c ON c.incident_id = ei.incident_id AND c.conversation_type = 'sos'
                WHERE {scope_sql}
                ORDER BY (ei.status <> 'resolved') DESC, ei.created_at DESC
                LIMIT 50
            """, (user_id, user_id, viewer['role'], user_id, viewer['role'], user_id, user_id))
            rows = cursor.fetchall()
            for row in rows:
                for field in ('created_at', 'acknowledged_at', 'resolved_at'):
                    if isinstance(row.get(field), datetime.datetime):
                        row[field] = format_datetime(row.get(field))
            return jsonify({'code': 200, 'message': '获取紧急事件成功', 'data': rows})
    finally:
        conn.close()


@elder_bp.route('/emergency/incidents/<int:incident_id>/cancel', methods=['POST'])
def cancel_emergency_incident(incident_id: int):
    """Let the elder cancel an open SOS; linked volunteer tasks disappear immediately."""
    data = request.get_json() or {}
    user_id = data.get('user_id') or data.get('reporter_user_id')
    if not user_id:
        return jsonify({'code': 400, 'message': '缺少老人账号'}), 400
    conn = get_db_connection()
    if not conn:
        return jsonify({'code': 500, 'message': '数据库连接失败'}), 500
    try:
        with conn.cursor() as cursor:
            cursor.execute(
                """SELECT ei.incident_id, ei.status, ei.linked_order_id, ei.elder_id, e.user_id AS elder_user_id
                   FROM emergency_incidents ei
                   JOIN elders e ON e.elder_id = ei.elder_id
                   WHERE ei.incident_id = %s FOR UPDATE""",
                (incident_id,),
            )
            incident = cursor.fetchone()
            if not incident:
                return jsonify({'code': 404, 'message': '紧急事件不存在'}), 404
            if int(incident['elder_user_id']) != int(user_id):
                return jsonify({'code': 403, 'message': '只能取消自己的紧急求助'}), 403
            if incident['status'] == 'resolved':
                return jsonify({'code': 200, 'message': '该求助已经结束'})

            linked_order_id = int(incident['linked_order_id']) if incident.get('linked_order_id') else None
            if linked_order_id:
                cursor.execute("SELECT order_id, status FROM orders WHERE order_id = %s FOR UPDATE", (linked_order_id,))
                order = cursor.fetchone()
                if order and order['status'] == 'in_progress':
                    return jsonify({
                        'code': 409,
                        'message': '志愿者已开始服务，请到「谁在帮我」确认完成服务，或联系管理员',
                    }), 409
                if order and order['status'] in ('pending', 'accepted'):
                    from routes.dispatch import finalize_cancelled_dispatch_order
                    finalize_cancelled_dispatch_order(
                        cursor,
                        linked_order_id,
                        actor_user_id=int(user_id),
                        event_type='elder_sos_cancelled',
                        event_message='老人已取消紧急求助，关联志愿服务与志愿者任务已同步关闭。',
                        emergency_summary='老人已取消紧急求助，关联志愿者任务已关闭',
                    )
                else:
                    cursor.execute(
                        """UPDATE emergency_incidents
                           SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP,
                               resolved_by = %s, resolution_summary = %s
                           WHERE incident_id = %s AND status <> 'resolved'""",
                        (int(user_id), '老人已取消紧急求助', incident_id),
                    )
                    cursor.execute("UPDATE alerts SET is_handled = TRUE WHERE emergency_incident_id = %s", (incident_id,))
                    cursor.execute(
                        """INSERT INTO conversation_messages (conversation_id, sender_user_id, message_type, content)
                           SELECT conversation_id, %s, 'system', '老人已取消本次紧急求助。'
                           FROM conversations WHERE incident_id = %s AND conversation_type = 'sos'""",
                        (int(user_id), incident_id),
                    )
                    cursor.execute(
                        """UPDATE conversations SET status = 'archived', archived_at = CURRENT_TIMESTAMP
                           WHERE incident_id = %s AND conversation_type = 'sos' AND status = 'active'""",
                        (incident_id,),
                    )
            else:
                cursor.execute(
                    """UPDATE emergency_incidents
                       SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP,
                           resolved_by = %s, resolution_summary = %s
                       WHERE incident_id = %s""",
                    (int(user_id), '老人已取消紧急求助', incident_id),
                )
                cursor.execute("UPDATE alerts SET is_handled = TRUE WHERE emergency_incident_id = %s", (incident_id,))
                cursor.execute(
                    """INSERT INTO conversation_messages (conversation_id, sender_user_id, message_type, content)
                       SELECT conversation_id, %s, 'system', '老人已取消本次紧急求助。'
                       FROM conversations WHERE incident_id = %s AND conversation_type = 'sos'""",
                    (int(user_id), incident_id),
                )
                cursor.execute(
                    """UPDATE conversations SET status = 'archived', archived_at = CURRENT_TIMESTAMP
                       WHERE incident_id = %s AND conversation_type = 'sos' AND status = 'active'""",
                    (incident_id,),
                )
            conn.commit()
            return jsonify({'code': 200, 'message': '已取消紧急求助，相关任务已同步关闭'})
    except Exception as exc:
        conn.rollback()
        return jsonify({'code': 500, 'message': f'取消紧急求助失败: {exc}'}), 500
    finally:
        conn.close()


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
            cursor.execute("SELECT volunteer_id FROM orders WHERE order_id = %s", (order_id,))
            assigned = cursor.fetchone()
            if assigned and assigned.get('volunteer_id'):
                cursor.execute("""SELECT AVG(r.rating) AS avg_rating FROM reviews r
                                  JOIN orders completed ON completed.order_id = r.order_id
                                  WHERE completed.volunteer_id = %s""", (assigned['volunteer_id'],))
                average = cursor.fetchone()
                if average and average.get('avg_rating') is not None:
                    cursor.execute("UPDATE volunteer_location_state SET service_rating = %s WHERE volunteer_id = %s",
                                   (round(float(average['avg_rating']), 2), assigned['volunteer_id']))
            conn.commit()

            return jsonify({"code": 200, "message": "评价成功，感谢您的反馈！"})
    except Exception as e:
        conn.rollback()
        if "Duplicate entry" in str(e) or "duplicate key value violates unique constraint" in str(e):
            return jsonify({"code": 409, "message": "您已经对该订单进行过评价啦！"})
        return jsonify({"code": 500, "message": f"评价失败: {str(e)}"})
    finally:
        conn.close()
