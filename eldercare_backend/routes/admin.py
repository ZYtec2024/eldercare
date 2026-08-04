# routes/admin.py
from flask import Blueprint, request, jsonify, session
from db import get_db_connection
from utils import format_datetime, format_wall_datetime, split_awards_text, merge_awards_text, get_pagination_params, beijing_now
import datetime
import json
import math

admin_bp = Blueprint('admin', __name__)

DISPATCH_SKILL_CODES = {
    'medical_support', 'emergency_response', 'mobility_assist', 'errand',
    'companion', 'rehab', 'digital_assist', 'grooming',
}


@admin_bp.route('/service-records', methods=['GET'])
def list_service_records():
    """Completed services with a retained, read-only route snapshot."""
    try:
        page = max(1, int(request.args.get('page', 1)))
        page_size = max(10, min(100, int(request.args.get('page_size', 30))))
        order_id = request.args.get('order_id', type=int)
    except (TypeError, ValueError):
        return jsonify({"code": 400, "message": "分页参数无效"}), 400

    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            _, is_global, regions, error = _admin_regions(cursor, session.get('user_id'))
            if error:
                return error
            where = "o.status = 'completed'"
            params = []
            if order_id:
                where += " AND o.order_id = %s"
                params.append(order_id)
            if not is_global:
                where += " AND o.region_adcode IN %s"
                params.append(tuple(sorted(regions)))
            cursor.execute(f"SELECT COUNT(*) AS total FROM orders o WHERE {where}", tuple(params))
            total = int(cursor.fetchone()['total'])
            cursor.execute(
                f"""
                SELECT o.order_id, o.service_type, o.address, o.region_adcode,
                       o.service_lng, o.service_lat, o.service_time, o.arrived_at,
                       o.service_started_at, o.service_ended_at, o.notes,
                       e.name AS elder_name, u.real_name AS volunteer_name,
                       r.volunteer_id, r.route_json, r.eta_minutes
                FROM orders o
                JOIN elders e ON e.elder_id = o.elder_id
                LEFT JOIN users u ON u.user_id = o.volunteer_id
                LEFT JOIN dispatch_routes r ON r.order_id = o.order_id
                WHERE {where}
                ORDER BY COALESCE(o.service_ended_at, o.created_at) DESC, o.order_id DESC
                LIMIT %s OFFSET %s
                """,
                tuple(params + [page_size, (page - 1) * page_size]),
            )
            items = []
            for row in cursor.fetchall():
                route = None
                if row.get('route_json'):
                    try:
                        route = json.loads(row['route_json'])
                    except (TypeError, json.JSONDecodeError):
                        route = None
                started = row.get('service_started_at')
                ended = row.get('service_ended_at')
                duration_minutes = None
                if started and ended:
                    duration_minutes = max(0, int(round((ended - started).total_seconds() / 60)))
                route_snapshot = None
                start_lng = None
                start_lat = None
                start_address = ''
                actual_distance_km = None
                if route and row.get('volunteer_id'):
                    planned_path = route.get('path') if isinstance(route.get('path'), list) else []
                    actual_trace = route.get('actual_trace') if isinstance(route.get('actual_trace'), list) else []
                    first_point = actual_trace[0] if actual_trace else (planned_path[0] if planned_path else None)
                    raw_start_lng = route.get('start_lng')
                    raw_start_lat = route.get('start_lat')
                    start_lng = float(raw_start_lng) if raw_start_lng is not None else (float(first_point[0]) if first_point else None)
                    start_lat = float(raw_start_lat) if raw_start_lat is not None else (float(first_point[1]) if first_point else None)
                    start_address = str(route.get('start_address') or '')
                    route_snapshot = {
                        'order_id': int(row['order_id']),
                        'volunteer_id': int(row['volunteer_id']),
                        'eta_minutes': int(row.get('eta_minutes') or 0),
                        'traffic_version': 0,
                        **route,
                    }
                    if len(actual_trace) >= 2:
                        distance_m = 0.0
                        for previous, current in zip(actual_trace, actual_trace[1:]):
                            mean_lat = math.radians((float(previous[1]) + float(current[1])) / 2)
                            dx = (float(current[0]) - float(previous[0])) * 111000 * math.cos(mean_lat)
                            dy = (float(current[1]) - float(previous[1])) * 111000
                            distance_m += math.hypot(dx, dy)
                        actual_distance_km = round(distance_m / 1000, 2)
                        route_snapshot['planned_path'] = planned_path
                        route_snapshot['path'] = actual_trace
                        route_snapshot['traffic_segments'] = []
                        route_snapshot['geometry_source'] = 'actual_gps'
                        route_snapshot['trace_source'] = 'browser_gps'
                    else:
                        route_snapshot['geometry_source'] = 'planned_fallback'
                        route_snapshot['trace_source'] = 'planned_fallback'
                items.append({
                    'order_id': int(row['order_id']),
                    'elder_name': row['elder_name'],
                    'volunteer_name': row.get('volunteer_name'),
                    'volunteer_id': int(row['volunteer_id']) if row.get('volunteer_id') else None,
                    'service_type': row['service_type'],
                    'address': row.get('address'),
                    'region_adcode': row.get('region_adcode'),
                    'service_lng': float(row['service_lng']) if row.get('service_lng') is not None else None,
                    'service_lat': float(row['service_lat']) if row.get('service_lat') is not None else None,
                    'service_time': format_wall_datetime(row.get('service_time')),
                    'arrived_at': format_wall_datetime(row.get('arrived_at')),
                    'service_started_at': format_wall_datetime(started),
                    'service_ended_at': format_wall_datetime(ended),
                    'duration_minutes': duration_minutes,
                    'notes': row.get('notes'),
                    'volunteer_start_lng': start_lng,
                    'volunteer_start_lat': start_lat,
                    'volunteer_start_address': start_address,
                    'actual_distance_km': actual_distance_km,
                    'route': route_snapshot,
                })
            return jsonify({'code': 200, 'message': '服务记录获取成功', 'data': {'items': items, 'total': total}})
    finally:
        conn.close()


