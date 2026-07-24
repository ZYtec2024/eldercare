# routes/profile.py
from flask import Blueprint, request, jsonify
from db import get_db_connection
from utils import get_validated_data
from region_service import geocode_address, reverse_geocode, search_address_pois

profile_bp = Blueprint('profile', __name__)

# 1. 获取个人详细信息 (多表 JOIN 经典运用)
@profile_bp.route('/info', methods=['GET'])
def get_profile_info():
    user_id = request.args.get('user_id')
    role = request.args.get('role')

    if not user_id or not role:
        return jsonify({"code": 400, "message": "参数不完整"})

    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            # 基础信息 (所有人都有)
            sql_base = "SELECT real_name, phone, email, created_at FROM users WHERE user_id = %s"
            cursor.execute(sql_base, (user_id,))
            user_info = cursor.fetchone()

            if not user_info:
                return jsonify({"code": 404, "message": "用户不存在"})

            # 根据角色拉取额外的扩展信息
            if role == 'elder':
                sql_ext = "SELECT age, gender, address, medical_history, alert_sys_threshold FROM elders WHERE user_id = %s"
                cursor.execute(sql_ext, (user_id,))
                elder_ext = cursor.fetchone()
                if elder_ext:
                    user_info.update(elder_ext) # 将字典合并返回前端

            elif role == 'volunteer':
                sql_ext = "SELECT id_card, skills, total_hours, weekly_hours, awards, likes_count FROM volunteers_profile WHERE user_id = %s"
                cursor.execute(sql_ext, (user_id,))
                vol_ext = cursor.fetchone()
                if vol_ext:
                    user_info.update(vol_ext)

            return jsonify({"code": 200, "message": "获取成功", "data": user_info})
    finally:
        conn.close()


@profile_bp.route('/addresses', methods=['GET'])
def list_elder_addresses():
    user_id = request.args.get('user_id', type=int)
    if not user_id:
        return jsonify({"code": 400, "message": "缺少用户编号"}), 400
    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute("SELECT elder_id FROM elders WHERE user_id = %s", (user_id,))
            elder = cursor.fetchone()
            if not elder:
                return jsonify({"code": 403, "message": "仅老人账号可管理地址"}), 403
            cursor.execute(
                """SELECT address_id, label, province_name, city_name, district_name,
                          region_adcode, detail_address, full_address, is_current
                   FROM elder_addresses
                   WHERE elder_id = %s
                   ORDER BY is_current DESC, address_id DESC""",
                (elder['elder_id'],),
            )
            return jsonify({"code": 200, "message": "获取成功", "data": cursor.fetchall()})
    finally:
        conn.close()


@profile_bp.route('/address-suggestions', methods=['GET'])
def address_suggestions():
    keywords = str(request.args.get('keywords') or '').strip()
    region_adcode = str(request.args.get('region_adcode') or '').strip()
    if len(keywords) < 2 or not region_adcode:
        return jsonify({"code": 200, "message": "请输入至少两个字", "data": []})
    try:
        return jsonify({
            "code": 200,
            "message": "高德地点联想已更新",
            "data": search_address_pois(keywords, region_adcode),
        })
    except Exception as exc:
        return jsonify({"code": 502, "message": f"地点搜索失败：{exc}", "data": []}), 502


