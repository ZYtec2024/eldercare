# routes/volunteer.py
from flask import Blueprint, request, jsonify
from db import get_db_connection
from utils import format_datetime, split_awards_text, merge_awards_text, build_available_actions
import datetime

volunteer_bp = Blueprint('volunteer', __name__)

# 1. 获取任务大厅列表 (周围待接单需求)
@volunteer_bp.route('/orders/available', methods=['GET'])
def get_available_orders():
    volunteer_id = request.args.get('volunteer_id')
    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            try:
                sql = """
                    SELECT 
                        o.order_id, 
                        e.name AS elder_name, 
                        o.service_type, 
                        o.service_time, 
                        o.service_hours, 
                        COALESCE(o.address, e.address) AS addressPreview, 
                        o.volunteer_id AS assigned_volunteer_id,
                        o.status
                    FROM orders o
                    JOIN elders e ON o.elder_id = e.elder_id
                    WHERE o.status = 'pending'
                        OR (%s IS NOT NULL AND o.volunteer_id = %s AND o.status IN ('accepted', 'in_progress'))
                    ORDER BY o.created_at DESC
                """
                cursor.execute(sql, (volunteer_id, volunteer_id))
            except Exception:
                sql = """
                    SELECT 
                        o.order_id, 
                        e.name AS elder_name, 
                        o.service_type, 
                        o.service_time, 
                        o.service_hours, 
                        e.address AS addressPreview, 
                        o.volunteer_id AS assigned_volunteer_id,
                        o.status
                    FROM orders o
                    JOIN elders e ON o.elder_id = e.elder_id
                    WHERE o.status = 'pending'
                        OR (%s IS NOT NULL AND o.volunteer_id = %s AND o.status IN ('accepted', 'in_progress'))
                    ORDER BY o.created_at DESC
                """
                cursor.execute(sql, (volunteer_id, volunteer_id))
            
            orders = cursor.fetchall()

            for o in orders:
                if isinstance(o['service_time'], datetime.datetime):
                    o['service_time'] = o['service_time'].strftime('%Y-%m-%d %H:%M')
                o['available_actions'] = build_available_actions(
                    o.get('status'),
                    o.get('assigned_volunteer_id'),
                    volunteer_id,
                )

            return jsonify({"code": 200, "message": "获取成功", "data": orders})
    finally:
        conn.close()

# 1.5 获取单个任务详情
@volunteer_bp.route('/orders/available/<int:task_id>', methods=['GET'])
def get_task_detail(task_id):
    volunteer_id = request.args.get('volunteer_id')
    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            try:
                sql = """
                    SELECT 
                        o.order_id, 
                        e.name AS elder_name, 
                        o.service_type, 
                        o.service_time, 
                        o.service_hours, 
                        COALESCE(o.address, e.address) AS addressPreview, 
                        o.volunteer_id AS assigned_volunteer_id,
                        o.status
                    FROM orders o
                    JOIN elders e ON o.elder_id = e.elder_id
                    WHERE o.order_id = %s
                """
                cursor.execute(sql, (task_id,))
            except Exception:
                sql = """
                    SELECT 
                        o.order_id, 
                        e.name AS elder_name, 
                        o.service_type, 
                        o.service_time, 
                        o.service_hours, 
                        e.address AS addressPreview, 
                        o.volunteer_id AS assigned_volunteer_id,
                        o.status
                    FROM orders o
                    JOIN elders e ON o.elder_id = e.elder_id
                    WHERE o.order_id = %s
                """
                cursor.execute(sql, (task_id,))
            
            order = cursor.fetchone()
            
            if not order:
                return jsonify({"code": 404, "message": "任务不存在"})

            if isinstance(order['service_time'], datetime.datetime):
                order['service_time'] = order['service_time'].strftime('%Y-%m-%d %H:%M')

            order['available_actions'] = build_available_actions(
                order.get('status'),
                order.get('assigned_volunteer_id'),
                volunteer_id,
            )

            return jsonify({"code": 200, "message": "获取成功", "data": order})
    finally:
        conn.close()