@admin_bp.route('/login-audits', methods=['GET'])
def list_login_audits():
    """Return recent masked login results to the root administrator only."""
    try:
        page = max(1, int(request.args.get('page', 1)))
        page_size = max(10, min(100, int(request.args.get('page_size', 30))))
    except (TypeError, ValueError):
        return jsonify({"code": 400, "message": "分页参数无效"}), 400

    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            _, is_global, _, error = _admin_regions(cursor, session.get('user_id'))
            if error:
                return error
            if not is_global:
                return jsonify({"code": 403, "message": "仅总管理员可以查看登录记录"}), 403
            cursor.execute("SELECT COUNT(*) AS total FROM login_audit_logs")
            total = int(cursor.fetchone()['total'])
            cursor.execute(
                """
                SELECT audit_id, user_id, username, role, masked_ip,
                       login_success, created_at
                FROM login_audit_logs
                ORDER BY created_at DESC, audit_id DESC
                LIMIT %s OFFSET %s
                """,
                (page_size, (page - 1) * page_size),
            )
            items = []
            for row in cursor.fetchall():
                items.append({
                    "audit_id": int(row['audit_id']),
                    "user_id": int(row['user_id']) if row.get('user_id') is not None else None,
                    "username": row['username'],
                    "role": row.get('role'),
                    "masked_ip": row['masked_ip'],
                    "login_success": bool(row['login_success']),
                    "created_at": format_datetime(row.get('created_at')),
                })
            return jsonify({
                "code": 200,
                "message": "登录记录获取成功",
                "data": {"items": items, "total": total},
            })
    finally:
        conn.close()


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
        return None, False, set(), (jsonify({
            "code": 403,
            "message": "还未绑定区域，请联系总管理员在「区域管理」中为您分配区县后再查看",
        }), 403)
    return admin_user_id, False, scopes, None


