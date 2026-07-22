# routes/public.py - 公开接口（无需登录）
from flask import Blueprint, request, jsonify
from db import get_db_connection
from utils import format_datetime
import datetime

public_bp = Blueprint('public', __name__)


def _viewer_regions(cursor, raw_user_id):
    """Resolve the operational districts visible to a logged-in viewer."""
    if not raw_user_id:
        return True, set()
    try:
        user_id = int(raw_user_id)
    except (TypeError, ValueError):
        return False, set()
    cursor.execute("SELECT role FROM users WHERE user_id = %s", (user_id,))
    user = cursor.fetchone()
    if not user:
        return False, set()
    if user.get('role') == 'admin':
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


def _apply_geo_scope(cursor, is_global, regions, *, region_adcode=None, province_name=None, city_name=None):
    """Optionally narrow an admin/global view by district or province/city."""
    requested = (region_adcode or '').strip()
    province = (province_name or '').strip()
    city = (city_name or '').strip()
    if requested:
        if not is_global and requested not in regions:
            return None
        return False, {requested}
    if is_global and (province or city):
        clauses = ["1=1"]
        params = []
        if province:
            clauses.append("province_name = %s")
            params.append(province)
        if city:
            clauses.append("city_name = %s")
            params.append(city)
        cursor.execute(
            f"SELECT adcode FROM administrative_regions WHERE {' AND '.join(clauses)}",
            tuple(params),
        )
        narrowed = {str(row['adcode']) for row in cursor.fetchall()}
        if not narrowed:
            return False, set()
        return False, narrowed
    return is_global, regions


@public_bp.route('/tasks', methods=['GET'])
def get_all_tasks():
    """公开任务大厅：所有人可查看，支持按状态筛选"""
    status_filter = request.args.get('status')  # pending / accepted / in_progress / completed / all
    viewer_user_id = request.args.get('viewer_user_id')
    region_adcode = request.args.get('region_adcode')
    province_name = request.args.get('province_name')
    city_name = request.args.get('city_name')

    conn = get_db_connection()
    if not conn:
        return jsonify({"code": 500, "message": "数据库连接失败"})

    try:
        with conn.cursor() as cursor:
            is_global, regions = _viewer_regions(cursor, viewer_user_id)
            if viewer_user_id and not is_global and not regions:
                return jsonify({"code": 403, "message": "当前账号未配置服务区县"}), 403
            # Province/city filters are only meaningful for admins (especially root).
            if viewer_user_id and (region_adcode or province_name or city_name):
                cursor.execute("SELECT role FROM users WHERE user_id = %s", (viewer_user_id,))
                viewer = cursor.fetchone()
                if not viewer or viewer.get('role') != 'admin':
                    return jsonify({"code": 403, "message": "仅管理员可按省市筛选任务大厅"}), 403
                narrowed = _apply_geo_scope(
                    cursor, is_global, regions,
                    region_adcode=region_adcode,
                    province_name=province_name,
                    city_name=city_name,
                )
                if narrowed is None:
                    return jsonify({"code": 403, "message": "无权查看其他区县任务"}), 403
                is_global, regions = narrowed
                if not is_global and not regions:
                    return jsonify({
                        "code": 200,
                        "message": "获取任务列表成功",
                        "data": {
                            "tasks": [],
                            "stats": {"total": 0, "pending": 0, "in_progress": 0, "completed": 0},
                        },
                    })
            sql = """
                SELECT
                    o.order_id,
                    e.name AS elder_name,
                    o.service_type,
                    o.service_time,
                    o.service_hours,
                    COALESCE(o.address, e.address) AS address_preview,
                    o.status,
                    o.created_at,
                    CASE WHEN o.volunteer_id IS NOT NULL THEN u.real_name ELSE NULL END AS volunteer_name,
                    COALESCE(o.region_adcode, e.region_adcode) AS region_adcode,
                    ar.name AS region_name,
                    ar.province_name,
                    ar.city_name
                FROM orders o
                JOIN elders e ON o.elder_id = e.elder_id
                LEFT JOIN users u ON o.volunteer_id = u.user_id
                LEFT JOIN administrative_regions ar ON ar.adcode = COALESCE(o.region_adcode, e.region_adcode)
                WHERE o.status != 'cancelled'
            """
            params = []

            if status_filter and status_filter != 'all':
                sql += " AND o.status = %s"
                params.append(status_filter)

            if not is_global:
                sql += " AND COALESCE(o.region_adcode, e.region_adcode) IN %s"
                params.append(tuple(regions))

            sql += " ORDER BY o.created_at DESC"

            cursor.execute(sql, tuple(params))
            orders = cursor.fetchall()

            for o in orders:
                if isinstance(o.get('service_time'), datetime.datetime):
                    # Scheduled wall-clock time entered by users — keep as stored.
                    o['service_time'] = o['service_time'].strftime('%Y-%m-%d %H:%M')
                if isinstance(o.get('created_at'), datetime.datetime):
                    o['created_at'] = format_datetime(o.get('created_at'), '%Y-%m-%d %H:%M')
                if not o.get('province_name') and o.get('region_adcode'):
                    from region_service import infer_province_city
                    province, city = infer_province_city(str(o.get('region_adcode') or ''), str(o.get('region_name') or ''))
                    if province:
                        o['province_name'] = province
                    if city and (not o.get('city_name') or o.get('city_name') == o.get('region_name')):
                        o['city_name'] = city
                if not o.get('region_adcode'):
                    o['region_name'] = o.get('region_name') or '未分区'
                    o['province_name'] = o.get('province_name') or '未分区'

            # 统计各状态数量
            stats_sql = """
                SELECT
                    COUNT(*) AS total,
                    COUNT(CASE WHEN o.status = 'pending' THEN 1 END) AS pending_count,
                    COUNT(CASE WHEN o.status IN ('accepted', 'in_progress') THEN 1 END) AS in_progress_count,
                    COUNT(CASE WHEN o.status = 'completed' THEN 1 END) AS completed_count
                FROM orders o
                JOIN elders e ON o.elder_id = e.elder_id
                WHERE o.status != 'cancelled'
            """
            if not is_global:
                stats_sql += " AND COALESCE(o.region_adcode, e.region_adcode) IN %s"
                cursor.execute(stats_sql, (tuple(regions),))
            else:
                cursor.execute(stats_sql)
            stats = cursor.fetchone()

            return jsonify({
                "code": 200,
                "message": "获取任务列表成功",
                "data": {
                    "tasks": orders,
                    "stats": {
                        "total": stats['total'],
                        "pending": stats['pending_count'],
                        "in_progress": stats['in_progress_count'],
                        "completed": stats['completed_count']
                    }
                }
            })
    except Exception as e:
        return jsonify({"code": 500, "message": f"获取任务列表失败: {str(e)}"})
    finally:
        conn.close()


