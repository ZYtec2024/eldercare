"""Administrative region helpers: AMap official district polygons + DB catalog.

Dispatch isolation keys off adcode. Point-in-region uses official polygons when
available, falling back to rectangular bounds for demo seed rows.
"""

from __future__ import annotations

import json
import os
import threading
import urllib.parse
import urllib.request
from typing import Any

from db import get_db_connection

AMAP_DISTRICT_URL = "https://restapi.amap.com/v3/config/district"
AMAP_GEOCODE_URL = "https://restapi.amap.com/v3/geocode/geo"
AMAP_REGEOCODE_URL = "https://restapi.amap.com/v3/geocode/regeo"
AMAP_INPUT_TIPS_URL = "https://restapi.amap.com/v3/assistant/inputtips"
AMAP_POI_TEXT_URL = "https://restapi.amap.com/v3/place/text"

# GB/T 2260 style province prefixes used when AMap omits parent names.
PROVINCE_BY_PREFIX = {
    "11": "北京市", "12": "天津市", "13": "河北省", "14": "山西省", "15": "内蒙古自治区",
    "21": "辽宁省", "22": "吉林省", "23": "黑龙江省",
    "31": "上海市", "32": "江苏省", "33": "浙江省", "34": "安徽省", "35": "福建省",
    "36": "江西省", "37": "山东省",
    "41": "河南省", "42": "湖北省", "43": "湖南省", "44": "广东省", "45": "广西壮族自治区",
    "46": "海南省",
    "50": "重庆市", "51": "四川省", "52": "贵州省", "53": "云南省", "54": "西藏自治区",
    "61": "陕西省", "62": "甘肃省", "63": "青海省", "64": "宁夏回族自治区", "65": "新疆维吾尔自治区",
}
MUNICIPALITY_PREFIXES = {"11", "12", "31", "50"}


def infer_province_city(adcode: str, district_name: str = "") -> tuple[str, str]:
    """Infer province/city for a district adcode (esp. 直辖市)."""
    code = str(adcode or "").strip()
    if len(code) < 2:
        return "", ""
    prefix = code[:2]
    province = PROVINCE_BY_PREFIX.get(prefix, "")
    if prefix in MUNICIPALITY_PREFIXES:
        # In municipalities the "city" layer is the same as the province.
        return province, province
    return province, ""


def fetch_district_detail(adcode_or_keyword: str) -> dict[str, Any]:
    payload = _amap_get({
        "keywords": adcode_or_keyword,
        "subdistrict": 0,
        "extensions": "all",
    })
    districts = payload.get("districts") or []
    if not districts:
        raise RuntimeError("未找到该行政区")
    chosen = None
    for item in districts:
        if str(item.get("adcode")) == str(adcode_or_keyword):
            chosen = item
            break
    chosen = chosen or districts[0]
    level = str(chosen.get("level") or "")
    polygons = parse_amap_polyline(chosen.get("polyline"))
    center_lng, center_lat = None, None
    center = chosen.get("center") or ""
    if isinstance(center, str) and "," in center:
        try:
            center_lng, center_lat = [float(x) for x in center.split(",")[:2]]
        except ValueError:
            center_lng = center_lat = None
    bounds = bounds_from_polygons(polygons)
    if not bounds and center_lng is not None and center_lat is not None:
        bounds = {
            "west": center_lng - 0.05,
            "east": center_lng + 0.05,
            "south": center_lat - 0.05,
            "north": center_lat + 0.05,
        }
    if not bounds:
        raise RuntimeError("该行政区未返回可用边界，请换一个区县或检查 Key 权限")
    if center_lng is None:
        center_lng, center_lat = center_from_bounds(bounds)
    name = str(chosen.get("name") or "")
    adcode = str(chosen.get("adcode") or adcode_or_keyword)
    province_name, city_name = infer_province_city(adcode, name)
    # Prefer any parent names AMap may include; otherwise keep inference.
    city_name = str(chosen.get("city") or chosen.get("cityname") or city_name or "")
    province_name = str(chosen.get("province") or chosen.get("pname") or province_name or "")
    if not province_name or not city_name or city_name == name:
        inferred_province, inferred_city = infer_province_city(adcode, name)
        province_name = province_name or inferred_province
        if not city_name or city_name == name:
            city_name = inferred_city or city_name
    return {
        "adcode": adcode,
        "name": name,
        "level": level or "district",
        "city_name": city_name or name,
        "province_name": province_name,
        "polygons": polygons,
        "bounds": bounds,
        "center": (round(center_lng, 6), round(center_lat, 6)),
    }