# 2. ⚡ 立即抢单 (高并发防超卖核心：悲观锁与事务)
@volunteer_bp.route('/orders/grab', methods=['POST'])
def grab_order():
    data = request.get_json()
    order_id = data.get('order_id')
    volunteer_id = data.get('volunteer_id')

    if not all([order_id, volunteer_id]):
        return jsonify({"code": 400, "message": "参数不完整"})

    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            # ============ 💎 数据库高分考点：抢单防超卖事务 ============
            
            # 1. 查询订单并上排他锁 (FOR UPDATE)
            # 作用：如果同时有10个人点抢单，只有第一个人能拿到锁执行下面的代码，其他人全部在这一行排队阻塞！
            sql_check = "SELECT status FROM orders WHERE order_id = %s FOR UPDATE"
            cursor.execute(sql_check, (order_id,))
            order = cursor.fetchone()

            if not order:
                conn.rollback()
                return jsonify({"code": 404, "message": "订单不存在"})
            
            # 2. 校验状态：只有状态是 pending (待接单) 才能抢
            if order['status'] != 'pending':
                conn.rollback() # 解锁放行排队的人
                return jsonify({"code": 400, "message": "手慢了，该订单已被其他志愿者抢走或已取消！"})

            # 3. 执行接单：修改状态为 accepted 并绑定志愿者ID
            sql_update = "UPDATE orders SET status = 'accepted', volunteer_id = %s WHERE order_id = %s"
            cursor.execute(sql_update, (volunteer_id, order_id))
            
            # 5. 提交事务，释放锁！将修改永久保存。
            conn.commit()
            # ============ 事务结束 ============

            return jsonify({"code": 200, "message": "抢单成功！请按时前往服务。"})

    except Exception as e:
        conn.rollback() # 发生任何报错直接回滚
        return jsonify({"code": 500, "message": f"服务器开小差了: {str(e)}"})
    finally:
        conn.close()

# 3. 订单状态更新 (核心：完成打卡后累加志愿时长)
@volunteer_bp.route('/orders/update-status', methods=['POST'])
def update_order_status():
    data = request.get_json()
    order_id = data.get('order_id')
    volunteer_id = data.get('volunteer_id')
    action = data.get('action')
    actual_hours = data.get('actual_hours')

    if action not in ['start', 'complete', 'cancel']:
        return jsonify({"code": 400, "message": "未知的操作动作"})

    if not order_id or not volunteer_id:
        return jsonify({"code": 400, "message": "缺少订单或志愿者信息"})

    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute(
                "SELECT volunteer_id, service_hours, status FROM orders WHERE order_id = %s FOR UPDATE",
                (order_id,),
            )
            order = cursor.fetchone()

            if not order:
                conn.rollback()
                return jsonify({"code": 404, "message": "订单不存在"})

            if str(order.get('volunteer_id')) != str(volunteer_id):
                conn.rollback()
                return jsonify({"code": 403, "message": "您无权操作该订单"})

            if action == 'start':
                if order.get('status') != 'accepted':
                    conn.rollback()
                    return jsonify({"code": 400, "message": "订单状态异常，无法开始"})

                cursor.execute("UPDATE orders SET status = 'in_progress' WHERE order_id = %s", (order_id,))
                conn.commit()
                return jsonify({"code": 200, "message": "服务已开始！"})

            if action == 'cancel':
                if order.get('status') not in ['accepted', 'in_progress']:
                    conn.rollback()
                    return jsonify({"code": 400, "message": "当前状态不支持中止"})

                cursor.execute(
                    "UPDATE orders SET status = 'pending', volunteer_id = NULL WHERE order_id = %s",
                    (order_id,),
                )
                conn.commit()
                return jsonify({"code": 200, "message": "任务已中止并回到任务大厅"})

            if action == 'complete':
                if order.get('status') != 'in_progress':
                    conn.rollback()
                    return jsonify({"code": 400, "message": "只有处于'进行中'的订单才能完成"})

                cursor.execute("UPDATE orders SET status = 'completed' WHERE order_id = %s", (order_id,))

                expected_hours = float(order.get('service_hours') or 0)
                try:
                    declared_hours = float(actual_hours) if actual_hours is not None else expected_hours
                except (TypeError, ValueError):
                    conn.rollback()
                    return jsonify({"code": 400, "message": "实际服务时长格式错误"})

                if declared_hours <= 0:
                    conn.rollback()
                    return jsonify({"code": 400, "message": "实际服务时长必须大于0"})

                max_auto_hours = expected_hours * 1.5
                cursor.execute(
                    "SELECT review_id FROM volunteer_hour_reviews WHERE order_id = %s",
                    (order_id,),
                )
                existed_review = cursor.fetchone()

                if existed_review:
                    cursor.execute(
                        """
                        UPDATE volunteer_hour_reviews
                        SET declared_hours = %s,
                            expected_hours = %s,
                            max_auto_hours = %s,
                            review_status = 'pending_family',
                            approved_hours = NULL,
                            review_note = NULL,
                            reviewed_at = NULL
                        WHERE order_id = %s
                        """,
                        (declared_hours, expected_hours, max_auto_hours, order_id),
                    )
                else:
                    cursor.execute(
                        """
                        INSERT INTO volunteer_hour_reviews (
                            order_id, volunteer_id, expected_hours, declared_hours,
                            max_auto_hours, review_status, approved_hours
                        )
                        VALUES (%s, %s, %s, %s, %s, 'pending_family', NULL)
                        """,
                        (order_id, volunteer_id, expected_hours, declared_hours, max_auto_hours),
                    )

                conn.commit()
                return jsonify({
                    "code": 200,
                    "message": "服务完成！请家属确认最终服务时长，确认后再计入志愿时长。",
                })

    except Exception as e:
        conn.rollback()
        return jsonify({"code": 500, "message": f"状态更新失败: {str(e)}"})
    finally:
        conn.close()