@public_bp.route('/tasks/<int:order_id>/delete', methods=['POST'])
def delete_completed_task(order_id):
    """定量删除已完成的任务（仅管理员可操作）"""
    conn = get_db_connection()
    if not conn:
        return jsonify({"code": 500, "message": "数据库连接失败"})

    try:
        with conn.cursor() as cursor:
            cursor.execute("SELECT status FROM orders WHERE order_id = %s", (order_id,))
            order = cursor.fetchone()

            if not order:
                return jsonify({"code": 404, "message": "任务不存在"})

            if order['status'] != 'completed':
                return jsonify({"code": 400, "message": "只能删除已完成的任务"})

            # 先删除关联的评价和时长审核记录
            cursor.execute("DELETE FROM reviews WHERE order_id = %s", (order_id,))
            cursor.execute("DELETE FROM volunteer_hour_reviews WHERE order_id = %s", (order_id,))
            cursor.execute("DELETE FROM orders WHERE order_id = %s", (order_id,))
            conn.commit()

            return jsonify({"code": 200, "message": "任务删除成功"})
    except Exception as e:
        conn.rollback()
        return jsonify({"code": 500, "message": f"删除失败: {str(e)}"})
    finally:
        conn.close()


@public_bp.route('/tasks/batch-delete', methods=['POST'])
def batch_delete_completed_tasks():
    """批量删除已完成的任务（定量删除）"""
    data = request.get_json()
    order_ids = data.get('order_ids', [])
    viewer_user_id = data.get('viewer_user_id')

    if not order_ids:
        return jsonify({"code": 400, "message": "请选择要删除的任务"})

    conn = get_db_connection()
    if not conn:
        return jsonify({"code": 500, "message": "数据库连接失败"})

    try:
        with conn.cursor() as cursor:
            cursor.execute("SELECT role FROM users WHERE user_id = %s", (viewer_user_id,))
            viewer = cursor.fetchone()
            if not viewer or viewer.get('role') != 'admin':
                return jsonify({"code": 403, "message": "仅管理员可删除任务"}), 403
            is_global, regions = _viewer_regions(cursor, viewer_user_id)
            if not is_global and not regions:
                return jsonify({"code": 403, "message": "该管理员未分配区县管理范围"}), 403
            deleted_count = 0
            for oid in order_ids:
                cursor.execute("SELECT status, region_adcode FROM orders WHERE order_id = %s", (oid,))
                order = cursor.fetchone()
                if order and not is_global and str(order.get('region_adcode')) not in regions:
                    conn.rollback()
                    return jsonify({"code": 403, "message": "不能删除其他区县任务"}), 403
                if order and order['status'] == 'completed':
                    cursor.execute("DELETE FROM reviews WHERE order_id = %s", (oid,))
                    cursor.execute("DELETE FROM volunteer_hour_reviews WHERE order_id = %s", (oid,))
                    cursor.execute("DELETE FROM orders WHERE order_id = %s", (oid,))
                    deleted_count += 1

            conn.commit()
            return jsonify({"code": 200, "message": f"成功删除 {deleted_count} 个已完成任务"})
    except Exception as e:
        conn.rollback()
        return jsonify({"code": 500, "message": f"批量删除失败: {str(e)}"})
    finally:
        conn.close()