_catalog_lock = threading.RLock()
_ACTIVE_CATALOG: dict[str, dict[str, Any]] = {}


def amap_web_key() -> str:
    return (
        os.getenv("AMAP_WEB_KEY")
        or os.getenv("VITE_AMAP_KEY")
        or ""
    ).strip()


def _amap_get(params: dict[str, Any]) -> dict[str, Any]:
    key = amap_web_key()
    if not key:
        raise RuntimeError("未配置高德 Web Key（AMAP_WEB_KEY 或与前端相同的 VITE_AMAP_KEY）")
    query = urllib.parse.urlencode({**params, "key": key})
    req = urllib.request.Request(f"{AMAP_DISTRICT_URL}?{query}", method="GET")
    with urllib.request.urlopen(req, timeout=20) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    if str(payload.get("status")) != "1":
        raise RuntimeError(payload.get("info") or "高德行政区查询失败")
    return payload


def geocode_address(address: str, city: str | None = None) -> dict[str, Any]:
    """Resolve a real address with AMap and return its district + coordinates."""
    key = amap_web_key()
    if not key:
        raise RuntimeError("未配置高德 Web Key，暂时无法核验真实地址")
    params: dict[str, Any] = {"key": key, "address": str(address or "").strip()}
    if city:
        params["city"] = str(city).strip()
    query = urllib.parse.urlencode(params)
    req = urllib.request.Request(f"{AMAP_GEOCODE_URL}?{query}", method="GET")
    with urllib.request.urlopen(req, timeout=20) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    if str(payload.get("status")) != "1":
        raise RuntimeError(payload.get("info") or "高德地址解析失败")
    geocodes = payload.get("geocodes") or []
    if not geocodes:
        raise RuntimeError("未找到该地址，请填写可在高德地图检索到的小区、道路或建筑物")
    item = geocodes[0]
    location = str(item.get("location") or "")
    if "," not in location:
        raise RuntimeError("地址缺少可用坐标，请换一个更具体的门牌或建筑物")
    try:
        lng, lat = [float(value) for value in location.split(",", 1)]
    except ValueError as exc:
        raise RuntimeError("地址坐标格式无效") from exc
    return {
        "formatted_address": str(item.get("formatted_address") or address),
        "province_name": str(item.get("province") or ""),
        "city_name": str(item.get("city") or ""),
        "district_name": str(item.get("district") or ""),
        "adcode": str(item.get("adcode") or ""),
        "lng": round(lng, 6),
        "lat": round(lat, 6),
    }


def _amap_service_get(url: str, params: dict[str, Any]) -> dict[str, Any]:
    key = amap_web_key()
    if not key:
        raise RuntimeError("未配置高德 Web Key")
    query = urllib.parse.urlencode({**params, "key": key})
    req = urllib.request.Request(f"{url}?{query}", method="GET")
    with urllib.request.urlopen(req, timeout=20) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    if str(payload.get("status")) != "1":
        raise RuntimeError(payload.get("info") or "高德地图服务调用失败")
    return payload


def _location_pair(raw: Any) -> tuple[float, float] | None:
    text = str(raw or "")
    if "," not in text:
        return None
    try:
        lng, lat = [float(value) for value in text.split(",", 1)]
    except ValueError:
        return None
    return round(lng, 6), round(lat, 6)


def reverse_geocode(lng: Any, lat: Any) -> dict[str, Any]:
    """Resolve browser/GPS coordinates into a district-validated address."""
    try:
        point_lng, point_lat = float(lng), float(lat)
    except (TypeError, ValueError) as exc:
        raise RuntimeError("实时位置坐标无效") from exc
    payload = _amap_service_get(AMAP_REGEOCODE_URL, {
        "location": f"{point_lng:.6f},{point_lat:.6f}",
        "extensions": "base",
        "radius": 100,
    })
    regeocode = payload.get("regeocode") or {}
    component = regeocode.get("addressComponent") or {}
    return {
        "formatted_address": str(regeocode.get("formatted_address") or "实时位置"),
        "province_name": str(component.get("province") or ""),
        "city_name": str(component.get("city") or component.get("province") or ""),
        "district_name": str(component.get("district") or ""),
        "adcode": str(component.get("adcode") or ""),
        "lng": round(point_lng, 6),
        "lat": round(point_lat, 6),
    }