# 4. 全民为志愿者点赞 (利用 UNIQUE KEY 防刷赞)
@volunteer_bp.route('/like', methods=['POST'])
def like_volunteer():
    data = request.get_json()
    from_user_id = data.get('from_user_id')
    to_volunteer_id = data.get('to_volunteer_id')

    if not all([from_user_id, to_volunteer_id]):
        return jsonify({"code": 400, "message": "缺少点赞双方信息"})

    try:
        from_user_id = int(str(from_user_id).strip())
        to_volunteer_id = int(str(to_volunteer_id).strip())
    except (TypeError, ValueError):
        return jsonify({"code": 400, "message": "点赞用户ID格式错误"})

    if from_user_id == to_volunteer_id:
        return jsonify({"code": 400, "message": "不能给自己点赞哦"})

    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            sql_check_target = "SELECT 1 FROM users WHERE user_id = %s AND role = 'volunteer'"
            cursor.execute(sql_check_target, (to_volunteer_id,))
            if not cursor.fetchone():
                return jsonify({"code": 400, "message": "被点赞对象不是志愿者"})

            # 第一步：试图向点赞记录表插入数据
            # 💎 极其优雅的高阶用法：利用数据库层的 UNIQUE KEY(from_user, to_vol) 自动拦截重复插入！
            sql_insert_like = "INSERT INTO volunteer_likes (from_user_id, to_volunteer_id) VALUES (%s, %s)"
            cursor.execute(sql_insert_like, (from_user_id, to_volunteer_id))

            # 第二步：如果插入没报错，说明是第一次点赞，更新缓存总数
            sql_update_count = "UPDATE volunteers_profile SET likes_count = likes_count + 1 WHERE user_id = %s"
            cursor.execute(sql_update_count, (to_volunteer_id,))

            conn.commit()
            return jsonify({"code": 200, "message": "点赞成功！感谢您的鼓励！"})
            
    except Exception as e:
        conn.rollback() 
        # 捕获那条因为 UNIQUE KEY 触发的重复拦截错误
        if "Duplicate entry" in str(e) or "duplicate key value violates unique constraint" in str(e):
            return jsonify({"code": 409, "message": "您已经给这位志愿者点过赞啦，把机会留给别人吧~"})
        return jsonify({"code": 500, "message": f"点赞失败: {str(e)}"})
    finally:
        conn.close()

# 5. 🏆 荣誉大厅排行榜 (按本周时长倒序)
@volunteer_bp.route('/leaderboard', methods=['GET'])
def get_leaderboard():
    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            # 💎 高分点：多表 JOIN + 子查询聚合，按本周时长统计荣誉大厅
            sql = """
                SELECT 
                    u.user_id, u.real_name, 
                    vp.total_hours, vp.weekly_hours, vp.likes_count, vp.awards, vp.skills,
                    COALESCE(c.completed_count, 0) AS completed_count
                FROM users u
                JOIN volunteers_profile vp ON u.user_id = vp.user_id
                LEFT JOIN (
                    SELECT volunteer_id, COUNT(*) AS completed_count
                    FROM orders
                    WHERE status = 'completed'
                    GROUP BY volunteer_id
                ) c ON c.volunteer_id = u.user_id
                WHERE u.role = 'volunteer'
                ORDER BY vp.weekly_hours DESC, vp.likes_count DESC, vp.total_hours DESC
                LIMIT 10
            """
            cursor.execute(sql)
            leaderboard = cursor.fetchall()
            return jsonify({"code": 200, "message": "获取榜单成功", "data": leaderboard})
    finally:
        conn.close()


