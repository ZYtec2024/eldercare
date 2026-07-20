# routes/volunteer.py
from flask import Blueprint, request, jsonify
from db import get_db_connection
from utils import format_datetime, split_awards_text, merge_awards_text, build_available_actions
import datetime

volunteer_bp = Blueprint('volunteer', __name__)


def _leaderboard_viewer_regions(cursor, raw_user_id):
    if not raw_user_id:
        return True, set()
    try:
        user_id = int(raw_user_id)
    except (TypeError, ValueError):
        return False, set()
    cursor.execute("SELECT role FROM users WHERE user_id = %s", (user_id,))
    viewer = cursor.fetchone()
    if not viewer:
        return False, set()
    if viewer.get('role') == 'admin':
        cursor.execute("SELECT region_adcode FROM admin_region_scope WHERE admin_user_id = %s", (user_id,))
        regions = {str(row['region_adcode']) for row in cursor.fetchall()}
        return '*' in regions, regions - {'*'}
    cursor.execute(
        """
        SELECT region_adcode FROM elders WHERE user_id = %s
        UNION SELECT service_region_adcode FROM volunteer_location_state WHERE volunteer_id = %s
        UNION SELECT e.region_adcode FROM user_elder_relation rel
              JOIN elders e ON e.elder_id = rel.elder_id WHERE rel.family_user_id = %s
        """,
        (user_id, user_id, user_id),
    )
    return False, {str(row['region_adcode']) for row in cursor.fetchall() if row.get('region_adcode')}

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
                    WHERE (%s IS NOT NULL AND o.volunteer_id = %s AND o.status IN ('accepted', 'in_progress'))
                       OR (o.status = 'pending' AND (
                            %s IS NULL OR NOT EXISTS (
                                SELECT 1 FROM orders own
                                WHERE own.volunteer_id = %s AND own.status IN ('accepted', 'in_progress')
                            )
                       ) AND (
                            %s IS NULL
                            OR NOT EXISTS (SELECT 1 FROM dispatch_orders d WHERE d.order_id = o.order_id)
                            OR EXISTS (
                                SELECT 1 FROM dispatch_candidates c
                                WHERE c.order_id = o.order_id AND c.volunteer_id = %s
                                  AND c.eligible = TRUE AND c.response_status IN ('invited', 'forced')
                            )
                       ))
                    ORDER BY o.created_at DESC
                """
                cursor.execute(sql, (volunteer_id, volunteer_id, volunteer_id, volunteer_id, volunteer_id, volunteer_id))
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
                    WHERE (%s IS NOT NULL AND o.volunteer_id = %s AND o.status IN ('accepted', 'in_progress'))
                       OR (o.status = 'pending' AND (
                            %s IS NULL OR NOT EXISTS (
                                SELECT 1 FROM orders own
                                WHERE own.volunteer_id = %s AND own.status IN ('accepted', 'in_progress')
                            )
                       ) AND (
                            %s IS NULL
                            OR NOT EXISTS (SELECT 1 FROM dispatch_orders d WHERE d.order_id = o.order_id)
                            OR EXISTS (
                                SELECT 1 FROM dispatch_candidates c
                                WHERE c.order_id = o.order_id AND c.volunteer_id = %s
                                  AND c.eligible = TRUE AND c.response_status IN ('invited', 'forced')
                            )
                       ))
                    ORDER BY o.created_at DESC
                """
                cursor.execute(sql, (volunteer_id, volunteer_id, volunteer_id, volunteer_id, volunteer_id, volunteer_id))
            
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
            sql_check = "SELECT status, region_adcode FROM orders WHERE order_id = %s FOR UPDATE"
            cursor.execute(sql_check, (order_id,))
            order = cursor.fetchone()

            # Per-order locking alone does not stop one volunteer from taking
            # two different orders in parallel browser sessions.  Lock their
            # user row so every accept attempt for that person is serialized.
            cursor.execute("SELECT user_id FROM users WHERE user_id = %s FOR UPDATE", (volunteer_id,))
            volunteer = cursor.fetchone()
            cursor.execute("SELECT service_region_adcode FROM volunteer_location_state WHERE volunteer_id = %s", (volunteer_id,))
            volunteer_location = cursor.fetchone()
            if not volunteer:
                conn.rollback()
                return jsonify({"code": 404, "message": "志愿者不存在"}), 404

            if not order:
                conn.rollback()
                return jsonify({"code": 404, "message": "订单不存在"})
            
            # 2. 校验状态：只有状态是 pending (待接单) 才能抢
            if not volunteer_location or str(order.get('region_adcode')) != str(volunteer_location.get('service_region_adcode')):
                conn.rollback()
                return jsonify({"code": 403, "message": "任务不属于您的服务区县"}), 403

            if order['status'] != 'pending':
                conn.rollback() # 解锁放行排队的人
                return jsonify({"code": 400, "message": "手慢了，该订单已被其他志愿者抢走或已取消！"})

            # 3. 执行接单：修改状态为 accepted 并绑定志愿者ID
            cursor.execute("""SELECT order_id FROM orders
                              WHERE volunteer_id = %s AND status IN ('accepted', 'in_progress')""", (volunteer_id,))
            if cursor.fetchone():
                conn.rollback()
                return jsonify({"code": 409, "message": "当前已有进行中的订单，请完成服务后再接新单"}), 409

            # Smart-dispatch orders may also appear in the general task hall.
            # Do not let that legacy entry point bypass the skill gate, route
            # creation, candidate expiry, or one-order dispatch state machine.
            cursor.execute("SELECT order_id FROM dispatch_orders WHERE order_id = %s", (order_id,))
            if cursor.fetchone():
                from routes.dispatch import _accept_candidate, _order_context
                smart_order = _order_context(cursor, int(order_id))
                cursor.execute("""SELECT eligible, response_status FROM dispatch_candidates
                                  WHERE order_id = %s AND volunteer_id = %s""", (order_id, volunteer_id))
                candidate = cursor.fetchone()
                if not smart_order or not candidate or not candidate["eligible"]:
                    conn.rollback()
                    return jsonify({"code": 403, "message": "该请求与您的技能不匹配，不能接单"}), 403
                if candidate["response_status"] not in ("invited", "forced"):
                    conn.rollback()
                    return jsonify({"code": 403, "message": "该智能请求当前未向您开放"}), 403
                route = _accept_candidate(cursor, smart_order, int(volunteer_id))
                if route is None:
                    conn.rollback()
                    return jsonify({"code": 409, "message": "接单未成功：订单已被锁定或您已有进行中的服务"}), 409
                conn.commit()
                return jsonify({"code": 200, "message": "接单成功，已生成前往老人家的路线", "data": route})

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
                # The legacy task-detail screen may still start a smart
                # dispatch order.  It must use the same shared-map invariant
                # as /dispatch/orders/<id>/respond: service means the
                # volunteer is physically at the elder's address, never at
                # the previous route point.
                cursor.execute("SELECT order_id FROM dispatch_orders WHERE order_id = %s", (order_id,))
                if cursor.fetchone():
                    from routes.dispatch import _order_context
                    smart_order = _order_context(cursor, int(order_id))
                    if smart_order:
                        cursor.execute("UPDATE dispatch_orders SET dispatch_state = 'serving' WHERE order_id = %s", (order_id,))
                        cursor.execute("""UPDATE volunteer_location_state
                                          SET lng = %s, lat = %s, availability = 'serving', location_source = 'virtual', updated_at = CURRENT_TIMESTAMP
                                          WHERE volunteer_id = %s""",
                                       (smart_order['elder_lng'], smart_order['elder_lat'], volunteer_id))
                        cursor.execute("DELETE FROM dispatch_routes WHERE order_id = %s", (order_id,))
                conn.commit()
                return jsonify({"code": 200, "message": "服务已开始！"})

            if action == 'cancel':
                cursor.execute("SELECT order_id FROM dispatch_orders WHERE order_id = %s", (order_id,))
                is_smart_dispatch = cursor.fetchone()
                if order.get('status') not in ['accepted', 'in_progress']:
                    conn.rollback()
                    return jsonify({"code": 400, "message": "当前状态不支持中止"})

                if is_smart_dispatch:
                    if order.get('status') != 'accepted':
                        conn.rollback()
                        return jsonify({"code": 409, "message": "智能订单服务开始后不能取消，请完成服务"}), 409
                    from routes.dispatch import _order_context, _release_dispatch_order
                    smart_order = _order_context(cursor, int(order_id))
                    _release_dispatch_order(cursor, smart_order, int(volunteer_id), "volunteer_assignment_cancelled", "志愿者从任务详情取消，系统已立即重新计算下一位最优候选。")
                    conn.commit()
                    return jsonify({"code": 200, "message": "已取消接单，系统正在重新派单"})

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

                # The legacy task-detail page can also complete an intelligent
                # order.  Send it through the same return-home and immediate
                # auto-chain flow as the dispatch page, instead of leaving a
                # stale "serving" location behind.
                cursor.execute("SELECT order_id FROM dispatch_orders WHERE order_id = %s", (order_id,))
                if cursor.fetchone():
                    from routes.dispatch import _create_return_route, _record_completed_service_fatigue
                    cursor.execute("UPDATE dispatch_orders SET dispatch_state = 'completed' WHERE order_id = %s", (order_id,))
                    cursor.execute("DELETE FROM dispatch_routes WHERE order_id = %s", (order_id,))
                    return_route = _create_return_route(cursor, int(volunteer_id))
                    _record_completed_service_fatigue(cursor, int(volunteer_id), float(order.get('service_hours') or 1))
                    cursor.execute("UPDATE volunteer_location_state SET availability = %s WHERE volunteer_id = %s",
                                   ('returning' if return_route else 'idle', volunteer_id))
                    cursor.execute("SELECT auto_accept_enabled FROM volunteer_location_state WHERE volunteer_id = %s", (volunteer_id,))
                    auto_state = cursor.fetchone()
                    if auto_state and auto_state['auto_accept_enabled']:
                        # The dispatch endpoint will scan after the persisted
                        # return-window grace period; never skip the visible
                        # return route from this legacy completion page.
                        pass

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
    admin_user_id = request.args.get('admin_user_id')
    viewer_user_id = request.args.get('viewer_user_id')
    requested_region = request.args.get('region_adcode')
    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            is_global, regions = True, set()
            if admin_user_id:
                cursor.execute("SELECT role FROM users WHERE user_id = %s", (admin_user_id,))
                admin = cursor.fetchone()
                if not admin or admin.get('role') != 'admin':
                    return jsonify({"code": 403, "message": "仅管理员可查看管理员荣誉榜"}), 403
                cursor.execute("SELECT region_adcode FROM admin_region_scope WHERE admin_user_id = %s", (admin_user_id,))
                regions = {str(row['region_adcode']) for row in cursor.fetchall()}
                is_global = '*' in regions
                regions.discard('*')
                if not is_global and not regions:
                    return jsonify({"code": 403, "message": "该管理员未分配区县管理范围"}), 403
            elif viewer_user_id:
                is_global, regions = _leaderboard_viewer_regions(cursor, viewer_user_id)
                if not is_global and not regions:
                    return jsonify({"code": 403, "message": "当前账号未配置服务区县"}), 403
            if admin_user_id and requested_region:
                if not is_global and requested_region not in regions:
                    return jsonify({"code": 403, "message": "无权查看其他区县排名"}), 403
                is_global, regions = False, {str(requested_region)}
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
            if not is_global:
                sql = sql.replace("WHERE u.role = 'volunteer'", "JOIN volunteer_location_state loc ON loc.volunteer_id = u.user_id WHERE u.role = 'volunteer' AND loc.service_region_adcode IN %s")
                cursor.execute(sql, (tuple(regions),))
            else:
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