def search_address_pois(keywords: str, region_adcode: str) -> list[dict[str, Any]]:
    """Return selectable AMap POIs, including likely gates/buildings."""
    query = str(keywords or "").strip()
    adcode = str(region_adcode or "").strip()
    if len(query) < 2 or not adcode:
        return []

    raw_items: list[dict[str, Any]] = []
    tips_payload = _amap_service_get(AMAP_INPUT_TIPS_URL, {
        "keywords": query,
        "city": adcode,
        "citylimit": "true",
        "datatype": "all",
    })
    raw_items.extend(item for item in (tips_payload.get("tips") or []) if isinstance(item, dict))

    # A generic campus/community keyword often returns only the parent POI.
    # Search likely sub-POIs as well so “上海大学” can offer gates/buildings.
    expanded_queries = []
    if not any(token in query for token in ("门", "楼", "栋", "号")):
        expanded_queries = [f"{query} 门", f"{query} 楼"]
    for expanded in expanded_queries:
        payload = _amap_service_get(AMAP_POI_TEXT_URL, {
            "keywords": expanded,
            "city": adcode,
            "citylimit": "true",
            "children": 1,
            "offset": 10,
            "page": 1,
            "extensions": "base",
        })
        raw_items.extend(item for item in (payload.get("pois") or []) if isinstance(item, dict))

    results: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in raw_items:
        point = _location_pair(item.get("location"))
        item_adcode = str(item.get("adcode") or "")
        name = str(item.get("name") or "").strip()
        if not point or not name or (item_adcode and item_adcode != adcode):
            continue
        address_raw = item.get("address")
        if isinstance(address_raw, list):
            address = "".join(str(part) for part in address_raw)
        else:
            address = str(address_raw or "").strip()
        district = str(item.get("district") or item.get("adname") or "").strip()
        city = str(item.get("city") or item.get("cityname") or "").strip()
        province = str(item.get("province") or item.get("pname") or "").strip()
        identity = str(item.get("id") or f"{name}:{point[0]}:{point[1]}")
        if identity in seen:
            continue
        seen.add(identity)
        locality = "".join(part for part in (province, city, district) if part)
        full_address = f"{locality}{address}{name}" if address else f"{locality}{name}"
        results.append({
            "id": identity,
            "name": name,
            "address": address,
            "district_name": district,
            "adcode": item_adcode or adcode,
            "lng": point[0],
            "lat": point[1],
            "full_address": full_address,
            "display_name": f"{name} · {address or district or '地图地点'}",
        })
        if len(results) >= 20:
            break
    return results


def parse_amap_polyline(polyline: str | None) -> list[list[tuple[float, float]]]:
    if not polyline or not isinstance(polyline, str):
        return []
    polygons: list[list[tuple[float, float]]] = []
    for part in polyline.split("|"):
        ring: list[tuple[float, float]] = []
        for pair in part.split(";"):
            pair = pair.strip()
            if not pair or "," not in pair:
                continue
            lng_s, lat_s = pair.split(",", 1)
            try:
                ring.append((float(lng_s), float(lat_s)))
            except ValueError:
                continue
        if len(ring) >= 3:
            polygons.append(ring)
    return polygons


def bounds_from_polygons(polygons: list[list[tuple[float, float]]]) -> dict[str, float] | None:
    points = [pt for ring in polygons for pt in ring]
    if not points:
        return None
    lngs = [p[0] for p in points]
    lats = [p[1] for p in points]
    return {
        "west": min(lngs),
        "east": max(lngs),
        "south": min(lats),
        "north": max(lats),
    }


def center_from_bounds(bounds: dict[str, float]) -> tuple[float, float]:
    return (
        round((bounds["west"] + bounds["east"]) / 2, 6),
        round((bounds["south"] + bounds["north"]) / 2, 6),
    )


def point_in_ring(lng: float, lat: float, ring: list[tuple[float, float]]) -> bool:
    inside = False
    n = len(ring)
    if n < 3:
        return False
    j = n - 1
    for i in range(n):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (xi == lng and yi == lat) or (xj == lng and yj == lat):
            return True
        intersects = ((yi > lat) != (yj > lat)) and (
            lng < (xj - xi) * (lat - yi) / ((yj - yi) or 1e-16) + xi
        )
        if intersects:
            inside = not inside
        j = i
    return inside


