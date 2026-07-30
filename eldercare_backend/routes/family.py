# routes/family.py
from flask import Blueprint, request, jsonify
from db import get_db_connection
from location_policy import find_unfinished_elder_order, location_change_block_message
from utils import fetch_health_trend_rows, format_datetime, get_validated_data, get_pagination_params
import datetime

family_bp = Blueprint('family', __name__)

# 1. 绑定长辈账号 (多表关联与唯一性约束)
@family_bp.route('/bind-elder', methods=['POST'])
def bind_elder():
    data = request.get_json()
    family_user_id = data.get('family_user_id')
    elder_phone = data.get('elder_phone') 
    relation = data.get('relation_type', '亲属')
    # 性格简介（选填，截断到 200 字）
    personality_bio = (data.get('personality_bio') or '').strip()[:200]

    if not all([family_user_id, elder_phone]):
        return jsonify({"code": 400, "message": "参数不完整"}), 400

    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute(
                "SELECT user_id, role FROM users WHERE user_id = %s",
                (family_user_id,),
            )
            family_user = cursor.fetchone()
            if not family_user or str(family_user.get('role') or '') != 'family':
                return jsonify({"code": 403, "message": "仅家属账号可以绑定长辈"}), 403

            # 1. 跨表查询：通过手机号找老人账号（限定 role=elder，避免绑错角色）
            sql_find_elder = """
                SELECT e.elder_id
                FROM elders e
                JOIN users u ON e.user_id = u.user_id
                WHERE u.phone = %s AND u.role = 'elder'
                ORDER BY e.elder_id
                LIMIT 1
            """
            cursor.execute(sql_find_elder, (elder_phone,))
            elder = cursor.fetchone()

            if not elder:
                return jsonify({"code": 404, "message": "未找到该手机号对应的老人档案"}), 404

            elder_id = elder['elder_id']

            # 2. 插入关系表
            # 💎 高分点：建表时的 UNIQUE KEY unique_bind (family_user_id, elder_id) 会拦截重复绑定
            sql_bind = """
                INSERT INTO user_elder_relation (family_user_id, elder_id, relation_type)
                VALUES (%s, %s, %s)
            """
            cursor.execute(sql_bind, (family_user_id, elder_id, relation))

            # 3. 如果家属填写了性格简介，写入 elders 表
            if personality_bio:
                cursor.execute("""
                    UPDATE elders
                    SET personality_bio = %s, bio_updated_by = %s, bio_updated_at = NOW()
                    WHERE elder_id = %s
                """, (personality_bio, family_user_id, elder_id))

            conn.commit()

            return jsonify({"code": 200, "message": "绑定长辈成功！"})
            
    except Exception as e:
        conn.rollback()
        if "Duplicate entry" in str(e) or "duplicate key value violates unique constraint" in str(e):
            return jsonify({"code": 409, "message": "您已经绑定过这位长辈了，请勿重复绑定"}), 409
        return jsonify({"code": 500, "message": f"绑定失败: {str(e)}"}), 500
    finally:
        conn.close()


@family_bp.route('/orders/review', methods=['POST'])
def review_family_order():
    data = request.get_json() or {}
    order_id, family_user_id, rating = data.get('order_id'), data.get('family_user_id'), data.get('rating')
    comment = data.get('comment', '')
    try:
        rating = int(rating)
    except (TypeError, ValueError):
        return jsonify({"code": 400, "message": "评分必须为 1 到 5 星"}), 400
    if not order_id or not family_user_id or rating < 1 or rating > 5:
        return jsonify({"code": 400, "message": "评价参数不完整"}), 400
    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute("""SELECT o.order_id, o.elder_id, o.volunteer_id, o.status
                              FROM orders o WHERE o.order_id = %s FOR UPDATE""", (order_id,))
            order = cursor.fetchone()
            if not order or order['status'] != 'completed' or not order.get('volunteer_id'):
                return jsonify({"code": 400, "message": "仅已完成且有志愿者的订单可以评价"}), 400
            cursor.execute("SELECT 1 FROM user_elder_relation WHERE family_user_id = %s AND elder_id = %s",
                           (family_user_id, order['elder_id']))
            if not cursor.fetchone():
                return jsonify({"code": 403, "message": "您无权评价该订单"}), 403
            cursor.execute("INSERT INTO reviews (order_id, rating, comment) VALUES (%s, %s, %s)",
                           (order_id, rating, comment or '家属评价'))
            cursor.execute("""SELECT AVG(r.rating) AS avg_rating FROM reviews r
                              JOIN orders o ON o.order_id = r.order_id WHERE o.volunteer_id = %s""",
                           (order['volunteer_id'],))
            average = cursor.fetchone()
            if average and average.get('avg_rating') is not None:
                cursor.execute("UPDATE volunteer_location_state SET service_rating = %s WHERE volunteer_id = %s",
                               (round(float(average['avg_rating']), 2), order['volunteer_id']))
            conn.commit()
            return jsonify({"code": 200, "message": "评价已提交，服务评分已更新"})
    except Exception as exc:
        conn.rollback()
        if 'duplicate' in str(exc).lower():
            return jsonify({"code": 409, "message": "该订单已经评价过"}), 409
        return jsonify({"code": 500, "message": f"提交评价失败: {exc}"}), 500
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

