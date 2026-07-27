import datetime
from collections import Counter

from flask import Blueprint, jsonify, request
from db import get_db_connection
from skills.weekly_report import load_random_template

report_bp = Blueprint('report', __name__)


def _ensure_weekly_reports_schema(cursor):
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS weekly_reports (
            report_id SERIAL PRIMARY KEY,
            elder_id INT NOT NULL,
            week_start DATE NOT NULL,
            week_end DATE NOT NULL,
            template_name VARCHAR(100),
            content TEXT NOT NULL,
            generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (elder_id) REFERENCES elders(elder_id) ON DELETE CASCADE
        )
        """
    )


def _elder_profile_by_user_id(cursor, user_id):
    cursor.execute(
        "SELECT elder_id, name, age, medical_history, personality_bio, address FROM elders WHERE user_id = %s",
        (user_id,),
    )
    return cursor.fetchone()


def _week_bounds():
    today = datetime.date.today()
    return today - datetime.timedelta(days=6), today


def _aggregate_health_data(cursor, elder_id):
    monday, _ = _week_bounds()
    cursor.execute(
        """
        SELECT record_date, blood_pressure_sys, blood_pressure_dia,
               heart_rate, blood_oxygen, blood_sugar, temperature, weight
        FROM health_records
        WHERE elder_id = %s AND record_date >= %s
        ORDER BY record_date ASC
        """,
        (int(elder_id), monday),
    )
    records = cursor.fetchall() or []
    result = {
        'days_count': len(records),
        'dates': [],
        'systolic': [],
        'diastolic': [],
        'heart_rate': [],
        'blood_oxygen': [],
        'blood_sugar': [],
        'temperature': [],
        'weight': [],
    }
    for row in records:
        rd = row['record_date']
        if isinstance(rd, datetime.date):
            rd = rd.strftime('%Y-%m-%d')
        result['dates'].append(str(rd))
        result['systolic'].append(row.get('blood_pressure_sys'))
        result['diastolic'].append(row.get('blood_pressure_dia'))
        result['heart_rate'].append(row.get('heart_rate'))
        result['blood_oxygen'].append(row.get('blood_oxygen'))
        result['blood_sugar'].append(row.get('blood_sugar'))
        result['temperature'].append(row.get('temperature'))
        result['weight'].append(row.get('weight'))
    return result


def _trend_label(values):
    """Compare first and last non-null values to determine trend."""
    filtered = [v for v in values if v is not None]
    if len(filtered) < 2:
        return '无足够数据'
    first = float(filtered[0])
    last = float(filtered[-1])
    diff = abs(last - first)
    if diff < 2:
        return '平稳'
    return '上升' if last > first else '下降'


def _safe_avg(values):
    filtered = [float(v) for v in values if v is not None]
    if not filtered:
        return None
    return round(sum(filtered) / len(filtered), 1)


def _format_health_stats_for_prompt(health):
    def _status_bp(sys_val, dia_val):
        if sys_val is None or dia_val is None:
            return ''
        s, d = float(sys_val), float(dia_val)
        if s >= 140 or d >= 90:
            return '【需关注：偏高】'
        if s <= 90 or d <= 60:
            return '【需关注：偏低】'
        return '【正常】'

    def _status_bs(val):
        if val is None:
            return ''
        v = float(val)
        if v >= 7.0:
            return '【需关注：偏高】'
        if v <= 3.9:
            return '【需关注：偏低】'
        return '【正常】'

    def _status_spo2(val):
        if val is None:
            return ''
        if float(val) < 95:
            return '【需关注：偏低】'
        return '【正常】'

    def _status_temp(val):
        if val is None:
            return ''
        if float(val) >= 37.3:
            return '【需关注：发热】'
        return '【正常】'

    lines = []
    lines.append(f'本周健康打卡 {health["days_count"]} 天')
    lines.append('')

    systolic = health['systolic']
    diastolic = health['diastolic']
    if systolic and diastolic:
        avg_sys = _safe_avg(systolic)
        avg_dia = _safe_avg(diastolic)
        trend = _trend_label(systolic)
        status = _status_bp(avg_sys, avg_dia)
        lines.append(f'- 血压：日均 {avg_sys}/{avg_dia} mmHg，趋势{trend} {status}')
        # find abnormal days
        for i, (s, d) in enumerate(zip(systolic, diastolic)):
            if s is not None and d is not None and (float(s) >= 140 or float(d) >= 90):
                lines.append(f'  ⚠ {health["dates"][i]}：{s}/{d} mmHg，超标')

    hr = health['heart_rate']
    if hr and any(v is not None for v in hr):
        avg_hr = _safe_avg(hr)
        hr_status = ''
        if avg_hr is not None:
            if avg_hr > 100:
                hr_status = '【需关注：偏快】'
            elif avg_hr < 60:
                hr_status = '【需关注：偏慢】'
            else:
                hr_status = '【正常】'
        lines.append(f'- 心率：日均 {avg_hr} 次/分钟 {hr_status}')

    bo = health['blood_oxygen']
    if bo and any(v is not None for v in bo):
        avg_bo = _safe_avg(bo)
        lines.append(f'- 血氧：日均 {avg_bo}% {_status_spo2(avg_bo)}')
        for i, v in enumerate(bo):
            if v is not None and float(v) < 95:
                lines.append(f'  ⚠ {health["dates"][i]}：血氧 {v}%，偏低')

    bs = health['blood_sugar']
    if bs and any(v is not None for v in bs):
        avg_bs = _safe_avg(bs)
        lines.append(f'- 血糖：日均 {avg_bs} mmol/L，趋势{_trend_label(bs)} {_status_bs(avg_bs)}')
        for i, v in enumerate(bs):
            if v is not None and (float(v) >= 7.0 or float(v) <= 3.9):
                lines.append(f'  ⚠ {health["dates"][i]}：血糖 {v} mmol/L')

    temp = health['temperature']
    if temp and any(v is not None for v in temp):
        avg_temp = _safe_avg(temp)
        lines.append(f'- 体温：日均 {avg_temp}℃ {_status_temp(avg_temp)}')
        for i, v in enumerate(temp):
            if v is not None and float(v) >= 37.3:
                lines.append(f'  ⚠ {health["dates"][i]}：体温 {v}℃，发热')

    wt = health['weight']
    if wt and any(v is not None for v in wt):
        lines.append(f'- 体重：日均 {_safe_avg(wt)} kg，趋势{_trend_label(wt)} 【正常波动】')

    for i, d in enumerate(health['dates']):
        parts = [f'    {d}: 血压{systolic[i]}/{diastolic[i] if diastolic[i] else "?"}']
        if health['heart_rate'][i]:
            parts.append(f'心率{health["heart_rate"][i]}')
        if health['blood_oxygen'][i]:
            parts.append(f'血氧{health["blood_oxygen"][i]}%')
        if health['blood_sugar'][i]:
            parts.append(f'血糖{health["blood_sugar"][i]}')
        lines.append('，'.join(parts))
    return '\n'.join(lines)


def _aggregate_service_data(cursor, elder_id):
    monday, _ = _week_bounds()
    cursor.execute(
        """
        SELECT o.service_type, o.service_time, o.service_hours, o.status,
               EXTRACT(HOUR FROM o.service_time) AS hour_of_day
        FROM orders o
        WHERE o.elder_id = %s AND o.created_at >= %s::timestamp
        ORDER BY o.created_at ASC
        """,
        (int(elder_id), monday),
    )
    records = cursor.fetchall() or []
    total_count = len(records)
    completed = sum(1 for r in records if r['status'] == 'completed')
    cancelled = sum(1 for r in records if r['status'] == 'cancelled')
    total_hours = sum(float(r['service_hours'] or 0) for r in records)

    time_slots = Counter()
    for r in records:
        h = int(r['hour_of_day'] or 0)
        if 6 <= h < 9:
            time_slots['清晨(6-9点)'] += 1
        elif 9 <= h < 12:
            time_slots['上午(9-12点)'] += 1
        elif 12 <= h < 18:
            time_slots['下午(12-18点)'] += 1
        elif 18 <= h < 22:
            time_slots['晚上(18-22点)'] += 1
        else:
            time_slots['深夜(22-6点)'] += 1

    service_types = Counter(r['service_type'] for r in records)
    return {
        'total_count': total_count,
        'completed': completed,
        'cancelled': cancelled,
        'total_hours': round(total_hours, 1),
        'time_slots': dict(time_slots),
        'service_types': dict(service_types),
    }


def _format_service_stats_for_prompt(service):
    lines = []
    lines.append(f'本周共 {service["total_count"]} 次服务请求')
    lines.append(f'- 已完成：{service["completed"]} 次，已取消：{service["cancelled"]} 次')
    lines.append(f'- 累计服务时长：{service["total_hours"]} 小时')
    if service['time_slots']:
        lines.append('- 时段分布：' + '、'.join(f'{k} {v}次' for k, v in service['time_slots'].items()))
    if service['service_types']:
        lines.append('- 服务类型：' + '、'.join(f'{k} {v}次' for k, v in service['service_types'].items()))
    return '\n'.join(lines)


def _build_messages(template_content, elder, health_stats_text, service_stats_text):
    system_prompt = (
        '你是一个周报生成助手。下面有一篇参考周报，你需要参考它的写作风格、语气口吻和章节结构，'
        '但根据当前老人的真实数据重新撰写周报内容。\n\n'
        '── 参考周报（仅供学习风格和结构）──\n'
        f'{template_content}\n'
        '────────────────\n\n'
        '重要规则：\n'
        '1. 学习参考周报的语气风格、章节标题结构、行文节奏，但不要照抄任何模板中的具体文字\n'
        '2. 所有健康结论和关爱提醒必须严格基于当前老人真实数据中的【需关注】标记\n'
        '3. 标记为【正常】的指标，不要提醒、不要警告、也不要建议改善，只需肯定和鼓励\n'
        '4. 标记为【需关注】的指标，针对具体问题给出具体建议，不能泛泛而谈\n'
        '5. 如果所有指标都正常，关爱提醒可以改为生活小贴士（如季节保养、运动建议等），不要生造不存在的问题\n'
        '6. 称呼老人时使用真实"姓名"，不要在姓名后面加"爷爷""奶奶"等后缀——姓名本身已包含称谓\n'
        '7. 不要编造数据中不存在的内容'
    )

    name = str(elder.get('name') or '长者')
    age = elder.get('age')
    medical_history = str(elder.get('medical_history') or '').strip() or '无'
    personality_bio = str(elder.get('personality_bio') or '').strip()

    fragments = [f'姓名：{name}']
    if age:
        fragments.append(f'年龄：{age} 岁')
    fragments.append(f'健康背景：{medical_history}')
    if personality_bio:
        fragments.append(f'性格简介：{personality_bio}')

    user_prompt = (
        '以下是当前老人信息和数据：\n\n'
        + '\n'.join(fragments)
        + '\n\n近7天健康数据：\n'
        + health_stats_text
        + '\n\n近7天服务记录：\n'
        + service_stats_text
        + '\n\n请生成周报。'
    )

    return [
        {'role': 'system', 'content': system_prompt},
        {'role': 'user', 'content': user_prompt},
    ]


def _check_eligibility(cursor, elder_id):
    monday, _ = _week_bounds()
    cursor.execute(
        """
        SELECT COUNT(DISTINCT record_date) AS days_count
        FROM health_records
        WHERE elder_id = %s AND record_date >= %s
        """,
        (int(elder_id), monday),
    )
    row = cursor.fetchone()
    return int(row['days_count']) if row else 0


def _trim_reports(cursor, elder_id, max_count=10):
    cursor.execute(
        "SELECT report_id FROM weekly_reports WHERE elder_id = %s ORDER BY generated_at ASC",
        (int(elder_id),),
    )
    existing = cursor.fetchall()
    if len(existing) >= max_count:
        to_delete = existing[:len(existing) - max_count + 1]
        for row in to_delete:
            cursor.execute("DELETE FROM weekly_reports WHERE report_id = %s", (row['report_id'],))


@report_bp.route('/weekly-report/eligibility', methods=['GET'])
def check_weekly_report_eligibility():
    user_id = request.args.get('user_id', type=int)
    if not user_id:
        return jsonify({'code': 400, 'message': '缺少 user_id'}), 400

    conn = get_db_connection()
    if not conn:
        return jsonify({'code': 500, 'message': '数据库连接失败'}), 500
    try:
        with conn.cursor() as cursor:
            elder = _elder_profile_by_user_id(cursor, user_id)
            if not elder:
                return jsonify({'code': 404, 'message': '找不到老人档案'}), 404
            elder_id = int(elder['elder_id'])
            days_count = _check_eligibility(cursor, elder_id)
            monday, sunday = _week_bounds()
            return jsonify({
                'code': 200,
                'message': '查询成功',
                'data': {
                    'eligible': days_count >= 7,
                    'daysWithData': days_count,
                    'weekStart': monday.strftime('%Y-%m-%d'),
                    'weekEnd': sunday.strftime('%Y-%m-%d'),
                },
            })
    finally:
        conn.close()


@report_bp.route('/weekly-report', methods=['POST'])
def generate_weekly_report():
    data = request.get_json(silent=True) or {}
    user_id = data.get('user_id')
    if not user_id:
        return jsonify({'code': 400, 'message': '缺少 user_id'}), 400

    conn = get_db_connection()
    if not conn:
        return jsonify({'code': 500, 'message': '数据库连接失败'}), 500
    try:
        with conn.cursor() as cursor:
            _ensure_weekly_reports_schema(cursor)

            elder = _elder_profile_by_user_id(cursor, user_id)
            if not elder:
                return jsonify({'code': 404, 'message': '找不到老人档案'}), 404
            elder_id = int(elder['elder_id'])

            monday, sunday = _week_bounds()

            days_count = _check_eligibility(cursor, elder_id)
            if days_count < 7:
                return jsonify({
                    'code': 400,
                    'message': f'近7天仅有 {days_count} 天健康打卡记录，需至少完成 7 天打卡才能生成周报。请坚持每日打卡！',
                }), 400

            health = _aggregate_health_data(cursor, elder_id)
            service = _aggregate_service_data(cursor, elder_id)
            health_text = _format_health_stats_for_prompt(health)
            service_text = _format_service_stats_for_prompt(service)

            template_name, template_content = load_random_template()
            messages = _build_messages(template_content, elder, health_text, service_text)

            from routes.ai import (
                _load_settings,
                _groq_request,
                _openai_compatible_request,
                DEFAULT_AI_SETTINGS,
            )

            settings = _load_settings(cursor)

            chat_payload = {
                'messages': messages,
                'temperature': 0.7,
                'max_tokens': 4096,
            }

            report_api_key = str(settings.get('report_api_key') or '').strip()
            report_base_url = str(settings.get('report_api_base_url') or '').strip()
            report_model = str(settings.get('report_model_name') or '').strip()

            if not (report_api_key and report_base_url and report_model):
                return jsonify({
                    'code': 400,
                    'message': '智能周报模型尚未配置，请联系总管理员在"AI模型配置"页面配置后再试。',
                }), 400

            chat_payload['model'] = report_model
            response_data = _openai_compatible_request(report_api_key, report_base_url, chat_payload)

            report_content = ''
            try:
                report_content = str(response_data['choices'][0]['message']['content']).strip()
            except Exception:
                report_content = ''
            if not report_content:
                return jsonify({'code': 502, 'message': 'AI 未返回有效报告内容'}), 502

            _trim_reports(cursor, elder_id, max_count=10)
            cursor.execute(
                """
                INSERT INTO weekly_reports (elder_id, week_start, week_end, template_name, content)
                VALUES (%s, %s, %s, %s, %s)
                RETURNING report_id
                """,
                (elder_id, monday, sunday, template_name, report_content),
            )
            report_id = int(cursor.fetchone()['report_id'])
            conn.commit()

            return jsonify({
                'code': 200,
                'message': '周报生成成功',
                'data': {
                    'reportId': report_id,
                    'content': report_content,
                    'weekStart': monday.strftime('%Y-%m-%d'),
                    'weekEnd': sunday.strftime('%Y-%m-%d'),
                    'templateName': template_name,
                    'generatedAt': datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
                },
            })
    except Exception as exc:
        conn.rollback()
        return jsonify({'code': 500, 'message': f'生成周报失败: {exc}'}), 500
    finally:
        conn.close()


@report_bp.route('/weekly-report/history', methods=['GET'])
def get_weekly_report_history():
    user_id = request.args.get('user_id', type=int)
    if not user_id:
        return jsonify({'code': 400, 'message': '缺少 user_id'}), 400

    conn = get_db_connection()
    if not conn:
        return jsonify({'code': 500, 'message': '数据库连接失败'}), 500
    try:
        with conn.cursor() as cursor:
            _ensure_weekly_reports_schema(cursor)
            elder = _elder_profile_by_user_id(cursor, user_id)
            if not elder:
                return jsonify({'code': 404, 'message': '找不到老人档案'}), 404
            elder_id = int(elder['elder_id'])

            cursor.execute(
                """
                SELECT report_id, week_start, week_end, template_name,
                       content, generated_at
                FROM weekly_reports
                WHERE elder_id = %s
                ORDER BY generated_at DESC
                LIMIT 10
                """,
                (elder_id,),
            )
            items = []
            for row in cursor.fetchall():
                week_start = row['week_start']
                week_end = row['week_end']
                if isinstance(week_start, datetime.date):
                    week_start = week_start.strftime('%Y-%m-%d')
                if isinstance(week_end, datetime.date):
                    week_end = week_end.strftime('%Y-%m-%d')
                generated_at = row['generated_at']
                items.append({
                    'reportId': int(row['report_id']),
                    'weekStart': str(week_start) if week_start else '',
                    'weekEnd': str(week_end) if week_end else '',
                    'templateName': str(row.get('template_name') or ''),
                    'content': str(row.get('content') or ''),
                    'generatedAt': generated_at.strftime('%Y-%m-%d %H:%M:%S') if isinstance(generated_at, datetime.datetime) else str(generated_at),
                })
            return jsonify({
                'code': 200,
                'message': '查询成功',
                'data': {
                    'items': items,
                    'total': len(items),
                },
            })
    finally:
        conn.close()


@report_bp.route('/weekly-report/<int:report_id>', methods=['DELETE'])
def delete_weekly_report(report_id):
    user_id = request.args.get('user_id', type=int)
    if not user_id:
        return jsonify({'code': 400, 'message': '缺少 user_id'}), 400

    conn = get_db_connection()
    if not conn:
        return jsonify({'code': 500, 'message': '数据库连接失败'}), 500
    try:
        with conn.cursor() as cursor:
            elder = _elder_profile_by_user_id(cursor, user_id)
            if not elder:
                return jsonify({'code': 404, 'message': '找不到老人档案'}), 404

            cursor.execute("DELETE FROM weekly_reports WHERE report_id = %s", (report_id,))
            conn.commit()
            return jsonify({'code': 200, 'message': '已删除'})
    except Exception as exc:
        conn.rollback()
        return jsonify({'code': 500, 'message': f'删除失败: {exc}'}), 500
    finally:
        conn.close()