def _apply_admin_geo_scope(cursor, is_global, regions, *, region_adcode=None, province_name=None, city_name=None):
    """Narrow root/global alert views by cascading 全国→省→市→区 selection."""
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
        return False, narrowed
    return is_global, regions


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
        UNION
        SELECT region_adcode
        FROM admin_region_scope
        WHERE admin_user_id = %s AND region_adcode <> '*'
        """,
        (user_id, user_id, user_id, user_id),
    )
    return {str(row['region_adcode']) for row in cursor.fetchall() if row.get('region_adcode')}


def _scope_allows_user(cursor, user_id, is_global, regions):
    return is_global or bool(_user_regions(cursor, user_id) & regions)


def _region_user_filter_sql():
    """SQL fragment: users who operate in the given region tuple (%s x4)."""
    return """u.user_id IN (
        SELECT user_id FROM elders WHERE region_adcode IN %s
        UNION SELECT volunteer_id FROM volunteer_location_state WHERE service_region_adcode IN %s
        UNION SELECT rel.family_user_id FROM user_elder_relation rel
              JOIN elders e ON e.elder_id = rel.elder_id WHERE e.region_adcode IN %s
        UNION SELECT admin_user_id FROM admin_region_scope
              WHERE region_adcode IN %s
    )"""


def _enrich_admin_users(cursor, users, *, is_global: bool = True, viewer_regions: set[str] | None = None):
    """Attach district and elder-binding context for admin CRM views.

    Family related_elders are intentionally cross-region: if a family binds one
    elder in Baoshan and another in Pudong, both district admins who can see the
    family (via either elder) receive the full binding list for troubleshooting.
    """
    if not users:
        return []
    user_ids = tuple(int(row['user_id']) for row in users)
    placeholders = ','.join(['%s'] * len(user_ids))
    scope_set = set() if is_global else {str(code) for code in (viewer_regions or set())}

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
        f"""SELECT rel.family_user_id, rel.relation_type, e.elder_id, e.name, e.address, e.region_adcode,
                   COALESCE(ar.name, e.region_adcode) AS region_name
            FROM user_elder_relation rel
            JOIN elders e ON e.elder_id = rel.elder_id
            LEFT JOIN administrative_regions ar ON ar.adcode = e.region_adcode
            WHERE rel.family_user_id IN ({placeholders})
            ORDER BY e.elder_id""",
        user_ids,
    )
    for row in cursor.fetchall():
        elder_region = str(row.get('region_adcode') or '')
        family_elders.setdefault(int(row['family_user_id']), []).append({
            'elder_id': int(row['elder_id']),
            'name': row['name'],
            'address': row.get('address') or '',
            'relation_type': str(row.get('relation_type') or '') or None,
            'region_adcode': row.get('region_adcode'),
            'region_name': row.get('region_name') or row.get('region_adcode') or '',
            # True when this elder's registered district is in the viewer's scope
            # (or viewer is root). Never used to hide cross-district bindings.
            'in_admin_scope': bool(is_global or (elder_region and elder_region in scope_set)),
        })

    volunteer_region: dict[int, dict] = {}
    cursor.execute(
        f"""SELECT v.volunteer_id, v.service_region_adcode AS region_adcode,
                   COALESCE(ar.name, v.service_region_adcode) AS region_name,
                   COALESCE(string_agg(tags.skill_tag, '|'), '') AS verified_skills_text
            FROM volunteer_location_state v
            LEFT JOIN administrative_regions ar ON ar.adcode = v.service_region_adcode
            LEFT JOIN volunteer_skill_tags tags ON tags.volunteer_id = v.volunteer_id
            WHERE v.volunteer_id IN ({placeholders})
            GROUP BY v.volunteer_id, v.service_region_adcode, ar.name""",
        user_ids,
    )
    for row in cursor.fetchall():
        volunteer_region[int(row['volunteer_id'])] = {
            'region_adcode': row.get('region_adcode'),
            'region_name': row.get('region_name') or row.get('region_adcode') or '',
            'verified_skills': [
                value for value in str(row.get('verified_skills_text') or '').split('|') if value
            ],
        }

    admin_regions: dict[int, list[dict]] = {}
    cursor.execute(
        f"""SELECT s.admin_user_id, s.region_adcode,
                   COALESCE(ar.name, s.region_adcode) AS region_name
            FROM admin_region_scope s
            LEFT JOIN administrative_regions ar ON ar.adcode = s.region_adcode
            WHERE s.admin_user_id IN ({placeholders})
              AND s.region_adcode <> '*'
            ORDER BY ar.province_name, ar.city_name, ar.name, s.region_adcode""",
        user_ids,
    )
    for row in cursor.fetchall():
        admin_regions.setdefault(int(row['admin_user_id']), []).append({
            'region_adcode': str(row['region_adcode']),
            'region_name': row.get('region_name') or row['region_adcode'],
        })

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
            # Full cross-district bindings — do not slice by viewer region.
            related_elders = list(family_elders.get(uid, []))
            for elder in related_elders:
                code = str(elder.get('region_adcode') or '')
                if code and code not in region_adcodes:
                    region_adcodes.append(code)
                    region_names.append(elder.get('region_name') or code)
            item['family_binding_policy'] = 'full_cross_region'
        elif role == 'volunteer' and uid in volunteer_region:
            profile = volunteer_region[uid]
            if profile.get('region_adcode'):
                region_adcodes = [str(profile['region_adcode'])]
                region_names = [profile['region_name']]
            item['verified_skills'] = profile.get('verified_skills', [])
        elif role == 'admin':
            for region in admin_regions.get(uid, []):
                region_adcodes.append(region['region_adcode'])
                region_names.append(region['region_name'])

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
    province_name = (request.args.get('province_name') or '').strip()
    city_name = (request.args.get('city_name') or '').strip()
    page = int(request.args.get('page', 1))
    limit = int(request.args.get('limit', 10))
    offset = (page - 1) * limit

    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            _, is_global, regions, error = _admin_regions(cursor, request.args.get('admin_user_id'))
            if error:
                return error
            requester_is_root = is_global
            if role == 'admin' and not requester_is_root:
                return jsonify({"code": 403, "message": "区域管理员无权查看管理员账号"}), 403

            narrowed = _apply_admin_geo_scope(
                cursor, is_global, regions,
                region_adcode=requested_region or None,
                province_name=province_name or None,
                city_name=city_name or None,
            )
            if narrowed is None:
                return jsonify({"code": 403, "message": "无权查看该区县用户"}), 403
            is_global, regions = narrowed

            filter_regions = None if is_global else set(regions)
            if filter_regions is not None and not filter_regions:
                return jsonify({"code": 200, "message": "获取成功", "data": {"total": 0, "list": []}})

            region_filter = ""
            scope_params = []
            if filter_regions is not None:
                scoped = tuple(filter_regions)
                region_filter = _region_user_filter_sql()
                scope_params = [scoped, scoped, scoped, scoped]

            base_sql = """
                SELECT
                    u.user_id,
                    u.username,
                    u.role,
                    u.real_name,
                    u.phone,
                    u.email,
                    vp.skills AS skills_description,
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

            if not requester_is_root:
                base_sql += " AND u.role <> 'admin'" if (region_filter or role or keyword) else " WHERE u.role <> 'admin'"
                count_sql += " AND u.role <> 'admin'" if (region_filter or role or keyword) else " WHERE u.role <> 'admin'"

            cursor.execute(count_sql, tuple(scope_params + params))
            total_count = cursor.fetchone()['total']

            base_sql += " ORDER BY u.created_at DESC LIMIT %s OFFSET %s"
            params.extend([limit, offset])

            cursor.execute(base_sql, tuple(scope_params + params))
            users = _enrich_admin_users(
                cursor,
                cursor.fetchall(),
                is_global=is_global,
                viewer_regions=set(regions) if not is_global else None,
            )

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
            requester_id, is_global, regions, error = _admin_regions(cursor, data.get('admin_user_id'))
            if error:
                return error
            cursor.execute("SELECT user_id, role FROM users WHERE user_id = %s", (user_id,))
            target = cursor.fetchone()
            if not target:
                return jsonify({"code": 404, "message": "用户不存在"})

            if target['role'] == 'admin':
                if not is_global:
                    return jsonify({"code": 403, "message": "仅总管理员可删除管理员账号"}), 403
                if int(user_id) == int(requester_id):
                    return jsonify({"code": 403, "message": "不能删除当前登录的总管理员账号"}), 403
                cursor.execute(
                    "SELECT region_adcode FROM admin_region_scope WHERE admin_user_id = %s",
                    (user_id,),
                )
                assigned = [str(row['region_adcode']) for row in cursor.fetchall()]
                if assigned:
                    return jsonify({
                        "code": 409,
                        "message": "该管理员仍绑定管理区域，请先在区域管理中解绑后再删除",
                    }), 409
            elif not _scope_allows_user(cursor, user_id, is_global, regions):
                return jsonify({"code": 403, "message": "无权管理其他区县用户"}), 403

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
            admin_user_id, is_global, regions, error = _admin_regions(cursor, request.args.get('admin_user_id'))
            if error:
                return error
            narrowed = _apply_admin_geo_scope(
                cursor, is_global, regions,
                region_adcode=request.args.get('region_adcode'),
                province_name=request.args.get('province_name'),
                city_name=request.args.get('city_name'),
            )
            if narrowed is None:
                return jsonify({"code": 403, "message": "无权查看其他区县告警"}), 403
            is_global, regions = narrowed
            if not is_global and not regions:
                return jsonify({"code": 200, "message": "获取报警列表成功", "data": []})
            # An alert is a notification row. For SOS, the linked incident is
            # the lifecycle source of truth: acknowledged is still active.
            # District admins only see the SOS desk they were exclusively assigned;
            # root keeps the full scoped list. Health alerts stay region-scoped.
            sql = """
                SELECT a.alert_id, e.name AS elder_name, a.alert_type,
                       a.description, a.is_handled, a.created_at,
                       a.emergency_incident_id,
                       COALESCE(ei.region_adcode, e.region_adcode) AS region_adcode,
                       ar.name AS region_name, ar.province_name, ar.city_name,
                       ei.status AS incident_status, ei.incident_type,
                       ei.acknowledged_at, ei.resolved_at, ei.resolution_summary,
                       ei.linked_order_id, ei.assigned_admin_id, c.conversation_id,
                       ei.service_address, ei.service_lng, ei.service_lat,
                       o.status AS linked_order_status, vu.real_name AS linked_volunteer_name,
                       (SELECT content FROM conversation_messages cm
                        WHERE cm.conversation_id = c.conversation_id
                        ORDER BY cm.created_at DESC, cm.message_id DESC LIMIT 1) AS last_message,
                       (SELECT created_at FROM conversation_messages cm
                        WHERE cm.conversation_id = c.conversation_id
                        ORDER BY cm.created_at DESC, cm.message_id DESC LIMIT 1) AS last_message_at
                FROM alerts a
                JOIN elders e ON a.elder_id = e.elder_id
                LEFT JOIN emergency_incidents ei ON ei.incident_id = a.emergency_incident_id
                LEFT JOIN administrative_regions ar
                       ON ar.adcode = COALESCE(ei.region_adcode, e.region_adcode)
                LEFT JOIN conversations c ON c.incident_id = ei.incident_id AND c.conversation_type = 'sos'
                LEFT JOIN orders o ON o.order_id = ei.linked_order_id
                LEFT JOIN users vu ON vu.user_id = o.volunteer_id
            """
            params = []
            where_parts = []
            if not is_global:
                where_parts.append("COALESCE(ei.region_adcode, e.region_adcode) IN %s")
                params.append(tuple(regions))
                where_parts.append(
                    """(
                        a.emergency_incident_id IS NULL
                        OR ei.assigned_admin_id = %s
                        OR EXISTS (
                            SELECT 1 FROM emergency_notifications en
                             WHERE en.incident_id = a.emergency_incident_id
                               AND en.recipient_user_id = %s
                        )
                    )"""
                )
                params.extend([admin_user_id, admin_user_id])
            if where_parts:
                sql += " WHERE " + " AND ".join(where_parts)
            sql += """
                ORDER BY
                  CASE COALESCE(ei.status, CASE WHEN a.is_handled THEN 'resolved' ELSE 'reported' END)
                    WHEN 'reported' THEN 0
                    WHEN 'acknowledged' THEN 1
                    WHEN 'dispatching' THEN 2
                    WHEN 'awaiting_admin_close' THEN 3
                    ELSE 4
                  END,
                  a.created_at DESC
            """
            cursor.execute(sql, params)
            alerts = cursor.fetchall()
            
            for a in alerts:
                for field in ('created_at', 'acknowledged_at', 'resolved_at', 'last_message_at'):
                    if isinstance(a.get(field), datetime.datetime):
                        a[field] = format_datetime(a.get(field))

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
            narrowed = _apply_admin_geo_scope(
                cursor, is_global, regions,
                region_adcode=request.args.get('region_adcode'),
                province_name=request.args.get('province_name'),
                city_name=request.args.get('city_name'),
            )
            if narrowed is None:
                return jsonify({"code": 403, "message": "无权查看该区县总览"}), 403
            is_global, regions = narrowed
            if not is_global and not regions:
                return jsonify({
                    "code": 200,
                    "message": "当前区域暂无数据",
                    "data": {
                        "total_users_count": 0,
                        "total_service_hours": 0,
                        "service_type_distribution": [],
                    },
                })
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
    skill_tags = [
        str(value).strip() for value in (data.get('skill_tags') or [])
        if str(value).strip() in DISPATCH_SKILL_CODES
    ]

    if action not in ['approve', 'reject']:
        return jsonify({"code": 400, "message": "审核动作必须为 approve 或 reject"})
    if action == 'approve' and not skill_tags:
        return jsonify({"code": 400, "message": "审核通过前请至少分配一项认证技能"}), 400

    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            _, is_global, regions, error = _admin_regions(cursor, data.get('admin_user_id'))
            if error:
                return error
            if not _scope_allows_user(cursor, user_id, is_global, regions):
                return jsonify({"code": 403, "message": "无权审核其他区县志愿者"}), 403
            status = 'approved' if action == 'approve' else 'rejected'
            sql = "UPDATE volunteers_profile SET audit_status = %s WHERE user_id = %s"
            cursor.execute(sql, (status, user_id))
            
            if cursor.rowcount == 0:
                return jsonify({"code": 400, "message": "该志愿者档案不存在"})
            cursor.execute("DELETE FROM volunteer_skill_tags WHERE volunteer_id = %s", (user_id,))
            if status == 'approved':
                for skill_tag in skill_tags:
                    cursor.execute(
                        """INSERT INTO volunteer_skill_tags (volunteer_id, skill_tag, verified)
                           VALUES (%s, %s, TRUE)""",
                        (user_id, skill_tag),
                    )
                cursor.execute(
                    """UPDATE volunteer_location_state
                       SET availability = CASE
                               WHEN availability = 'offline' THEN 'idle'
                               ELSE availability
                           END,
                           updated_at = CURRENT_TIMESTAMP
                       WHERE volunteer_id = %s""",
                    (user_id,),
                )
            else:
                cursor.execute(
                    """UPDATE volunteer_location_state
                       SET availability = 'offline', auto_accept_enabled = FALSE,
                           updated_at = CURRENT_TIMESTAMP
                       WHERE volunteer_id = %s""",
                    (user_id,),
                )
            
            conn.commit()
            msg = "审核通过，该志愿者已可接单！" if status == 'approved' else "已驳回该志愿者的申请。"
            return jsonify({
                "code": 200,
                "message": msg,
                "data": {"review_status": status, "verified_skills": skill_tags},
            })
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

    if alert_id is None:
        return jsonify({"code": 400, "message": "缺少 alert_id"})

    try:
        alert_id = int(alert_id)
    except (TypeError, ValueError):
        return jsonify({"code": 400, "message": "alert_id 必须是数字"})

    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            admin_user_id, is_global, regions, error = _admin_regions(cursor, data.get('admin_user_id'))
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
                if action == 'close' and not resolution_summary:
                    return jsonify({"code": 400, "message": "关闭紧急事件前请填写处置结果"}), 400
                cursor.execute("""SELECT incident_id, status, linked_order_id, assigned_admin_id
                                  FROM emergency_incidents WHERE incident_id = %s FOR UPDATE""", (incident_id,))
                incident = cursor.fetchone()
                if not incident:
                    return jsonify({"code": 404, "message": "关联紧急事件不存在"}), 404
                if not is_global:
                    owns = incident.get('assigned_admin_id') and int(incident['assigned_admin_id']) == int(admin_user_id)
                    if not owns:
                        cursor.execute(
                            """SELECT 1 FROM emergency_notifications
                                WHERE incident_id = %s AND recipient_user_id = %s""",
                            (incident_id, admin_user_id),
                        )
                        owns = bool(cursor.fetchone())
                    if not owns:
                        return jsonify({"code": 403, "message": "该 SOS 已分配给其他区管理员，您不能处理"}), 403
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

                # Closing the SOS desk must also clear any still-open linked order;
                # otherwise elder「谁在帮我」keeps a pending/active service while
                # admin alerts look fully done.
                linked_order_id = int(incident['linked_order_id']) if incident.get('linked_order_id') else None
                if linked_order_id:
                    cursor.execute(
                        "SELECT order_id, status FROM orders WHERE order_id = %s FOR UPDATE",
                        (linked_order_id,),
                    )
                    linked_order = cursor.fetchone()
                    if linked_order and linked_order['status'] in ('pending', 'accepted', 'in_progress'):
                        from routes.dispatch import finalize_cancelled_dispatch_order
                        finalize_cancelled_dispatch_order(
                            cursor,
                            linked_order_id,
                            actor_user_id=admin_user_id,
                            event_type='admin_sos_closed',
                            event_message=f'管理员结案关闭紧急事件，关联服务已同步取消：{resolution_summary}',
                            archive_message=f'紧急事件已关闭：{resolution_summary}。关联服务已结束。',
                            emergency_summary=resolution_summary,
                        )
                        # Keep the admin-authored close wording even if finalize already resolved.
                        cursor.execute(
                            """UPDATE emergency_incidents
                               SET status = 'resolved',
                                   resolved_at = COALESCE(resolved_at, CURRENT_TIMESTAMP),
                                   resolved_by = COALESCE(resolved_by, %s),
                                   resolution_summary = %s
                               WHERE incident_id = %s""",
                            (admin_user_id, resolution_summary, incident_id),
                        )
                        cursor.execute(
                            "UPDATE alerts SET is_handled = TRUE WHERE emergency_incident_id = %s",
                            (incident_id,),
                        )
                        conn.commit()
                        return jsonify({
                            "code": 200,
                            "message": "紧急事件已关闭，关联未完成服务已同步取消",
                            "data": {"status": "resolved", "cancelled_order_id": linked_order_id},
                        })

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
                today_str = beijing_now().strftime('%Y年%m月%d日')
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
                row['service_time'] = format_wall_datetime(row.get('service_time'))
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


