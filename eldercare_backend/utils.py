# utils.py - 共享工具函数
import os
import datetime
import smtplib
from email.mime.text import MIMEText
from email.header import Header
from flask import jsonify


# ========== 响应格式化 ==========
def api_response(payload, status=200):
    """标准化 API 响应"""
    return jsonify(payload), status


def error_response(message, code=500):
    """快速返回错误"""
    return api_response({"code": code, "message": message}, code)


def fetch_health_trend_rows(cursor, elder_id: int, limit_days: int = 7) -> list[dict]:
    """Latest health points for one elder (one row per calendar day).

    Always keyed by elders.elder_id — never by users.user_id. Callers that only
    have a login user_id must resolve elder_id first (see elder health routes).
    """
    cursor.execute(
        """SELECT record_date, blood_pressure_sys, blood_pressure_dia,
                  heart_rate, blood_oxygen, blood_sugar, temperature, weight
           FROM health_records
           WHERE elder_id = %s
           ORDER BY record_date DESC, record_id DESC
           LIMIT %s""",
        (int(elder_id), max(int(limit_days) * 2, 14)),
    )
    records = cursor.fetchall() or []
    by_date: dict[str, dict] = {}
    for row in records:
        item = dict(row)
        record_date = item.get("record_date")
        if isinstance(record_date, datetime.date):
            item["record_date"] = record_date.strftime("%Y-%m-%d")
        key = str(item.get("record_date") or "")
        if key and key not in by_date:
            by_date[key] = item
        if len(by_date) >= int(limit_days):
            break
    return sorted(by_date.values(), key=lambda item: str(item.get("record_date") or ""))


# ========== 参数验证 ==========
def get_validated_data(data, required_fields):
    """验证必需字段并返回验证结果"""
    missing = [field for field in required_fields if not data.get(field)]
    if missing:
        return None, error_response(f"缺失字段: {', '.join(missing)}", 400)
    return data, None


# ========== 日期格式化 ==========
_BEIJING = datetime.timezone(datetime.timedelta(hours=8))


def _as_beijing(value):
    """Treat naive system timestamps as UTC, then convert to Asia/Beijing (UTC+8).

    openGauss in this stack runs with TimeZone=UTC, so CURRENT_TIMESTAMP written
    into TIMESTAMP columns stores UTC wall-clock digits without tzinfo. User-entered
    appointment times use format_wall_datetime instead (already Asia/Shanghai).
    """
    if not isinstance(value, datetime.datetime):
        return value
    if value.tzinfo is None:
        aware = value.replace(tzinfo=datetime.timezone.utc)
    else:
        aware = value.astimezone(datetime.timezone.utc)
    return aware.astimezone(_BEIJING)


def format_datetime(value, fmt='%Y-%m-%d %H:%M:%S'):
    """Format system timestamps (created_at / alerts) for the UI in Asia/Shanghai."""
    if isinstance(value, datetime.datetime):
        return _as_beijing(value).strftime(fmt)
    return value


def format_wall_datetime(value, fmt='%Y-%m-%d %H:%M:%S'):
    """Format a business wall-clock timestamp without applying UTC offset."""
    if isinstance(value, datetime.datetime):
        if value.tzinfo is not None:
            value = value.astimezone(_BEIJING).replace(tzinfo=None)
        return value.strftime(fmt)
    return value


def format_date(value):
    """格式化日期"""
    if isinstance(value, datetime.datetime):
        return _as_beijing(value).strftime('%Y-%m-%d')
    if isinstance(value, datetime.date):
        return value.strftime('%Y-%m-%d')
    return value


def beijing_now():
    """Current wall-clock in Asia/Shanghai (tz-aware)."""
    return datetime.datetime.now(datetime.timezone.utc).astimezone(_BEIJING)


# ========== 文本处理 ==========
def split_awards_text(value):
    """将奖项文本分割为列表"""
    if not value:
        return []
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    if not isinstance(value, str):
        return []
    return [item.strip() for item in value.replace('；\n', '；').split('；') if item.strip()]


def merge_awards_text(existing, award_title):
    """合并奖项到现有文本"""
    awards = split_awards_text(existing)
    if award_title in awards:
        return existing
    awards.append(award_title)
    return '；\n'.join(awards) + '；\n'


# ========== 邮件发送 ==========
def send_email(to_email, subject, content):
    """发送邮件"""
    SMTP_SERVER = os.getenv('SMTP_SERVER', 'smtp.qq.com')
    SMTP_PORT = int(os.getenv('SMTP_PORT', '465'))
    SENDER_EMAIL = os.getenv('SENDER_EMAIL', '1294336898@qq.com')
    SENDER_AUTH_CODE = os.getenv('SENDER_AUTH_CODE', 'kwggmlhbflqngedd')
    
    if not to_email:
        return False
    
    try:
        msg = MIMEText(content, 'plain', 'utf-8')
        msg['From'] = Header("智慧伴老平台警报中心", 'utf-8')
        msg['To'] = Header(to_email, 'utf-8')
        msg['Subject'] = Header(subject, 'utf-8')
        
        server = smtplib.SMTP_SSL(SMTP_SERVER, SMTP_PORT)
        server.login(SENDER_EMAIL, SENDER_AUTH_CODE)
        server.sendmail(SENDER_EMAIL, [to_email], msg.as_string())
        server.quit()
        return True
    except Exception as e:
        print(f"邮件发送失败: {e}")
        return False


def send_sos_email(to_email, elder_name):
    """SOS 邮件"""
    content = f"【紧急求助告警】您绑定的长辈（{elder_name}）刚刚在系统按下了 SOS 紧急求救按钮！请立刻拨打电话联系长辈或联系社区物业核实情况！"
    return send_email(to_email, "🚨【紧急告警】您的长辈正在呼救！", content)


def send_health_alert_email(to_email, elder_name, alert_description):
    """健康异常邮件"""
    content = f"【健康异常告警】您绑定的长辈（{elder_name}）的今日健康打卡出现异常：{alert_description}。请登录系统查看详情或及时联系长辈了解情况。"
    return send_email(to_email, "⚠️【健康提示】您的长辈健康数据异常", content)


# ========== 业务逻辑 ==========
def build_available_actions(order_status, order_volunteer_id, current_volunteer_id):
    """构建可用操作"""
    if order_status == 'pending':
        return ['accept']
    if current_volunteer_id is None:
        return []
    if str(order_volunteer_id) != str(current_volunteer_id):
        return []
    if order_status == 'accepted':
        # 已接单即视为出发：志愿者不可取消，仅老人可取消。
        return ['start']
    if order_status == 'in_progress':
        return ['complete']
    return []


def get_pagination_params(request):
    """获取分页参数"""
    page = int(request.args.get('page', 1))
    limit = int(request.args.get('limit', 10))
    offset = (page - 1) * limit
    return page, limit, offset