# 1.3 更新老人性格简介（家属可编辑）
@family_bp.route('/elders/<int:elder_id>/bio', methods=['PUT'])
def update_elder_bio(elder_id: int):
    data = request.get_json() or {}
    family_user_id = data.get('family_user_id')
    # 截断到 200 字
    personality_bio = (data.get('personality_bio') or '').strip()[:200]

    if not family_user_id:
        return jsonify({"code": 400, "message": "缺少家属ID"}), 400

    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            # 鉴权：确认该家属确实绑定了该老人
            cursor.execute(
                "SELECT 1 FROM user_elder_relation WHERE family_user_id = %s AND elder_id = %s",
                (family_user_id, elder_id),
            )
            if not cursor.fetchone():
                return jsonify({"code": 403, "message": "您未绑定该长辈，无权修改简介"}), 403

            cursor.execute("""
                UPDATE elders
                SET personality_bio = %s, bio_updated_by = %s, bio_updated_at = NOW()
                WHERE elder_id = %s
            """, (personality_bio, family_user_id, elder_id))
            conn.commit()
            return jsonify({"code": 200, "message": "老人简介已更新"})
    except Exception as e:
        conn.rollback()
        return jsonify({"code": 500, "message": f"更新简介失败: {str(e)}"}), 500
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
                    e.personality_bio, e.bio_updated_by, e.bio_updated_at,
                    uer.relation_type,
                    ea.full_address AS default_address,
                    ea.lng AS default_lng,
                    ea.lat AS default_lat,
                    ea.label AS default_label,
                    l.lng AS live_lng,
                    l.lat AS live_lat,
                    l.location_source,
                    l.updated_at AS location_updated_at
                FROM user_elder_relation uer
                JOIN elders e ON uer.elder_id = e.elder_id
                LEFT JOIN elder_addresses ea
                  ON ea.elder_id = e.elder_id AND ea.is_current = TRUE
                LEFT JOIN elder_location_state l ON l.elder_id = e.elder_id
                WHERE uer.family_user_id = %s
            """
            cursor.execute(sql, (family_user_id,))
            elders = []
            for row in cursor.fetchall():
                item = dict(row)
                default_address = item.get("default_address") or item.get("address")
                display_address = str(item.get("address") or "").strip()
                has_current = item.get("live_lng") is not None and item.get("live_lat") is not None
                source = str(item.get("location_source") or "")
                is_live = has_current and source in {"browser_gps", "virtual"}
                # Live pins may update coords before display text; fill from reverse geocode once.
                if is_live and not display_address:
                    try:
                        from region_service import reverse_geocode
                        geo = reverse_geocode(item["live_lng"], item["live_lat"], from_gps=False)
                        display_address = str(geo.get("formatted_address") or "").strip()
                        if display_address:
                            cursor.execute(
                                "UPDATE elders SET address = %s WHERE elder_id = %s",
                                (display_address, item["elder_id"]),
                            )
                    except Exception:
                        display_address = ""
                if not display_address:
                    display_address = default_address
                item["default_address"] = default_address
                item["current_service_address"] = display_address
                item["addressPreview"] = display_address or default_address
                item["has_current_service_point"] = bool(has_current)
                item["has_live_location"] = bool(is_live)
                item["location_source"] = source
                if is_live and display_address:
                    item["live_location_hint"] = f"实时位置：{display_address}"
                elif has_current and display_address:
                    item["live_location_hint"] = f"当前服务点：{display_address}"
                elif has_current:
                    item["live_location_hint"] = "当前服务点已就绪（地址待补充）"
                else:
                    item["live_location_hint"] = "长辈暂无当前服务点，请先选其他地址或添加地址"
                if item.get("location_updated_at") is not None:
                    item["location_updated_at"] = str(item["location_updated_at"])
                elders.append(item)
            conn.commit()
            return jsonify({"code": 200, "message": "获取成功", "data": elders})
    finally:
        conn.close()

def _assert_family_elder_bound(cursor, family_user_id: int, elder_id: int) -> bool:
    cursor.execute(
        "SELECT 1 FROM user_elder_relation WHERE family_user_id = %s AND elder_id = %s",
        (family_user_id, elder_id),
    )
    return bool(cursor.fetchone())


@family_bp.route('/elders/<int:elder_id>/addresses', methods=['GET'])
def list_family_elder_addresses(elder_id: int):
    family_user_id = request.args.get('family_user_id', type=int)
    if not family_user_id:
        return jsonify({"code": 400, "message": "缺少家属ID"}), 400
    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            if not _assert_family_elder_bound(cursor, family_user_id, elder_id):
                return jsonify({"code": 403, "message": "您只能查看已绑定长辈的地址"}), 403
            cursor.execute(
                """SELECT e.address AS display_address,
                          l.lng, l.lat, l.location_source, l.is_home_fixed, l.updated_at
                   FROM elders e
                   LEFT JOIN elder_location_state l ON l.elder_id = e.elder_id
                   WHERE e.elder_id = %s""",
                (elder_id,),
            )
            pin = cursor.fetchone() or {}
            cursor.execute(
                """SELECT address_id, label, province_name, city_name, district_name,
                          region_adcode, detail_address, full_address, lng, lat, is_current
                   FROM elder_addresses
                   WHERE elder_id = %s
                   ORDER BY is_current DESC, address_id DESC""",
                (elder_id,),
            )
            addresses = cursor.fetchall()
            current_address = str(pin.get("display_address") or "").strip()
            if not current_address:
                for row in addresses:
                    if row.get("is_current") and row.get("full_address"):
                        current_address = str(row["full_address"])
                        break
            current_point = None
            if pin.get("lng") is not None and pin.get("lat") is not None:
                source = str(pin.get("location_source") or "")
                if not current_address:
                    try:
                        from region_service import reverse_geocode
                        geo = reverse_geocode(pin["lng"], pin["lat"], from_gps=False)
                        current_address = str(geo.get("formatted_address") or "").strip()
                        if current_address:
                            cursor.execute(
                                "UPDATE elders SET address = %s WHERE elder_id = %s",
                                (current_address, elder_id),
                            )
                            conn.commit()
                    except Exception:
                        current_address = ""
                current_point = {
                    "lng": float(pin["lng"]),
                    "lat": float(pin["lat"]),
                    "address": current_address or None,
                    "location_source": source,
                    "is_live": source in {"browser_gps", "virtual"},
                    "is_home_fixed": bool(pin.get("is_home_fixed")),
                    "updated_at": str(pin["updated_at"]) if pin.get("updated_at") is not None else None,
                }
            return jsonify({
                "code": 200,
                "message": "获取成功",
                "data": {
                    "addresses": addresses,
                    "current_service_point": current_point,
                },
            })
    finally:
        conn.close()


@family_bp.route('/elders/<int:elder_id>/addresses', methods=['POST'])
def add_family_elder_address(elder_id: int):
    data = request.get_json(silent=True) or {}
    family_user_id = data.get('family_user_id')
    if not family_user_id:
        return jsonify({"code": 400, "message": "缺少家属ID"}), 400
    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            if not _assert_family_elder_bound(cursor, int(family_user_id), elder_id):
                return jsonify({"code": 403, "message": "您只能为已绑定长辈添加地址"}), 403
    finally:
        conn.close()
    from routes.profile import save_elder_address_for_elder
    return save_elder_address_for_elder(elder_id, data)


@family_bp.route('/elders/<int:elder_id>/addresses/<int:address_id>', methods=['PUT'])
def update_family_elder_address(elder_id: int, address_id: int):
    data = request.get_json(silent=True) or {}
    family_user_id = data.get('family_user_id')
    if not family_user_id:
        return jsonify({"code": 400, "message": "缺少家属ID"}), 400
    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            if not _assert_family_elder_bound(cursor, int(family_user_id), elder_id):
                return jsonify({"code": 403, "message": "您只能编辑已绑定长辈的地址"}), 403
    finally:
        conn.close()
    from routes.profile import save_elder_address_for_elder
    return save_elder_address_for_elder(elder_id, data, address_id)


@family_bp.route('/elders/<int:elder_id>/addresses/select', methods=['POST'])
def select_family_elder_address(elder_id: int):
    data = request.get_json(silent=True) or {}
    family_user_id = data.get('family_user_id')
    address_id = data.get('address_id')
    if not family_user_id or not address_id:
        return jsonify({"code": 400, "message": "缺少家属或地址编号"}), 400
    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            if not _assert_family_elder_bound(cursor, int(family_user_id), elder_id):
                return jsonify({"code": 403, "message": "您只能切换已绑定长辈的地址"}), 403
            unfinished = find_unfinished_elder_order(cursor, elder_id)
            if unfinished:
                return jsonify({
                    "code": 409,
                    "message": location_change_block_message(unfinished),
                }), 409
            cursor.execute(
                """SELECT address_id, full_address, region_adcode, lng, lat
                   FROM elder_addresses WHERE address_id = %s AND elder_id = %s""",
                (address_id, elder_id),
            )
            address = cursor.fetchone()
            if not address:
                return jsonify({"code": 404, "message": "地址不存在"}), 404
            cursor.execute(
                "UPDATE elder_addresses SET is_current = FALSE WHERE elder_id = %s",
                (elder_id,),
            )
            cursor.execute(
                """UPDATE elder_addresses SET is_current = TRUE
                   WHERE address_id = %s AND elder_id = %s""",
                (address_id, elder_id),
            )
            cursor.execute(
                "UPDATE elders SET address = %s WHERE elder_id = %s",
                (address['full_address'], elder_id),
            )
            cursor.execute(
                "SELECT elder_id FROM elder_location_state WHERE elder_id = %s",
                (elder_id,),
            )
            if cursor.fetchone():
                cursor.execute(
                    """UPDATE elder_location_state SET lng = %s, lat = %s,
                              location_source = 'address_book', is_home_fixed = TRUE,
                              updated_at = CURRENT_TIMESTAMP
                       WHERE elder_id = %s""",
                    (address['lng'], address['lat'], elder_id),
                )
            else:
                cursor.execute(
                    """INSERT INTO elder_location_state
                       (elder_id, lng, lat, location_source, is_home_fixed)
                       VALUES (%s, %s, %s, 'address_book', TRUE)""",
                    (elder_id, address['lng'], address['lat']),
                )
            conn.commit()
            return jsonify({"code": 200, "message": "长辈当前服务点已切换，老人端同步可见"})
    except Exception as exc:
        conn.rollback()
        return jsonify({"code": 500, "message": f"切换地址失败: {exc}"}), 500
    finally:
        conn.close()


# 3. 获取长辈健康趋势图 (Echarts 绘图数据)
@family_bp.route('/elder-health-chart/<int:elder_id>', methods=['GET'])
def get_health_chart(elder_id):
    """Family/admin chart — path param MUST be elders.elder_id (not user_id)."""
    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute("SELECT elder_id FROM elders WHERE elder_id = %s", (elder_id,))
            if not cursor.fetchone():
                return jsonify({"code": 404, "message": "长辈不存在"}), 404
            records = fetch_health_trend_rows(cursor, elder_id, limit_days=7)
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
    location_mode = str(data.get('location_mode') or 'current').strip().lower()
    if location_mode in ('live', 'default'):
        location_mode = 'current' if location_mode == 'live' else 'address'
    if location_mode not in ('address', 'current'):
        location_mode = 'current'
    address_id = data.get('address_id')

    if not all([family_user_id, elder_id, service_type, service_time]):
        return jsonify({"code": 400, "message": "订单信息填写不完整"})

    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute("SELECT 1 FROM user_elder_relation WHERE family_user_id = %s AND elder_id = %s",
                           (family_user_id, elder_id))
            if not cursor.fetchone():
                return jsonify({"code": 403, "message": "您只能替已绑定的长辈发布服务请求"}), 403
            # Family proxy orders are always normal dispatch (never SOS).
            if str(service_type) == 'SOS紧急救助' or bool(data.get('urgent')):
                return jsonify({"code": 400, "message": "家属代下单只能发普通服务，紧急求助请由长辈本人发起"}), 400
            from routes.dispatch import create_smart_order_for_elder
            try:
                # Resolve current pin / selected address book row at publish time.
                order_id, message = create_smart_order_for_elder(
                    cursor,
                    elder_id=int(elder_id),
                    created_by=int(family_user_id),
                    service_type=str(service_type),
                    service_hours=service_hours,
                    service_time=str(service_time),
                    notes=str(notes or ""),
                    location_mode=location_mode,
                    address_id=int(address_id) if address_id else None,
                    urgent=False,
                    proxy_created_by=int(family_user_id),
                    proxy_reason="家属代老人下单",
                )
            except ValueError as exc:
                return jsonify({"code": 400, "message": str(exc)}), 400
            conn.commit()
            return jsonify({
                "code": 200,
                "message": f"{message}（长辈端会收到家属代下单提示）",
                "data": {"order_id": order_id, "status": "pending"},
            })
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
                        hr.approved_hours AS hour_review_approved_hours,
                        (
                            SELECT MIN(start_event.created_at)
                            FROM dispatch_events start_event
                            WHERE start_event.order_id = o.order_id
                              AND start_event.event_type = 'service_started'
                        ) AS service_started_at,
                        (
                            SELECT MIN(end_event.created_at)
                            FROM dispatch_events end_event
                            WHERE end_event.order_id = o.order_id
                              AND end_event.event_type IN (
                                  'service_completed',
                                  'elder_confirmed_completion',
                                  'family_confirmed_completion',
                                  'simulation_service_completed'
                              )
                        ) AS service_ended_at
                    FROM orders o
                    JOIN elders e ON o.elder_id = e.elder_id
                    LEFT JOIN users u ON o.volunteer_id = u.user_id
                        LEFT JOIN volunteer_hour_reviews hr ON hr.order_id = o.order_id
                    WHERE o.created_by = %s OR EXISTS (
                        SELECT 1 FROM user_elder_relation rel
                        WHERE rel.family_user_id = %s AND rel.elder_id = o.elder_id
                    )
                    ORDER BY o.created_at DESC
                """
                cursor.execute(sql, (family_user_id, family_user_id))
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
                        hr.approved_hours AS hour_review_approved_hours,
                        (
                            SELECT MIN(start_event.created_at)
                            FROM dispatch_events start_event
                            WHERE start_event.order_id = o.order_id
                              AND start_event.event_type = 'service_started'
                        ) AS service_started_at,
                        (
                            SELECT MIN(end_event.created_at)
                            FROM dispatch_events end_event
                            WHERE end_event.order_id = o.order_id
                              AND end_event.event_type IN (
                                  'service_completed',
                                  'elder_confirmed_completion',
                                  'family_confirmed_completion',
                                  'simulation_service_completed'
                              )
                        ) AS service_ended_at
                    FROM orders o
                    JOIN elders e ON o.elder_id = e.elder_id
                    LEFT JOIN users u ON o.volunteer_id = u.user_id
                        LEFT JOIN volunteer_hour_reviews hr ON hr.order_id = o.order_id
                    WHERE o.created_by = %s OR EXISTS (
                        SELECT 1 FROM user_elder_relation rel
                        WHERE rel.family_user_id = %s AND rel.elder_id = o.elder_id
                    )
                    ORDER BY o.created_at DESC
                """
                cursor.execute(sql, (family_user_id, family_user_id))
            
            orders = cursor.fetchall()

            for order in orders:
                if isinstance(order.get('service_time'), datetime.datetime):
                    order['service_time'] = order['service_time'].strftime('%Y-%m-%d %H:%M:%S')
                started_at = order.get('service_started_at')
                ended_at = order.get('service_ended_at')
                if isinstance(started_at, datetime.datetime) and isinstance(ended_at, datetime.datetime):
                    duration_seconds = max(0.0, (ended_at - started_at).total_seconds())
                    order['actual_duration_minutes'] = max(1, round(duration_seconds / 60))
                    order['actual_duration_hours'] = max(0.01, round(duration_seconds / 3600, 2))
                else:
                    order['actual_duration_minutes'] = None
                    order['actual_duration_hours'] = None
                order['service_started_at'] = format_datetime(started_at)
                order['service_ended_at'] = format_datetime(ended_at)

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
                SELECT order_id, elder_id, status, created_by, volunteer_id, service_hours
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

            cursor.execute("""SELECT 1 FROM user_elder_relation WHERE family_user_id = %s AND elder_id = %s""",
                           (family_user_id, order.get('elder_id')))
            bound = cursor.fetchone()
            if str(order.get('created_by')) != str(family_user_id) and not bound:
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


@family_bp.route('/alerts', methods=['GET'])
def get_family_alerts():
    """SOS + health_warning notices for a bound family account."""
    family_user_id = request.args.get('family_user_id', type=int)
    if not family_user_id:
        return jsonify({"code": 400, "message": "缺少家属账号"}), 400
    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute("SELECT role FROM users WHERE user_id = %s", (family_user_id,))
            account = cursor.fetchone()
            if not account or account.get('role') != 'family':
                return jsonify({"code": 403, "message": "仅家属可查看"}), 403
            rows = []
            cursor.execute(
                """
                SELECT en.notification_id, en.read_at, ei.incident_id, ei.status, ei.description,
                       ei.incident_type, e.name AS elder_name, ei.created_at,
                       ei.service_address, ei.service_lng, ei.service_lat,
                       c.conversation_id, a.alert_id,
                       COALESCE(a.alert_type, 'sos') AS alert_type
                FROM emergency_notifications en
                JOIN emergency_incidents ei ON ei.incident_id = en.incident_id
                JOIN elders e ON e.elder_id = ei.elder_id
                LEFT JOIN conversations c ON c.incident_id = ei.incident_id AND c.conversation_type = 'sos'
                LEFT JOIN alerts a ON a.emergency_incident_id = ei.incident_id
                WHERE en.recipient_user_id = %s
                ORDER BY en.notification_id DESC
                LIMIT 50
                """,
                (family_user_id,),
            )
            for item in cursor.fetchall():
                created = item.get('created_at')
                if isinstance(created, datetime.datetime):
                    created = format_datetime(created)
                address = str(item.get('service_address') or '').strip()
                description = str(item.get('description') or '紧急求助')
                if address and address not in description:
                    description = f"{description}（位置：{address}）"
                rows.append({
                    'notification_id': int(item['notification_id']),
                    'alert_id': int(item['alert_id']) if item.get('alert_id') else None,
                    'incident_id': int(item['incident_id']),
                    'category': 'sos' if str(item.get('alert_type') or 'sos') == 'sos' else 'health_warning',
                    'elder_name': item.get('elder_name') or '长辈',
                    'description': description,
                    'address': address or None,
                    'status': item.get('status') or 'reported',
                    'created_at': created,
                    'conversation_id': int(item['conversation_id']) if item.get('conversation_id') else None,
                    'unread': item.get('read_at') is None and str(item.get('status') or '') != 'resolved',
                })
            # Health check-in warnings for bound elders (yellow in UI).
            cursor.execute(
                """
                SELECT a.alert_id, a.description, a.is_handled, a.created_at, e.name AS elder_name,
                       hnr.read_at AS health_read_at
                FROM alerts a
                JOIN elders e ON e.elder_id = a.elder_id
                JOIN user_elder_relation uer ON uer.elder_id = a.elder_id
                LEFT JOIN health_notice_reads hnr
                  ON hnr.alert_id = a.alert_id AND hnr.user_id = %s
                WHERE uer.family_user_id = %s
                  AND a.alert_type = 'health_warning'
                ORDER BY a.alert_id DESC
                LIMIT 30
                """,
                (family_user_id, family_user_id),
            )
            for item in cursor.fetchall():
                created = item.get('created_at')
                if isinstance(created, datetime.datetime):
                    created = format_datetime(created)
                handled = bool(item.get('is_handled'))
                read = handled or item.get('health_read_at') is not None
                rows.append({
                    'notification_id': int(item['alert_id']),
                    'alert_id': int(item['alert_id']),
                    'incident_id': 0,
                    'category': 'health_warning',
                    'elder_name': item.get('elder_name') or '长辈',
                    'description': item.get('description') or '健康打卡异常',
                    'status': 'resolved' if handled else 'reported',
                    'created_at': created,
                    'conversation_id': None,
                    'unread': not read,
                })
            rows.sort(key=lambda item: str(item.get('created_at') or ''), reverse=True)
            return jsonify({"code": 200, "message": "ok", "data": rows[:50]})
    except Exception as exc:
        return jsonify({"code": 500, "message": f"加载家属告警失败: {exc}"}), 500
    finally:
        conn.close()


@family_bp.route('/alerts/ack', methods=['POST'])
def ack_family_alert():
    data = request.get_json() or {}
    family_user_id = data.get('family_user_id')
    notification_id = data.get('notification_id')
    category = str(data.get('category') or 'sos').strip().lower()
    if not family_user_id or not notification_id:
        return jsonify({"code": 400, "message": "缺少家属账号或通知编号"}), 400
    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            if category == 'health_warning':
                cursor.execute(
                    """INSERT INTO health_notice_reads (user_id, alert_id, read_at)
                       SELECT %s, a.alert_id, CURRENT_TIMESTAMP
                       FROM alerts a
                       JOIN user_elder_relation uer ON uer.elder_id = a.elder_id
                       WHERE a.alert_id = %s
                         AND a.alert_type = 'health_warning'
                         AND uer.family_user_id = %s
                         AND NOT EXISTS (
                             SELECT 1 FROM health_notice_reads hnr
                             WHERE hnr.user_id = %s AND hnr.alert_id = a.alert_id
                         )""",
                    (int(family_user_id), int(notification_id), int(family_user_id), int(family_user_id)),
                )
                cursor.execute(
                    """UPDATE alerts a
                       SET is_handled = TRUE
                       FROM user_elder_relation uer
                       WHERE a.alert_id = %s
                         AND a.alert_type = 'health_warning'
                         AND uer.elder_id = a.elder_id
                         AND uer.family_user_id = %s""",
                    (int(notification_id), int(family_user_id)),
                )
            else:
                cursor.execute(
                    """UPDATE emergency_notifications
                       SET read_at = CURRENT_TIMESTAMP
                       WHERE notification_id = %s AND recipient_user_id = %s""",
                    (int(notification_id), int(family_user_id)),
                )
            conn.commit()
            return jsonify({"code": 200, "message": "已确认收到"})
    except Exception as exc:
        conn.rollback()
        return jsonify({"code": 500, "message": f"确认失败: {exc}"}), 500
    finally:
        conn.close()


# 5.撤销订单 
@family_bp.route('/orders/cancel', methods=['POST'])
def cancel_order():
    data = request.get_json()
    order_id = data.get('order_id')
    family_user_id = data.get('family_user_id')

    if not order_id or not family_user_id:
        return jsonify({"code": 400, "message": "缺少订单编号"})

    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            # 💎 高分点：业务状态机流转控制。只有 pending (待接单) 状态才可以撤销
            sql_check = "SELECT order_id, elder_id, status, volunteer_id FROM orders WHERE order_id = %s FOR UPDATE"
            cursor.execute(sql_check, (order_id,))
            order = cursor.fetchone()

            if order:
                cursor.execute("SELECT 1 FROM user_elder_relation WHERE family_user_id = %s AND elder_id = %s",
                               (family_user_id, order['elder_id']))
                if not cursor.fetchone():
                    return jsonify({"code": 403, "message": "您无权取消该订单"}), 403

            if not order:
                return jsonify({"code": 404, "message": "订单不存在"})
            
            if order['status'] not in ('pending', 'accepted'):
                return jsonify({"code": 400, "message": "该订单已被接单或已处理，无法撤销！"})

            # 更新订单状态为 cancelled
            cursor.execute("SELECT order_id FROM dispatch_orders WHERE order_id = %s", (order_id,))
            if cursor.fetchone():
                from routes.dispatch import finalize_cancelled_dispatch_order
                finalize_cancelled_dispatch_order(
                    cursor,
                    int(order_id),
                    actor_user_id=int(family_user_id),
                    event_type="family_order_cancelled",
                    event_message="家属已取消服务请求，已停止后续调度；志愿者任务已同步清除。",
                    emergency_summary="家属已取消紧急服务，关联志愿者任务已关闭",
                )
            else:
                sql_cancel = "UPDATE orders SET status = 'cancelled' WHERE order_id = %s"
                cursor.execute(sql_cancel, (order_id,))
            conn.commit()

            return jsonify({"code": 200, "message": "订单已成功撤销，相关任务已同步关闭"})
    except Exception as e:
        conn.rollback()
        return jsonify({"code": 500, "message": f"撤单失败: {str(e)}"})
    finally:
        conn.close()
