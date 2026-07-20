# routes/admin.py
from flask import Blueprint, request, jsonify
from db import get_db_connection
from utils import format_datetime, split_awards_text, merge_awards_text, get_pagination_params
import datetime

admin_bp = Blueprint('admin', __name__)


def _admin_regions(cursor, raw_admin_user_id):
    """Return (admin_id, is_global, regions, error_response).

    Admin pages in this legacy API receive the logged-in id explicitly.  The
    database scope, rather than a UI-selected district, is the authority.
    """
    try:
        admin_user_id = int(raw_admin_user_id)
    except (TypeError, ValueError):
        return None, False, set(), (jsonify({"code": 400, "message": "缺少管理员身份"}), 400)

    cursor.execute("SELECT role FROM users WHERE user_id = %s", (admin_user_id,))
    account = cursor.fetchone()
    if not account or account.get('role') != 'admin':
        return None, False, set(), (jsonify({"code": 403, "message": "仅管理员可访问"}), 403)

    cursor.execute("SELECT region_adcode FROM admin_region_scope WHERE admin_user_id = %s", (admin_user_id,))
    scopes = {str(row['region_adcode']) for row in cursor.fetchall()}
    if '*' in scopes:
        return admin_user_id, True, set(), None
    if not scopes:
        return None, False, set(), (jsonify({"code": 403, "message": "该管理员未分配区县管理范围"}), 403)
    return admin_user_id, False, scopes, None


def _user_regions(cursor, user_id):
    """Resolve a user's operational regions, including families bound to elders."""
    cursor.execute(
        """
        SELECT region_adcode FROM elders WHERE user_id = %s
        UNION
        SELECT service_region_adcode AS region_adcode
        FROM volunteer_location_state WHERE volunteer_id = %s
        UNION
        SELECT e.region_adcode
        FROM user_elder_relation rel
        JOIN elders e ON e.elder_id = rel.elder_id
        WHERE rel.family_user_id = %s
        """,
        (user_id, user_id, user_id),
    )
    return {str(row['region_adcode']) for row in cursor.fetchall() if row.get('region_adcode')}


def _scope_allows_user(cursor, user_id, is_global, regions):
    return is_global or bool(_user_regions(cursor, user_id) & regions)


def _region_user_filter_sql():
    """SQL fragment: users who operate in the given region tuple (%s x3)."""
    return """u.user_id IN (
        SELECT user_id FROM elders WHERE region_adcode IN %s
        UNION SELECT volunteer_id FROM volunteer_location_state WHERE service_region_adcode IN %s
        UNION SELECT rel.family_user_id FROM user_elder_relation rel
              JOIN elders e ON e.elder_id = rel.elder_id WHERE e.region_adcode IN %s
    )"""