def point_in_polygons(lng: float, lat: float, polygons: list[list[tuple[float, float]]]) -> bool:
    return any(point_in_ring(lng, lat, ring) for ring in polygons)


def point_in_bounds(lng: float, lat: float, bounds: dict[str, float]) -> bool:
    return bounds["west"] <= lng <= bounds["east"] and bounds["south"] <= lat <= bounds["north"]


def fetch_district_children(keywords: str, subdistrict: int = 1) -> list[dict[str, str]]:
    payload = _amap_get({
        "keywords": keywords,
        "subdistrict": subdistrict,
        "extensions": "base",
    })
    districts = payload.get("districts") or []
    if not districts:
        return []
    root = districts[0]
    children = root.get("districts") or []
    result = []
    for item in children:
        result.append({
            "adcode": str(item.get("adcode") or ""),
            "name": str(item.get("name") or ""),
            "level": str(item.get("level") or ""),
            "center": str(item.get("center") or ""),
        })
    return [row for row in result if row["adcode"]]


def ensure_region_columns(cursor: Any) -> None:
    defs = [
        ("polygon_json", "TEXT"),
        ("center_lng", "NUMERIC(10,6)"),
        ("center_lat", "NUMERIC(10,6)"),
        ("province_name", "VARCHAR(80)"),
    ]
    for column_name, definition in defs:
        cursor.execute(
            """SELECT column_name FROM information_schema.columns
               WHERE table_schema = current_schema()
                 AND table_name = 'administrative_regions' AND column_name = %s""",
            (column_name,),
        )
        if not cursor.fetchone():
            cursor.execute(f"ALTER TABLE administrative_regions ADD COLUMN {column_name} {definition}")