@admin_bp.route('/donations', methods=['GET'])
def list_donations():
    """Root-admin inbox for sandbox donation records."""
    conn = get_db_connection()
    if not conn:
        return jsonify({"code": 500, "message": "数据库连接失败"}), 500
    try:
        with conn.cursor() as cursor:
            _, is_global, _, error = _admin_regions(cursor, request.args.get('admin_user_id'))
            if error:
                return error
            if not is_global:
                return jsonify({"code": 403, "message": "仅总管理员可以查看爱心捐赠记录"}), 403
            page, page_size, offset = get_pagination_params(request)
            cursor.execute(
                """SELECT COUNT(*) AS total, COALESCE(SUM(amount), 0) AS total_amount
                   FROM donation_records WHERE payment_status = 'success'"""
            )
            summary = cursor.fetchone()
            cursor.execute(
                """SELECT donation_id, donor_name, contact, amount, payment_method,
                          payment_status, transaction_no, message, created_at
                   FROM donation_records
                   ORDER BY created_at DESC, donation_id DESC
                   LIMIT %s OFFSET %s""",
                (page_size, offset),
            )
            items = cursor.fetchall()
            for item in items:
                item['created_at'] = format_datetime(item.get('created_at'))
            return jsonify({
                "code": 200,
                "message": "获取爱心捐赠记录成功",
                "data": {
                    "items": items,
                    "total": int(summary.get('total') or 0),
                    "total_amount": float(summary.get('total_amount') or 0),
                    "page": page,
                    "page_size": page_size,
                },
            })
    except Exception as exc:
        return jsonify({"code": 500, "message": f"获取爱心捐赠记录失败: {exc}"}), 500
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