def _enrich_admin_users(cursor, users):
    """Attach district and elder-binding context for admin CRM views."""
    if not users:
        return []
    user_ids = tuple(int(row['user_id']) for row in users)
    placeholders = ','.join(['%s'] * len(user_ids))

    elder_by_user: dict[int, dict] = {}
    cursor.execute(
        f"""SELECT e.user_id, e.elder_id, e.name, e.address, e.region_adcode,
                   COALESCE(ar.name, e.region_adcode) AS region_name
            FROM elders e
            LEFT JOIN administrative_regions ar ON ar.adcode = e.region_adcode
            WHERE e.user_id IN ({placeholders})""",
        user_ids,
    )
    for row in cursor.fetchall():
        elder_by_user[int(row['user_id'])] = {
            'elder_id': int(row['elder_id']),
            'name': row['name'],
            'address': row.get('address') or '',
            'region_adcode': row.get('region_adcode'),
            'region_name': row.get('region_name') or row.get('region_adcode') or '',
        }

    family_elders: dict[int, list[dict]] = {}
    cursor.execute(
        f"""SELECT rel.family_user_id, e.elder_id, e.name, e.region_adcode,
                   COALESCE(ar.name, e.region_adcode) AS region_name
            FROM user_elder_relation rel
            JOIN elders e ON e.elder_id = rel.elder_id
            LEFT JOIN administrative_regions ar ON ar.adcode = e.region_adcode
            WHERE rel.family_user_id IN ({placeholders})
            ORDER BY e.elder_id""",
        user_ids,
    )
    for row in cursor.fetchall():
        family_elders.setdefault(int(row['family_user_id']), []).append({
            'elder_id': int(row['elder_id']),
            'name': row['name'],
            'region_adcode': row.get('region_adcode'),
            'region_name': row.get('region_name') or row.get('region_adcode') or '',
        })

    volunteer_region: dict[int, dict] = {}
    cursor.execute(
        f"""SELECT v.volunteer_id, v.service_region_adcode AS region_adcode,
                   COALESCE(ar.name, v.service_region_adcode) AS region_name
            FROM volunteer_location_state v
            LEFT JOIN administrative_regions ar ON ar.adcode = v.service_region_adcode
            WHERE v.volunteer_id IN ({placeholders})""",
        user_ids,
    )
    for row in cursor.fetchall():
        volunteer_region[int(row['volunteer_id'])] = {
            'region_adcode': row.get('region_adcode'),
            'region_name': row.get('region_name') or row.get('region_adcode') or '',
        }

    enriched = []
    for row in users:
        item = dict(row)
        uid = int(item['user_id'])
        role = item.get('role')
        region_adcodes: list[str] = []
        region_names: list[str] = []
        related_elders: list[dict] = []
        address = ''

        if role == 'elder' and uid in elder_by_user:
            profile = elder_by_user[uid]
            address = profile['address']
            if profile.get('region_adcode'):
                region_adcodes = [str(profile['region_adcode'])]
                region_names = [profile['region_name']]
        elif role == 'family':
            related_elders = family_elders.get(uid, [])
            for elder in related_elders:
                code = str(elder.get('region_adcode') or '')
                if code and code not in region_adcodes:
                    region_adcodes.append(code)
                    region_names.append(elder.get('region_name') or code)
        elif role == 'volunteer' and uid in volunteer_region:
            profile = volunteer_region[uid]
            if profile.get('region_adcode'):
                region_adcodes = [str(profile['region_adcode'])]
                region_names = [profile['region_name']]

        item['region_adcodes'] = region_adcodes
        item['region_names'] = region_names
        item['related_elders'] = related_elders
        item['address'] = address
        enriched.append(item)
    return enriched


# 1. 获取用户列表 (带分页与角色 / 区县筛选)
@admin_bp.route('/users/list', methods=['GET'])
def get_user_list():
    role = request.args.get('role')
    keyword = (request.args.get('keyword') or '').strip()
    requested_region = (request.args.get('region_adcode') or '').strip()
    page = int(request.args.get('page', 1))
    limit = int(request.args.get('limit', 10))
    offset = (page - 1) * limit

    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            _, is_global, regions, error = _admin_regions(cursor, request.args.get('admin_user_id'))
            if error:
                return error

            filter_regions = None
            if requested_region:
                if is_global or requested_region in regions:
                    filter_regions = {requested_region}
                else:
                    return jsonify({"code": 403, "message": "无权查看该区县用户"}), 403
            elif not is_global:
                filter_regions = set(regions)

            region_filter = ""
            scope_params = []
            if filter_regions is not None:
                scoped = tuple(filter_regions)
                region_filter = _region_user_filter_sql()
                scope_params = [scoped, scoped, scoped]

            base_sql = """
                SELECT
                    u.user_id,
                    u.username,
                    u.role,
                    u.real_name,
                    u.phone,
                    u.email,
                    CASE
                        WHEN u.role = 'volunteer' THEN COALESCE(vp.audit_status, 'pending')
                        ELSE 'active'
                    END AS status
                FROM users u
                LEFT JOIN volunteers_profile vp ON u.user_id = vp.user_id
            """
            count_sql = "SELECT COUNT(*) AS total FROM users u"
            params = []

            if region_filter:
                base_sql += " WHERE " + region_filter
                count_sql += " WHERE " + region_filter

            if role:
                base_sql += " AND u.role = %s" if region_filter else " WHERE u.role = %s"
                count_sql += " AND u.role = %s" if region_filter else " WHERE u.role = %s"
                params.append(role)

            if keyword:
                clause = "(u.username ILIKE %s OR u.real_name ILIKE %s OR u.phone ILIKE %s)"
                base_sql += " AND " + clause if (region_filter or role) else " WHERE " + clause
                count_sql += " AND " + clause if (region_filter or role) else " WHERE " + clause
                params.extend([f"%{keyword}%", f"%{keyword}%", f"%{keyword}%"])

            cursor.execute(count_sql, tuple(scope_params + params))
            total_count = cursor.fetchone()['total']

            base_sql += " ORDER BY u.created_at DESC LIMIT %s OFFSET %s"
            params.extend([limit, offset])

            cursor.execute(base_sql, tuple(scope_params + params))
            users = _enrich_admin_users(cursor, cursor.fetchall())

            return jsonify({
                "code": 200, "message": "获取成功",
                "data": {"total": total_count, "list": users}
            })
    finally:
        conn.close()

