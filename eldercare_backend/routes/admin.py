# routes/admin.py
from flask import Blueprint, request, jsonify
from db import get_db_connection
from utils import format_datetime, split_awards_text, merge_awards_text, get_pagination_params
import datetime

admin_bp = Blueprint('admin', __name__)

# 1. 获取用户列表 (带分页与角色筛选)
@admin_bp.route('/users/list', methods=['GET'])
def get_user_list():
    role = request.args.get('role') 
    page = int(request.args.get('page', 1))
    limit = int(request.args.get('limit', 10))
    offset = (page - 1) * limit

    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            # 动态构建 SQL 与分页 (LIMIT OFFSET)
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
            count_sql = "SELECT COUNT(*) AS total FROM users"
            params = []

            if role:
                base_sql += " WHERE u.role = %s"
                count_sql += " WHERE role = %s"
                params.append(role)

            cursor.execute(count_sql, tuple(params))
            total_count = cursor.fetchone()['total']

            base_sql += " ORDER BY u.created_at DESC LIMIT %s OFFSET %s"
            params.extend([limit, offset])

            cursor.execute(base_sql, tuple(params))
            users = cursor.fetchall()

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
            cursor.execute("SELECT user_id, role FROM users WHERE user_id = %s", (user_id,))
            target = cursor.fetchone()
            if not target:
                return jsonify({"code": 404, "message": "用户不存在"})

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
            # 关联老人的姓名查询
            sql = """
                SELECT a.alert_id, e.name AS elder_name, a.alert_type, 
                       a.description, a.is_handled, a.created_at
                FROM alerts a
                JOIN elders e ON a.elder_id = e.elder_id
                ORDER BY a.is_handled ASC, a.created_at DESC
            """
            cursor.execute(sql)
            alerts = cursor.fetchall()
            
            for a in alerts:
                if isinstance(a['created_at'], datetime.datetime):
                    a['created_at'] = a['created_at'].strftime('%Y-%m-%d %H:%M:%S')

            return jsonify({"code": 200, "message": "获取报警列表成功", "data": alerts})
    finally:
        conn.close()

# 3. 📊 数据可视化大屏聚合统计
@admin_bp.route('/dashboard/stats', methods=['GET'])
def get_dashboard_stats():
    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            # 1. 查总人数
            cursor.execute("SELECT COUNT(*) AS total FROM users")
            total_users = cursor.fetchone()['total']

            # 2. 查全站累计产出的志愿服务总时长 (SUM)
            cursor.execute("SELECT SUM(total_hours) AS total_hours FROM volunteers_profile")
            res = cursor.fetchone()
            total_service_hours = res['total_hours'] if res['total_hours'] else 0

            # 3. 查服务类型分布图 (GROUP BY 聚合)
            cursor.execute("SELECT service_type AS type, COUNT(*) AS count FROM orders GROUP BY service_type")
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

    if alert_id is None:
        return jsonify({"code": 400, "message": "缺少 alert_id"})

    try:
        alert_id = int(alert_id)
    except (TypeError, ValueError):
        return jsonify({"code": 400, "message": "alert_id 必须是数字"})

    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute("SELECT is_handled FROM alerts WHERE alert_id = %s", (alert_id,))
            alert = cursor.fetchone()
            if not alert:
                return jsonify({"code": 404, "message": "报警记录不存在"})

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
    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
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
            cursor.execute(
                """
                SELECT hr.review_id, hr.order_id, hr.volunteer_id, hr.expected_hours,
                       hr.declared_hours, hr.max_auto_hours, hr.review_status, hr.approved_hours,
                       o.status
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
                WHERE (%s = 'all' OR ar.status = %s)
                ORDER BY ar.created_at DESC
            """
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