@profile_bp.route('/location/resolve', methods=['POST'])
def resolve_live_location():
    data = request.get_json(silent=True) or {}
    user_id = data.get('user_id')
    role = str(data.get('role') or '').strip()
    if not user_id or role not in ('elder', 'volunteer'):
        return jsonify({"code": 400, "message": "缺少用户或定位角色"}), 400
    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            if role == 'elder':
                cursor.execute("SELECT region_adcode FROM elders WHERE user_id = %s", (user_id,))
            else:
                cursor.execute(
                    "SELECT service_region_adcode AS region_adcode FROM volunteer_location_state WHERE volunteer_id = %s",
                    (user_id,),
                )
            account = cursor.fetchone()
            if not account:
                return jsonify({"code": 404, "message": "当前账号尚未配置服务区县"}), 404
            resolved = reverse_geocode(data.get('lng'), data.get('lat'))
            registered_region = str(account.get('region_adcode') or '')
            if str(resolved.get('adcode') or '') != registered_region:
                return jsonify({
                    "code": 400,
                    "message": f"当前定位在「{resolved.get('district_name') or resolved.get('adcode') or '其他区域'}」，不属于已配置服务区县",
                }), 400
            return jsonify({"code": 200, "message": "实时位置获取成功", "data": resolved})
    except Exception as exc:
        return jsonify({"code": 502, "message": f"实时位置解析失败：{exc}"}), 502
    finally:
        conn.close()


@profile_bp.route('/volunteer/location', methods=['POST'])
def update_volunteer_live_location():
    data = request.get_json(silent=True) or {}
    user_id = data.get('user_id')
    if not user_id:
        return jsonify({"code": 400, "message": "缺少志愿者账号"}), 400
    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute(
                """SELECT p.service_region_adcode, vp.audit_status
                   FROM volunteer_location_state p
                   JOIN users u ON u.user_id = p.volunteer_id AND u.role = 'volunteer'
                   JOIN volunteers_profile vp ON vp.user_id = p.volunteer_id
                   WHERE p.volunteer_id = %s""",
                (user_id,),
            )
            volunteer = cursor.fetchone()
            if not volunteer:
                return jsonify({"code": 404, "message": "志愿者服务区县尚未配置"}), 404
            resolved = reverse_geocode(data.get('lng'), data.get('lat'))
            if str(resolved.get('adcode') or '') != str(volunteer.get('service_region_adcode') or ''):
                return jsonify({
                    "code": 400,
                    "message": f"当前位置不在注册服务区县内，不能更新为接单位置",
                }), 400
            cursor.execute(
                """UPDATE volunteer_location_state
                   SET lng = %s, lat = %s, location_source = 'browser_live',
                       updated_at = CURRENT_TIMESTAMP
                   WHERE volunteer_id = %s""",
                (resolved['lng'], resolved['lat'], user_id),
            )
            conn.commit()
            return jsonify({
                "code": 200,
                "message": "实时位置已更新；正式联网后可直接复用此定位入口",
                "data": resolved,
            })
    except Exception as exc:
        conn.rollback()
        return jsonify({"code": 502, "message": f"更新实时位置失败：{exc}"}), 502
    finally:
        conn.close()