# 2. 删除用户 (管理员可删普通用户，禁止删除管理员)
@admin_bp.route('/users/delete', methods=['POST'])
def delete_user():
    data = request.get_json()
    user_id = data.get('user_id')

    if not user_id:
        return jsonify({"code": 400, "message": "缺少用户ID"})

    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            _, is_global, regions, error = _admin_regions(cursor, data.get('admin_user_id'))
            if error:
                return error
            cursor.execute("SELECT user_id, role FROM users WHERE user_id = %s", (user_id,))
            target = cursor.fetchone()
            if not target:
                return jsonify({"code": 404, "message": "用户不存在"})

            if not _scope_allows_user(cursor, user_id, is_global, regions):
                return jsonify({"code": 403, "message": "无权管理其他区县用户"}), 403

            if target['role'] == 'admin':
                return jsonify({"code": 403, "message": "管理员账号不能删除"})

            if target['role'] == 'elder':
                cursor.execute("DELETE FROM elders WHERE user_id = %s", (user_id,))

            cursor.execute("DELETE FROM users WHERE user_id = %s", (user_id,))
            conn.commit()
            return jsonify({"code": 200, "message": "用户删除成功"})
    except Exception as e:
        conn.rollback()
        return jsonify({"code": 500, "message": f"删除失败: {str(e)}"})
    finally:
        conn.close()

# 3. 报警中心大屏 (SOS 与异常记录)
@admin_bp.route('/alerts', methods=['GET'])
def get_alerts():
    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            _, is_global, regions, error = _admin_regions(cursor, request.args.get('admin_user_id'))
            if error:
                return error
            # 关联老人的姓名查询
            # An alert is a notification row. For SOS, the linked incident is
            # the lifecycle source of truth: acknowledged is still active.
            sql = """
                SELECT a.alert_id, e.name AS elder_name, a.alert_type,
                       a.description, a.is_handled, a.created_at,
                       a.emergency_incident_id,
                       ei.status AS incident_status, ei.incident_type,
                       ei.acknowledged_at, ei.resolved_at, ei.resolution_summary,
                       ei.linked_order_id, c.conversation_id,
                       o.status AS linked_order_status, vu.real_name AS linked_volunteer_name
                FROM alerts a
                JOIN elders e ON a.elder_id = e.elder_id
                LEFT JOIN emergency_incidents ei ON ei.incident_id = a.emergency_incident_id
                LEFT JOIN conversations c ON c.incident_id = ei.incident_id AND c.conversation_type = 'sos'
                LEFT JOIN orders o ON o.order_id = ei.linked_order_id
                LEFT JOIN users vu ON vu.user_id = o.volunteer_id
            """
            params = []
            if not is_global:
                sql += " WHERE e.region_adcode IN %s"
                params.append(tuple(regions))
            sql += " ORDER BY CASE WHEN COALESCE(ei.status, CASE WHEN a.is_handled THEN 'resolved' ELSE 'reported' END) = 'resolved' THEN 1 ELSE 0 END, a.created_at DESC"
            cursor.execute(sql, params)
            alerts = cursor.fetchall()
            
            for a in alerts:
                for field in ('created_at', 'acknowledged_at', 'resolved_at'):
                    if isinstance(a.get(field), datetime.datetime):
                        a[field] = a[field].strftime('%Y-%m-%d %H:%M:%S')

            return jsonify({"code": 200, "message": "获取报警列表成功", "data": alerts})
    finally:
        conn.close()