def upsert_region(
    cursor: Any,
    *,
    adcode: str,
    name: str,
    city_name: str,
    province_name: str,
    region_level: str,
    bounds: dict[str, float],
    center: tuple[float, float],
    polygons: list[list[tuple[float, float]]],
    active: bool = True,
) -> None:
    cursor.execute("SELECT adcode FROM administrative_regions WHERE adcode = %s", (adcode,))
    exists = bool(cursor.fetchone())
    polygon_json = json.dumps(polygons, ensure_ascii=False)
    bounds_json = json.dumps(bounds, ensure_ascii=False)
    if exists:
        cursor.execute(
            """UPDATE administrative_regions
               SET name = %s, city_name = %s, province_name = %s, region_level = %s,
                   bounds_json = %s, polygon_json = %s, center_lng = %s, center_lat = %s, active = %s
               WHERE adcode = %s""",
            (
                name, city_name, province_name or "", region_level or "district",
                bounds_json, polygon_json, center[0], center[1], active, adcode,
            ),
        )
    else:
        cursor.execute(
            """INSERT INTO administrative_regions
               (adcode, name, city_name, province_name, region_level, bounds_json, polygon_json, center_lng, center_lat, active)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
            (
                adcode, name, city_name, province_name or "", region_level or "district",
                bounds_json, polygon_json, center[0], center[1], active,
            ),
        )


def load_active_catalog(conn: Any | None = None) -> dict[str, dict[str, Any]]:
    owns = False
    if conn is None:
        conn = get_db_connection()
        owns = True
    if not conn:
        return {}
    try:
        with conn.cursor() as cursor:
            ensure_region_columns(cursor)
            cursor.execute(
                """SELECT adcode, name, city_name, province_name, region_level, bounds_json,
                          polygon_json, center_lng, center_lat
                   FROM administrative_regions WHERE active = TRUE ORDER BY adcode"""
            )
            catalog: dict[str, dict[str, Any]] = {}
            for row in cursor.fetchall():
                try:
                    bounds = json.loads(row["bounds_json"]) if row.get("bounds_json") else None
                except (TypeError, json.JSONDecodeError):
                    bounds = None
                polygons: list[list[tuple[float, float]]] = []
                if row.get("polygon_json"):
                    try:
                        raw = json.loads(row["polygon_json"])
                        polygons = [[(float(p[0]), float(p[1])) for p in ring] for ring in raw]
                    except (TypeError, ValueError, json.JSONDecodeError, IndexError):
                        polygons = []
                if not bounds:
                    bounds = bounds_from_polygons(polygons) or {
                        "west": 0, "east": 0, "south": 0, "north": 0,
                    }
                if row.get("center_lng") is not None and row.get("center_lat") is not None:
                    center = (float(row["center_lng"]), float(row["center_lat"]))
                else:
                    center = center_from_bounds(bounds)
                catalog[str(row["adcode"])] = {
                    "name": row["name"],
                    "city": row.get("city_name") or row["name"],
                    "province": row.get("province_name") or "",
                    "level": row.get("region_level") or "district",
                    "bounds": bounds,
                    "center": center,
                    "polygons": polygons,
                }
            return catalog
    finally:
        if owns and conn:
            conn.close()


def refresh_runtime_catalog(target: dict[str, dict[str, Any]], conn: Any | None = None) -> dict[str, dict[str, Any]]:
    loaded = load_active_catalog(conn)
    with _catalog_lock:
        target.clear()
        target.update(loaded)
        _ACTIVE_CATALOG.clear()
        _ACTIVE_CATALOG.update(loaded)
    return loaded


def resolve_region_adcode(lng: Any, lat: Any, catalog: dict[str, dict[str, Any]]) -> str | None:
    try:
        lng_value, lat_value = float(lng), float(lat)
    except (TypeError, ValueError):
        return None
    for adcode, region in catalog.items():
        polygons = region.get("polygons") or []
        if polygons and point_in_polygons(lng_value, lat_value, polygons):
            return adcode
    for adcode, region in catalog.items():
        bounds = region.get("bounds") or {}
        if bounds and point_in_bounds(lng_value, lat_value, bounds):
            return adcode
    return None


def enrich_missing_polygons(conn: Any, seed_adcodes: list[str] | None = None) -> None:
    if not amap_web_key():
        return
    with conn.cursor() as cursor:
        ensure_region_columns(cursor)
        if seed_adcodes:
            codes = tuple(str(code) for code in seed_adcodes)
            cursor.execute(
                f"""SELECT adcode, name FROM administrative_regions
                    WHERE adcode IN ({",".join(["%s"] * len(codes))})
                      AND (polygon_json IS NULL OR polygon_json = '' OR polygon_json = '[]')""",
                codes,
            )
        else:
            cursor.execute(
                """SELECT adcode, name FROM administrative_regions
                   WHERE polygon_json IS NULL OR polygon_json = '' OR polygon_json = '[]'"""
            )
        rows = cursor.fetchall()
        for row in rows:
            try:
                detail = fetch_district_detail(str(row["adcode"]))
                # Never wipe an existing province/city hierarchy with blank AMap fields.
                cursor.execute(
                    "SELECT province_name, city_name, name FROM administrative_regions WHERE adcode = %s",
                    (row["adcode"],),
                )
                existing = cursor.fetchone() or {}
                province = detail.get("province_name") or existing.get("province_name") or ""
                city = detail.get("city_name") or existing.get("city_name") or ""
                if not province or city == (detail.get("name") or existing.get("name")):
                    inferred_p, inferred_c = infer_province_city(str(row["adcode"]))
                    province = province or inferred_p
                    if not city or city == (detail.get("name") or existing.get("name")):
                        city = inferred_c or city
                upsert_region(
                    cursor,
                    adcode=detail["adcode"],
                    name=detail["name"] or row["name"],
                    city_name=city or detail["name"] or row["name"],
                    province_name=province,
                    region_level=detail.get("level") or "district",
                    bounds=detail["bounds"],
                    center=detail["center"],
                    polygons=detail["polygons"],
                    active=True,
                )
            except Exception as exc:  # noqa: BLE001
                print(f"⚠ 拉取行政区边界失败 {row.get('adcode')}: {exc}")
        conn.commit()


def admin_is_root(cursor: Any, admin_user_id: int) -> bool:
    cursor.execute(
        """SELECT 1 FROM admin_region_scope
           WHERE admin_user_id = %s AND region_adcode = '*'""",
        (admin_user_id,),
    )
    return bool(cursor.fetchone())


def is_active_region(adcode: str | None, catalog: dict[str, dict[str, Any]] | None = None) -> bool:
    """True when the district is opened (active) in the runtime catalog."""
    code = str(adcode or "").strip()
    if not code:
        return False
    source = catalog if catalog is not None else _ACTIVE_CATALOG
    return code in source