def _save_elder_address(data, address_id=None):
    user_id = data.get('user_id')
    province = str(data.get('province_name') or '').strip()
    city = str(data.get('city_name') or '').strip()
    district = str(data.get('district_name') or '').strip()
    adcode = str(data.get('region_adcode') or '').strip()
    detail = str(data.get('detail_address') or '').strip()
    supplement = str(data.get('address_supplement') or '').strip()
    label = str(data.get('label') or '家').strip()[:40] or '家'
    if not user_id or not all([province, city, district, adcode, detail]):
        return jsonify({"code": 400, "message": "请完整选择省、市、区县并填写详细地址"}), 400
    poi_lng = data.get('poi_lng')
    poi_lat = data.get('poi_lat')
    try:
        if poi_lng is not None and poi_lat is not None:
            resolved = reverse_geocode(poi_lng, poi_lat)
            poi_name = str(data.get('poi_name') or '').strip()
            poi_full_address = str(data.get('poi_full_address') or resolved['formatted_address']).strip()
            detail = f"{poi_name or detail}{supplement}"
            resolved['formatted_address'] = f"{poi_full_address}{supplement}"
        else:
            resolved = geocode_address(f"{province}{city}{district}{detail}", adcode)
    except Exception as exc:
        return jsonify({"code": 400, "message": f"地址核验失败：{exc}"}), 400
    if str(resolved.get('adcode') or '') != adcode:
        actual = resolved.get('district_name') or resolved.get('adcode') or '其他区县'
        return jsonify({
            "code": 400,
            "message": f"该地址定位在「{actual}」，不属于所选「{district}」",
        }), 400

    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute("SELECT elder_id FROM elders WHERE user_id = %s", (user_id,))
            elder = cursor.fetchone()
            if not elder:
                return jsonify({"code": 403, "message": "仅老人账号可管理地址"}), 403
            elder_id = int(elder['elder_id'])
            make_current = bool(data.get('is_current', True))

            current_address = None
            if address_id is not None:
                cursor.execute(
                    """SELECT address_id, is_current
                       FROM elder_addresses
                       WHERE address_id = %s AND elder_id = %s""",
                    (address_id, elder_id),
                )
                current_address = cursor.fetchone()
                if not current_address:
                    return jsonify({"code": 404, "message": "要编辑的地址不存在"}), 404
                # Editing the current home keeps it current unless explicitly
                # switched later through the dedicated address selector.
                make_current = bool(current_address.get('is_current'))

            if address_id is None:
                cursor.execute(
                    """SELECT address_id FROM elder_addresses
                       WHERE elder_id = %s AND full_address = %s""",
                    (elder_id, resolved['formatted_address']),
                )
            else:
                cursor.execute(
                    """SELECT address_id FROM elder_addresses
                       WHERE elder_id = %s AND full_address = %s AND address_id <> %s""",
                    (elder_id, resolved['formatted_address'], address_id),
                )
            duplicate = cursor.fetchone()
            if duplicate:
                return jsonify({"code": 409, "message": "该地址已存在，请直接编辑或设为当前地址"}), 409

            if make_current:
                cursor.execute("UPDATE elder_addresses SET is_current = FALSE WHERE elder_id = %s", (elder_id,))

            if address_id is None:
                cursor.execute(
                    """INSERT INTO elder_addresses
                       (elder_id, label, province_name, city_name, district_name, region_adcode,
                        detail_address, full_address, lng, lat, is_current)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                       RETURNING address_id""",
                    (
                        elder_id, label, province, city, district, adcode, detail,
                        resolved['formatted_address'], resolved['lng'], resolved['lat'], make_current,
                    ),
                )
                saved_address_id = int(cursor.fetchone()['address_id'])
            else:
                cursor.execute(
                    """UPDATE elder_addresses
                          SET label = %s, province_name = %s, city_name = %s,
                              district_name = %s, region_adcode = %s,
                              detail_address = %s, full_address = %s,
                              lng = %s, lat = %s, is_current = %s
                        WHERE address_id = %s AND elder_id = %s""",
                    (
                        label, province, city, district, adcode, detail,
                        resolved['formatted_address'], resolved['lng'], resolved['lat'],
                        make_current, address_id, elder_id,
                    ),
                )
                saved_address_id = int(address_id)

            if make_current:
                cursor.execute(
                    "UPDATE elders SET address = %s, region_adcode = %s WHERE elder_id = %s",
                    (resolved['formatted_address'], adcode, elder_id),
                )
                cursor.execute(
                    "SELECT elder_id FROM elder_location_state WHERE elder_id = %s",
                    (elder_id,),
                )
                if cursor.fetchone():
                    cursor.execute(
                        """UPDATE elder_location_state
                              SET lng = %s, lat = %s, location_source = 'amap_geocode',
                                  is_home_fixed = TRUE, updated_at = CURRENT_TIMESTAMP
                            WHERE elder_id = %s""",
                        (resolved['lng'], resolved['lat'], elder_id),
                    )
                else:
                    cursor.execute(
                        """INSERT INTO elder_location_state
                           (elder_id, lng, lat, location_source, is_home_fixed)
                           VALUES (%s, %s, %s, 'amap_geocode', TRUE)""",
                        (elder_id, resolved['lng'], resolved['lat']),
                    )
            conn.commit()
            return jsonify({
                "code": 200,
                "message": "地址已更新并通过高德地图核验" if address_id is not None else "地址已保存并通过高德地图核验",
                "data": {"address_id": saved_address_id},
            })
    except Exception as exc:
        conn.rollback()
        return jsonify({"code": 500, "message": f"保存地址失败：{exc}"}), 500
    finally:
        conn.close()