# 3. 📊 数据可视化大屏聚合统计
@admin_bp.route('/dashboard/stats', methods=['GET'])
def get_dashboard_stats():
    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            _, is_global, regions, error = _admin_regions(cursor, request.args.get('admin_user_id'))
            if error:
                return error
            scoped = tuple(regions)
            # 1. 查总人数
            if is_global:
                cursor.execute("SELECT COUNT(*) AS total FROM users")
            else:
                cursor.execute("""SELECT COUNT(DISTINCT user_id) AS total FROM (
                    SELECT user_id FROM elders WHERE region_adcode IN %s
                    UNION SELECT volunteer_id FROM volunteer_location_state WHERE service_region_adcode IN %s
                    UNION SELECT rel.family_user_id FROM user_elder_relation rel JOIN elders e ON e.elder_id = rel.elder_id WHERE e.region_adcode IN %s
                ) scoped_users""", (scoped, scoped, scoped))
            total_users = cursor.fetchone()['total']

            # 2. 查全站累计产出的志愿服务总时长 (SUM)
            if is_global:
                cursor.execute("SELECT SUM(total_hours) AS total_hours FROM volunteers_profile")
            else:
                cursor.execute("""SELECT SUM(vp.total_hours) AS total_hours FROM volunteers_profile vp
                                  JOIN volunteer_location_state loc ON loc.volunteer_id = vp.user_id
                                  WHERE loc.service_region_adcode IN %s""", (scoped,))
            res = cursor.fetchone()
            total_service_hours = res['total_hours'] if res['total_hours'] else 0

            # 3. 查服务类型分布图 (GROUP BY 聚合)
            if is_global:
                cursor.execute("SELECT service_type AS type, COUNT(*) AS count FROM orders GROUP BY service_type")
            else:
                cursor.execute("SELECT service_type AS type, COUNT(*) AS count FROM orders WHERE region_adcode IN %s GROUP BY service_type", (scoped,))
            distribution = cursor.fetchall()

            return jsonify({
                "code": 200,
                "message": "获取大屏数据成功",
                "data": {
                    "total_users_count": total_users,
                    "total_service_hours": int(total_service_hours),
                    "service_type_distribution": distribution
                }
            })
    finally:
        conn.close()

# 4. 志愿者资质审核
@admin_bp.route('/volunteers/audit', methods=['POST'])
def audit_volunteer():
    data = request.get_json()
    user_id = data.get('user_id')
    action = data.get('action') 

    if action not in ['approve', 'reject']:
        return jsonify({"code": 400, "message": "审核动作必须为 approve 或 reject"})

    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            _, is_global, regions, error = _admin_regions(cursor, data.get('admin_user_id'))
            if error:
                return error
            if not _scope_allows_user(cursor, user_id, is_global, regions):
                return jsonify({"code": 403, "message": "无权审核其他区县志愿者"}), 403
            status = 'approved' if action == 'approve' else 'rejected'
            sql = "UPDATE volunteers_profile SET audit_status = %s WHERE user_id = %s AND audit_status IN ('pending', 'pending_review')"
            cursor.execute(sql, (status, user_id))
            
            if cursor.rowcount == 0:
                return jsonify({"code": 400, "message": "该用户不存在或已审核完毕"})
            
            conn.commit()
            msg = "审核通过，该志愿者已可接单！" if status == 'approved' else "已驳回该志愿者的申请。"
            return jsonify({"code": 200, "message": msg})
    except Exception as e:
        conn.rollback()
        return jsonify({"code": 500, "message": f"操作失败: {str(e)}"})
    finally:
        conn.close()