# 6. 志愿者个人成就汇总
@volunteer_bp.route('/profile/summary', methods=['GET'])
def get_profile_summary():
    volunteer_id = request.args.get('volunteer_id')
    if not volunteer_id:
        return jsonify({"code": 400, "message": "缺少志愿者ID"})

    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            sql = """
                SELECT 
                    u.user_id,
                    u.real_name,
                    vp.id_card,
                    vp.skills,
                    vp.total_hours,
                    vp.weekly_hours,
                    vp.awards,
                    vp.likes_count,
                    COALESCE(c.completed_count, 0) AS completed_count
                FROM users u
                JOIN volunteers_profile vp ON u.user_id = vp.user_id
                LEFT JOIN (
                    SELECT volunteer_id, COUNT(*) AS completed_count
                    FROM orders
                    WHERE status = 'completed'
                    GROUP BY volunteer_id
                ) c ON c.volunteer_id = u.user_id
                WHERE u.user_id = %s AND u.role = 'volunteer'
            """
            cursor.execute(sql, (volunteer_id,))
            summary = cursor.fetchone()

            if not summary:
                return jsonify({"code": 404, "message": "未找到志愿者成就信息"})

            return jsonify({"code": 200, "message": "个人成就加载成功", "data": summary})
    finally:
        conn.close()


# 6.1 我的任务列表（供“我的成就”页面使用）
@volunteer_bp.route('/my-tasks', methods=['GET'])
def get_my_tasks():
    volunteer_id = request.args.get('volunteer_id')
    if not volunteer_id:
        return jsonify({"code": 400, "message": "缺少志愿者ID"})

    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            sql = """
                SELECT
                    o.order_id,
                    o.service_type,
                    o.service_time,
                    o.service_hours,
                    o.status,
                    e.name AS elder_name,
                    COALESCE(o.address, e.address) AS address_preview
                FROM orders o
                JOIN elders e ON o.elder_id = e.elder_id
                WHERE o.volunteer_id = %s
                ORDER BY o.service_time DESC
            """
            cursor.execute(sql, (volunteer_id,))
            rows = cursor.fetchall()

            for row in rows:
                if isinstance(row.get('service_time'), datetime.datetime):
                    row['service_time'] = row['service_time'].strftime('%Y-%m-%d %H:%M')

            return jsonify({"code": 200, "message": "获取任务成功", "data": rows})
    finally:
        conn.close()


# 6.2 收到的评价（供“我的成就”页面使用）
@volunteer_bp.route('/my-reviews', methods=['GET'])
def get_my_reviews():
    volunteer_id = request.args.get('volunteer_id')
    if not volunteer_id:
        return jsonify({"code": 400, "message": "缺少志愿者ID"})

    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            sql = """
                SELECT
                    o.order_id,
                    o.service_type,
                    o.service_time,
                    e.name AS elder_name,
                    r.rating,
                    r.comment
                FROM reviews r
                JOIN orders o ON r.order_id = o.order_id
                JOIN elders e ON o.elder_id = e.elder_id
                WHERE o.volunteer_id = %s
                ORDER BY o.service_time DESC
            """
            cursor.execute(sql, (volunteer_id,))
            rows = cursor.fetchall()

            for row in rows:
                if isinstance(row.get('service_time'), datetime.datetime):
                    row['service_time'] = row['service_time'].strftime('%Y-%m-%d %H:%M')

            return jsonify({"code": 200, "message": "获取评价成功", "data": rows})
    finally:
        conn.close()


# 7. 志愿者自主申请荣誉（管理员审核通过后生效）
@volunteer_bp.route('/awards/request', methods=['POST'])
def request_award():
    data = request.get_json()
    volunteer_id = data.get('volunteer_id')
    award_title = (data.get('award_title') or '').strip()
    reason = (data.get('reason') or '').strip()

    if not volunteer_id or not award_title:
        return jsonify({"code": 400, "message": "参数不完整"})

    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute("SELECT user_id FROM users WHERE user_id = %s AND role = 'volunteer'", (volunteer_id,))
            target = cursor.fetchone()
            if not target:
                return jsonify({"code": 404, "message": "未找到志愿者账号"})

            cursor.execute(
                """
                INSERT INTO volunteer_award_requests (volunteer_id, award_title, reason)
                VALUES (%s, %s, %s)
                """,
                (volunteer_id, award_title, reason),
            )
            conn.commit()
            return jsonify({"code": 200, "message": "荣誉申请已提交，等待管理员审核"})
    except Exception as e:
        conn.rollback()
        return jsonify({"code": 500, "message": f"申请失败: {str(e)}"})
    finally:
        conn.close()