@profile_bp.route('/addresses', methods=['POST'])
def add_elder_address():
    return _save_elder_address(request.get_json(silent=True) or {})


@profile_bp.route('/addresses/<int:address_id>', methods=['PUT'])
def update_elder_address(address_id):
    return _save_elder_address(request.get_json(silent=True) or {}, address_id)


@profile_bp.route('/addresses/select', methods=['POST'])
def select_elder_address():
    data = request.get_json(silent=True) or {}
    user_id = data.get('user_id')
    address_id = data.get('address_id')
    if not user_id or not address_id:
        return jsonify({"code": 400, "message": "缺少用户或地址编号"}), 400
    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute("SELECT elder_id FROM elders WHERE user_id = %s", (user_id,))
            elder = cursor.fetchone()
            if not elder:
                return jsonify({"code": 403, "message": "仅老人账号可管理地址"}), 403
            elder_id = int(elder['elder_id'])
            cursor.execute(
                """SELECT address_id, full_address, region_adcode, lng, lat
                   FROM elder_addresses WHERE address_id = %s AND elder_id = %s""",
                (address_id, elder_id),
            )
            address = cursor.fetchone()
            if not address:
                return jsonify({"code": 404, "message": "地址不存在"}), 404
            # Keep the partial unique index valid throughout the transaction:
            # clear the old current row before enabling the new one.
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
                "UPDATE elders SET address = %s, region_adcode = %s WHERE elder_id = %s",
                (address['full_address'], address['region_adcode'], elder_id),
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
            return jsonify({"code": 200, "message": "当前地址已切换"})
    except Exception as exc:
        conn.rollback()
        return jsonify({"code": 500, "message": f"切换地址失败: {exc}"}), 500
    finally:
        conn.close()

# 2. 全局个人信息更新 (跨表级联更新事务)
@profile_bp.route('/update', methods=['POST'])
def update_profile():
    data = request.get_json()
    user_id = data.get('user_id')
    role = data.get('role')

    if not user_id or not role:
        return jsonify({"code": 400, "message": "缺失关键识别参数"})

    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            # ============ 💎 跨表更新事务开始 ============
            # 1. 更新 users 总表的通用字段 (手机号, 邮箱)
            phone = data.get('phone')
            email = data.get('email')
            if phone and email:
                sql_users = "UPDATE users SET phone = %s, email = %s WHERE user_id = %s"
                cursor.execute(sql_users, (phone, email, user_id))

            # 2. 角色特定表更新
            if role == 'elder':
                medical_history = data.get('medical_history')
                sys_threshold = data.get('alert_sys_threshold')
                if medical_history is not None:
                    sql_elder_history = "UPDATE elders SET medical_history = %s WHERE user_id = %s"
                    cursor.execute(sql_elder_history, (medical_history, user_id))

                if sys_threshold is not None:
                    sql_elder_threshold = "UPDATE elders SET alert_sys_threshold = %s WHERE user_id = %s"
                    cursor.execute(sql_elder_threshold, (sys_threshold, user_id))
            
            elif role == 'volunteer':
                skills = data.get('skills')
                if skills is not None:
                    sql_vol = "UPDATE volunteers_profile SET skills = %s WHERE user_id = %s"
                    cursor.execute(sql_vol, (skills, user_id))

            conn.commit()
            # ============ 事务结束 ============
            return jsonify({"code": 200, "message": "个人信息更新成功！"})
            
    except Exception as e:
        conn.rollback()
        return jsonify({"code": 500, "message": f"更新失败: {str(e)}"})
    finally:
        conn.close()