# 5. 处理报警记录
@admin_bp.route('/alerts/handle', methods=['POST'])
def handle_alert():
    data = request.get_json() or {}
    alert_id = data.get('alert_id', data.get('alertId'))
    action = str(data.get('action') or 'acknowledge').lower()
    resolution_summary = str(data.get('resolution_summary') or '').strip()[:1000]

    if action not in ('acknowledge', 'close'):
        return jsonify({"code": 400, "message": "不支持的告警操作"}), 400
    if action == 'close' and not resolution_summary:
        return jsonify({"code": 400, "message": "关闭紧急事件前请填写处置结果"}), 400

    if alert_id is None:
        return jsonify({"code": 400, "message": "缺少 alert_id"})

    try:
        alert_id = int(alert_id)
    except (TypeError, ValueError):
        return jsonify({"code": 400, "message": "alert_id 必须是数字"})

    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            _, is_global, regions, error = _admin_regions(cursor, data.get('admin_user_id'))
            if error:
                return error
            cursor.execute("""SELECT a.is_handled, e.region_adcode FROM alerts a
                              JOIN elders e ON e.elder_id = a.elder_id WHERE a.alert_id = %s""", (alert_id,))
            alert = cursor.fetchone()
            if not alert:
                return jsonify({"code": 404, "message": "报警记录不存在"})

            if not is_global and str(alert.get('region_adcode')) not in regions:
                return jsonify({"code": 403, "message": "无权处理其他区县告警"}), 403

            # New SOS events have a linked incident.  Do not set is_handled
            # when merely acknowledging it: elderly/family users must still
            # see the active event until an explicit close result is recorded.
            cursor.execute("SELECT emergency_incident_id FROM alerts WHERE alert_id = %s", (alert_id,))
            incident_link = cursor.fetchone()
            incident_id = incident_link.get('emergency_incident_id') if incident_link else None
            if incident_id:
                cursor.execute("""SELECT incident_id, status, linked_order_id
                                  FROM emergency_incidents WHERE incident_id = %s FOR UPDATE""", (incident_id,))
                incident = cursor.fetchone()
                if not incident:
                    return jsonify({"code": 404, "message": "关联紧急事件不存在"}), 404
                admin_user_id = int(data.get('admin_user_id'))
                if action == 'acknowledge':
                    if incident['status'] == 'resolved':
                        return jsonify({"code": 200, "message": "该紧急事件已关闭"})
                    cursor.execute("""UPDATE emergency_incidents
                                      SET status = CASE WHEN status = 'reported' THEN 'acknowledged' ELSE status END,
                                          acknowledged_at = COALESCE(acknowledged_at, CURRENT_TIMESTAMP),
                                          acknowledged_by = COALESCE(acknowledged_by, %s)
                                      WHERE incident_id = %s""", (admin_user_id, incident_id))
                    cursor.execute("""UPDATE emergency_notifications
                                      SET acknowledged_at = COALESCE(acknowledged_at, CURRENT_TIMESTAMP)
                                      WHERE incident_id = %s AND recipient_user_id = %s""", (incident_id, admin_user_id))
                    cursor.execute("""INSERT INTO conversation_messages (conversation_id, sender_user_id, message_type, content)
                                      SELECT conversation_id, %s, 'system', '社区管理员已接警，正在协调处置；事件尚未关闭。'
                                      FROM conversations WHERE incident_id = %s AND conversation_type = 'sos'""",
                                   (admin_user_id, incident_id))
                    conn.commit()
                    return jsonify({"code": 200, "message": "已确认接警；SOS 将继续向老人和家属显示处理中", "data": {"status": "acknowledged"}})

                if incident['status'] == 'resolved':
                    return jsonify({"code": 200, "message": "该紧急事件已关闭"})
                cursor.execute("""UPDATE emergency_incidents
                                  SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP,
                                      resolved_by = %s, resolution_summary = %s
                                  WHERE incident_id = %s""", (admin_user_id, resolution_summary, incident_id))
                cursor.execute("UPDATE alerts SET is_handled = TRUE WHERE emergency_incident_id = %s", (incident_id,))
                cursor.execute("""INSERT INTO conversation_messages (conversation_id, sender_user_id, message_type, content)
                                  SELECT conversation_id, %s, 'system', %s
                                  FROM conversations WHERE incident_id = %s AND conversation_type = 'sos'""",
                               (admin_user_id, f'紧急事件已关闭：{resolution_summary}', incident_id))
                cursor.execute("""UPDATE conversations SET status = 'archived', archived_at = CURRENT_TIMESTAMP
                                  WHERE incident_id = %s AND conversation_type = 'sos'""", (incident_id,))
                conn.commit()
                return jsonify({"code": 200, "message": "紧急事件已关闭并保留处置记录", "data": {"status": "resolved"}})

            if bool(alert.get('is_handled')):
                return jsonify({"code": 200, "message": "该报警已处理，无需重复操作"})

            sql = "UPDATE alerts SET is_handled = TRUE WHERE alert_id = %s"
            cursor.execute(sql, (alert_id,))

            if cursor.rowcount == 0:
                conn.rollback()
                return jsonify({"code": 500, "message": "报警状态更新失败"})

            conn.commit()
            return jsonify({"code": 200, "message": "已将该报警标记为已处理！"})
    except Exception as e:
        conn.rollback()
        return jsonify({"code": 500, "message": f"处理失败: {str(e)}"})
    finally:
        conn.close()

# 6. 🥇 超级巨型事务：每周时长结算与自动发奖！
@admin_bp.route('/weekly-settlement', methods=['POST'])
def weekly_settlement():
    data = request.get_json() or {}
    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            _, is_global, regions, error = _admin_regions(cursor, data.get('admin_user_id'))
            if error:
                return error
            scoped = tuple(regions)
            # ============ 💎 超级事务开始 ============
            
            # 第一步：找出本周表现最好的 TOP 3 志愿者并锁定他们 (排他锁)
            # 条件是本周必须接了单 (weekly_hours > 0)
            sql_find_top3 = """
                SELECT user_id, weekly_hours 
                FROM volunteers_profile 
                WHERE weekly_hours > 0
                ORDER BY weekly_hours DESC 
                LIMIT 3
                FOR UPDATE
            """
            if not is_global:
                sql_find_top3 = sql_find_top3.replace(
                    "FROM volunteers_profile", "FROM volunteers_profile vp JOIN volunteer_location_state loc ON loc.volunteer_id = vp.user_id"
                ).replace("WHERE weekly_hours > 0", "WHERE vp.weekly_hours > 0 AND loc.service_region_adcode IN %s")
                cursor.execute(sql_find_top3, (scoped,))
            else:
                cursor.execute(sql_find_top3)
            top_volunteers = cursor.fetchall()

            awarded_count = 0
            if top_volunteers:
                # 动态生成本周的荣誉称号字符串
                today_str = datetime.date.today().strftime('%Y年%m月%d日')
                award_title = f"【{today_str}结算】社区服务之星★"

                # 第二步：给 TOP 3 颁奖。
                # 💎 极高分技术点：使用 IFNULL 和 CONCAT 函数在原本的字符串后面追加内容
                sql_award = """
                    UPDATE volunteers_profile 
                    SET awards = COALESCE(awards, '') || %s || '；\n' 
                    WHERE user_id = %s
                """
                for vol in top_volunteers:
                    cursor.execute(sql_award, (award_title, vol['user_id']))
                    awarded_count += 1

            # 第三步：无差别重置！全站志愿者的本周时长全部清零 (总时长 total_hours 保持不变)
            sql_reset = "UPDATE volunteers_profile SET weekly_hours = 0"
            if not is_global:
                sql_reset += " WHERE user_id IN (SELECT volunteer_id FROM volunteer_location_state WHERE service_region_adcode IN %s)"
                cursor.execute(sql_reset, (scoped,))
            else:
                cursor.execute(sql_reset)

            # 提交事务
            conn.commit()
            # ============ 事务结束 ============

            msg = f"本周结算圆满完成！共有 {awarded_count} 名优秀志愿者荣获『社区服务之星』奖章，全站本周时长已重置！"
            return jsonify({"code": 200, "message": msg})
            
    except Exception as e:
        conn.rollback()
        return jsonify({"code": 500, "message": f"每周结算事务失败，数据已紧急回滚: {str(e)}"})
    finally:
        conn.close()


@admin_bp.route('/hour-reviews', methods=['GET'])
def list_hour_reviews():
    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            _, is_global, regions, error = _admin_regions(cursor, request.args.get('admin_user_id'))
            if error:
                return error
            sql = """
                SELECT
                    hr.review_id,
                    hr.order_id,
                    hr.volunteer_id,
                    COALESCE(v.real_name, '') AS volunteer_name,
                    o.created_by AS family_user_id,
                    COALESCE(f.real_name, '') AS family_name,
                    o.service_type,
                    o.service_time,
                    hr.expected_hours,
                    hr.declared_hours,
                    hr.max_auto_hours,
                    hr.review_status,
                    hr.approved_hours,
                    hr.review_note,
                    hr.created_at,
                    hr.reviewed_at
                FROM volunteer_hour_reviews hr
                JOIN orders o ON hr.order_id = o.order_id
                LEFT JOIN users v ON hr.volunteer_id = v.user_id
                LEFT JOIN users f ON o.created_by = f.user_id
                WHERE hr.review_status = 'pending_admin'
                ORDER BY hr.created_at DESC
            """
            if not is_global:
                sql = sql.replace("ORDER BY hr.created_at", "AND o.region_adcode IN %s ORDER BY hr.created_at")
                cursor.execute(sql, (tuple(regions),))
            else:
                cursor.execute(sql)
            rows = cursor.fetchall()

            for row in rows:
                row['service_time'] = format_datetime(row.get('service_time'))
                row['created_at'] = format_datetime(row.get('created_at'))
                row['reviewed_at'] = format_datetime(row.get('reviewed_at'))

            return jsonify({"code": 200, "message": "获取时长审核列表成功", "data": rows})
    finally:
        conn.close()


@admin_bp.route('/hour-reviews/review', methods=['POST'])
def review_hour_request():
    data = request.get_json()
    review_id = data.get('review_id')
    action = data.get('action')
    approved_hours = data.get('approved_hours')
    review_note = data.get('review_note', '')

    if action not in ['approve', 'reject']:
        return jsonify({"code": 400, "message": "审核动作必须为 approve 或 reject"})

    if not review_id:
        return jsonify({"code": 400, "message": "缺少审核记录ID"})

    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            _, is_global, regions, error = _admin_regions(cursor, data.get('admin_user_id'))
            if error:
                return error
            cursor.execute(
                """
                SELECT hr.review_id, hr.order_id, hr.volunteer_id, hr.expected_hours,
                       hr.declared_hours, hr.max_auto_hours, hr.review_status, hr.approved_hours,
                       o.status, o.region_adcode
                FROM volunteer_hour_reviews hr
                JOIN orders o ON hr.order_id = o.order_id
                WHERE hr.review_id = %s
                FOR UPDATE
                """,
                (review_id,),
            )
            review = cursor.fetchone()

            if not review:
                conn.rollback()
                return jsonify({"code": 404, "message": "审核记录不存在"})

            if not is_global and str(review.get('region_adcode')) not in regions:
                conn.rollback()
                return jsonify({"code": 403, "message": "无权审核其他区县服务时长"}), 403

            if review.get('review_status') != 'pending_admin':
                conn.rollback()
                return jsonify({"code": 400, "message": "该记录已处理"})

            if action == 'reject':
                cursor.execute(
                    """
                    UPDATE volunteer_hour_reviews
                    SET review_status = 'rejected',
                        approved_hours = 0,
                        review_note = %s,
                        reviewed_at = CURRENT_TIMESTAMP
                    WHERE review_id = %s
                    """,
                    (review_note, review_id),
                )
                conn.commit()
                return jsonify({"code": 200, "message": "已驳回该时长申请"})

            try:
                approved_value = float(approved_hours) if approved_hours is not None else float(review['declared_hours'])
            except (TypeError, ValueError):
                conn.rollback()
                return jsonify({"code": 400, "message": "通过时长格式错误"})

            if approved_value <= 0:
                conn.rollback()
                return jsonify({"code": 400, "message": "通过时长必须大于0"})

            volunteer_id = review['volunteer_id']
            cursor.execute(
                """
                UPDATE volunteers_profile
                SET total_hours = total_hours + %s,
                    weekly_hours = weekly_hours + %s
                WHERE user_id = %s
                """,
                (approved_value, approved_value, volunteer_id),
            )
            cursor.execute(
                """
                UPDATE volunteer_hour_reviews
                SET review_status = 'approved',
                    approved_hours = %s,
                    review_note = %s,
                    reviewed_at = CURRENT_TIMESTAMP
                WHERE review_id = %s
                """,
                (approved_value, review_note, review_id),
            )
            conn.commit()
            return jsonify({"code": 200, "message": f"已通过并计入 {approved_value:.1f} 小时志愿时长"})
    except Exception as e:
        conn.rollback()
        return jsonify({"code": 500, "message": f"审核失败: {str(e)}"})
    finally:
        conn.close()


@admin_bp.route('/award-requests', methods=['GET'])
def list_award_requests():
    status = request.args.get('status', 'pending')

    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            _, is_global, regions, error = _admin_regions(cursor, request.args.get('admin_user_id'))
            if error:
                return error
            sql = """
                SELECT
                    ar.request_id,
                    ar.volunteer_id,
                    COALESCE(u.real_name, '') AS volunteer_name,
                    ar.award_title,
                    ar.reason,
                    ar.status,
                    ar.review_note,
                    ar.created_at,
                    ar.reviewed_at
                FROM volunteer_award_requests ar
                LEFT JOIN users u ON ar.volunteer_id = u.user_id
                LEFT JOIN volunteer_location_state loc ON loc.volunteer_id = ar.volunteer_id
                WHERE (%s = 'all' OR ar.status = %s)
                ORDER BY ar.created_at DESC
            """
            if not is_global:
                sql = sql.replace("ORDER BY ar.created_at", "AND loc.service_region_adcode IN %s ORDER BY ar.created_at")
                cursor.execute(sql, (status, status, tuple(regions)))
            else:
                cursor.execute(sql, (status, status))
            rows = cursor.fetchall()

            for row in rows:
                row['created_at'] = format_datetime(row.get('created_at'))
                row['reviewed_at'] = format_datetime(row.get('reviewed_at'))

            return jsonify({"code": 200, "message": "获取荣誉申请成功", "data": rows})
    finally:
        conn.close()


@admin_bp.route('/award-requests/review', methods=['POST'])
def review_award_request():
    data = request.get_json()
    request_id = data.get('request_id')
    action = data.get('action')
    review_note = data.get('review_note', '')

    if action not in ['approve', 'reject']:
        return jsonify({"code": 400, "message": "审核动作必须为 approve 或 reject"})

    if not request_id:
        return jsonify({"code": 400, "message": "缺少申请ID"})

    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            _, is_global, regions, error = _admin_regions(cursor, data.get('admin_user_id'))
            if error:
                return error
            cursor.execute(
                """
                SELECT request_id, volunteer_id, award_title, status
                FROM volunteer_award_requests
                WHERE request_id = %s
                FOR UPDATE
                """,
                (request_id,),
            )
            req = cursor.fetchone()

            if not req:
                conn.rollback()
                return jsonify({"code": 404, "message": "荣誉申请不存在"})

            if not _scope_allows_user(cursor, req['volunteer_id'], is_global, regions):
                conn.rollback()
                return jsonify({"code": 403, "message": "无权审核其他区县荣誉申请"}), 403

            if req.get('status') != 'pending':
                conn.rollback()
                return jsonify({"code": 400, "message": "该申请已处理"})

            if action == 'reject':
                cursor.execute(
                    """
                    UPDATE volunteer_award_requests
                    SET status = 'rejected',
                        review_note = %s,
                        reviewed_at = CURRENT_TIMESTAMP
                    WHERE request_id = %s
                    """,
                    (review_note, request_id),
                )
                conn.commit()
                return jsonify({"code": 200, "message": "已驳回该荣誉申请"})

            cursor.execute(
                "SELECT awards FROM volunteers_profile WHERE user_id = %s FOR UPDATE",
                (req['volunteer_id'],),
            )
            profile = cursor.fetchone()
            if not profile:
                conn.rollback()
                return jsonify({"code": 404, "message": "志愿者资料不存在"})

            new_awards = merge_awards_text(profile.get('awards'), req['award_title'])
            cursor.execute(
                """
                UPDATE volunteers_profile
                SET awards = %s
                WHERE user_id = %s
                """,
                (new_awards, req['volunteer_id']),
            )
            cursor.execute(
                """
                UPDATE volunteer_award_requests
                SET status = 'approved',
                    review_note = %s,
                    reviewed_at = CURRENT_TIMESTAMP
                WHERE request_id = %s
                """,
                (review_note, request_id),
            )
            conn.commit()
            return jsonify({"code": 200, "message": f"已通过荣誉申请：{req['award_title']}"})
    except Exception as e:
        conn.rollback()
        return jsonify({"code": 500, "message": f"审核失败: {str(e)}"})
    finally:
        conn.close()
