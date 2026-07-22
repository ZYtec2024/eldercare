"""Privacy-scoped family, service and SOS conversation APIs."""

from __future__ import annotations

from typing import Any

from flask import Blueprint, jsonify, request

from db import get_db_connection
from utils import format_datetime


conversation_bp = Blueprint('conversation', __name__)


ROLE_LABELS = {
    'elder': '老人',
    'family': '家属',
    'volunteer': '志愿者',
    'admin': '管理员',
}


def _format_stamp(value: Any) -> str:
    # Thread codes stay on the raw instant; only display strings need +8.
    if hasattr(value, 'strftime'):
        return value.strftime('%Y%m%d%H%M%S')
    text = str(value or '').strip()
    digits = ''.join(ch for ch in text if ch.isdigit())
    return (digits + '00000000000000')[:14]


def _display_time(value: Any) -> Any:
    if hasattr(value, 'strftime') and not isinstance(value, str):
        return format_datetime(value)
    return value


def _thread_code(order_id: Any, created_at: Any, conversation_id: Any = None) -> str:
    stamp = _format_stamp(created_at)
    if order_id:
        return f"{int(order_id)}-{stamp}"
    return f"C{int(conversation_id or 0)}-{stamp}"


def _build_conversation_title(row: dict[str, Any]) -> str:
    service = str(row.get('service_type') or '').strip()
    ctype = str(row.get('conversation_type') or '')
    # Only mid-service upgrades (normal → SOS) use the upgrade title.
    # Native SOS must stay 「紧急求助」 even if upgraded_to_sos was wrongly set.
    if bool(row.get('was_upgraded_from_normal')):
        return f'{service} · 升级成SOS' if service else '服务沟通 · 升级成SOS'
    if ctype == 'sos' or str(row.get('order_urgency') or row.get('urgency') or '') == 'sos':
        return '紧急求助'
    if bool(row.get('upgraded_to_sos')):
        return f'{service} · 升级成SOS' if service else '服务沟通 · 升级成SOS'
    return service or '服务沟通'


def _member_guide(participants: list[dict[str, Any]], conversation_type: str, upgraded: bool) -> str:
    subtitle = _participant_subtitle(participants, conversation_type)
    if bool(upgraded) and conversation_type != 'sos':
        return f"本群人物（已升级SOS）：{subtitle}"
    if conversation_type == 'sos':
        return f"本群人物（SOS）：{subtitle}"
    return f"本群人物：{subtitle}"


def _was_upgraded_from_normal(cursor, order_id: Any) -> bool:
    if not order_id:
        return False
    cursor.execute(
        """
        SELECT 1 FROM dispatch_events
        WHERE order_id = %s AND event_type = 'order_upgraded_to_sos'
        LIMIT 1
        """,
        (int(order_id),),
    )
    return bool(cursor.fetchone())


def _member_row(cursor, conversation_id: int, user_id: int) -> dict[str, Any] | None:
    cursor.execute(
        '''SELECT can_speak, hidden_at, role_in_conversation
           FROM conversation_members
           WHERE conversation_id = %s AND user_id = %s''',
        (conversation_id, user_id),
    )
    return cursor.fetchone()


def _member(cursor, conversation_id: int, user_id: int) -> bool:
    return bool(_member_row(cursor, conversation_id, user_id))


def _ensure_admin_sos_access(cursor, conversation_id: int, user_id: int) -> bool:
    """Root may join any SOS chat; district admin only the exclusively assigned desk."""
    if _member(cursor, conversation_id, user_id):
        return True
    cursor.execute(
        """SELECT c.conversation_type, c.upgraded_to_sos, c.incident_id, e.region_adcode, u.role
           FROM conversations c
           LEFT JOIN elders e ON e.elder_id = c.elder_id
           JOIN users u ON u.user_id = %s
           WHERE c.conversation_id = %s""",
        (user_id, conversation_id),
    )
    row = cursor.fetchone()
    if not row or row.get('role') != 'admin':
        return False
    # Native SOS or mid-service upgrade both count as admin desk channels.
    if row.get('conversation_type') != 'sos' and not row.get('upgraded_to_sos'):
        return False
    cursor.execute(
        "SELECT region_adcode FROM admin_region_scope WHERE admin_user_id = %s",
        (user_id,),
    )
    scopes = {str(item['region_adcode']) for item in cursor.fetchall()}
    is_root = '*' in scopes
    region = str(row.get('region_adcode') or '')
    if not is_root and region not in scopes:
        return False
    incident_id = row.get('incident_id')
    if not is_root:
        allowed = False
        if incident_id:
            cursor.execute(
                """SELECT 1 FROM emergency_incidents
                    WHERE incident_id = %s AND assigned_admin_id = %s""",
                (int(incident_id), int(user_id)),
            )
            if cursor.fetchone():
                allowed = True
            else:
                cursor.execute(
                    """SELECT 1 FROM emergency_notifications
                        WHERE incident_id = %s AND recipient_user_id = %s""",
                    (int(incident_id), int(user_id)),
                )
                allowed = bool(cursor.fetchone())
        if not allowed:
            return False
    if not _member(cursor, conversation_id, user_id):
        try:
            cursor.execute(
                """INSERT INTO conversation_members
                   (conversation_id, user_id, role_in_conversation, can_speak)
                   VALUES (%s, %s, 'admin', TRUE)""",
                (conversation_id, user_id),
            )
        except Exception:
            pass
    return _member(cursor, conversation_id, user_id)


def _is_root_admin(cursor, user_id: int) -> bool:
    cursor.execute(
        "SELECT 1 FROM admin_region_scope WHERE admin_user_id = %s AND region_adcode = '*'",
        (user_id,),
    )
    return bool(cursor.fetchone())


def _participant_roster(cursor, conversation_id: int) -> list[dict[str, Any]]:
    cursor.execute(
        """
        SELECT cm.user_id, u.real_name, u.role, cm.can_speak,
               EXISTS (
                   SELECT 1 FROM admin_region_scope ars
                   WHERE ars.admin_user_id = u.user_id AND ars.region_adcode = '*'
               ) AS is_root_admin
        FROM conversation_members cm
        JOIN users u ON u.user_id = cm.user_id
        WHERE cm.conversation_id = %s
        """,
        (conversation_id,),
    )
    rows = cursor.fetchall()

    def sort_key(row: dict[str, Any]) -> tuple:
        role = str(row.get('role') or '')
        if role == 'admin' and row.get('is_root_admin'):
            return (0, int(row['user_id']))
        if role == 'admin':
            return (1, int(row['user_id']))
        if role == 'elder':
            return (2, int(row['user_id']))
        if role == 'family':
            return (3, int(row['user_id']))
        if role == 'volunteer' and row.get('can_speak'):
            return (4, int(row['user_id']))
        if role == 'volunteer':
            return (5, int(row['user_id']))
        return (6, int(row['user_id']))

    ordered = sorted(rows, key=sort_key)
    participants: list[dict[str, Any]] = []
    for row in ordered:
        role = str(row.get('role') or 'member')
        name = str(row.get('real_name') or f'用户{row["user_id"]}')
        if role == 'admin' and row.get('is_root_admin'):
            label = f'总管理{name}'
            role_label = '总管理'
        elif role == 'admin':
            label = f'区管理{name}'
            role_label = '区管理'
        else:
            role_label = ROLE_LABELS.get(role, role)
            label = f'{role_label}{name}'
        can_speak = bool(row.get('can_speak', True))
        if role == 'volunteer' and not can_speak:
            label = f'{label}(已离队)'
        participants.append({
            'user_id': int(row['user_id']),
            'name': name,
            'role': role,
            'role_label': role_label,
            'display_label': label,
            'can_speak': can_speak,
            'is_root_admin': bool(row.get('is_root_admin')),
        })
    return participants


def _participant_subtitle(participants: list[dict[str, Any]], conversation_type: str) -> str:
    if not participants:
        return '暂无成员'
    if conversation_type == 'sos':
        # SOS: admins first, then elder/family, then active volunteer.
        preferred = [
            p for p in participants
            if p['role'] == 'admin' or p['role'] in ('elder', 'family') or (p['role'] == 'volunteer' and p['can_speak'])
        ]
        labels = [p['display_label'] for p in preferred] or [p['display_label'] for p in participants]
    else:
        # Normal service: elder, family, volunteer (+ admins if contact-admin upgraded).
        preferred = [
            p for p in participants
            if p['role'] in ('elder', 'family') or (p['role'] == 'volunteer' and p['can_speak']) or p['role'] == 'admin'
        ]
        labels = [p['display_label'] for p in preferred] or [p['display_label'] for p in participants]
    return '、'.join(labels)


def _conversation_can_hide(cursor, conversation_id: int, user_id: int | None = None) -> bool:
    cursor.execute(
        """
        SELECT c.status, c.order_id, o.status AS order_status, ei.status AS incident_status
        FROM conversations c
        LEFT JOIN orders o ON o.order_id = c.order_id
        LEFT JOIN emergency_incidents ei ON ei.incident_id = c.incident_id
        WHERE c.conversation_id = %s
        """,
        (conversation_id,),
    )
    row = cursor.fetchone()
    if not row:
        return False
    if str(row.get('status') or '') == 'archived':
        return True
    if str(row.get('order_status') or '') in ('completed', 'cancelled'):
        return True
    if str(row.get('incident_status') or '') == 'resolved':
        return True
    order_id = row.get('order_id')
    if user_id and order_id and _volunteer_rejected_on_order(cursor, int(order_id), int(user_id)):
        return True
    return False


def _volunteer_rejected_on_order(cursor, order_id: int, user_id: int) -> bool:
    cursor.execute(
        """
        SELECT 1 FROM dispatch_candidates
        WHERE order_id = %s AND volunteer_id = %s AND response_status = 'rejected'
        LIMIT 1
        """,
        (order_id, user_id),
    )
    return bool(cursor.fetchone())


def _heal_and_effective_status(
    cursor,
    *,
    conversation_id: int,
    user_id: int,
    conv_status: Any,
    order_id: Any,
    order_status: Any,
    my_can_speak: bool,
) -> str:
    """Return the status this viewer should see; archive completed threads that were left active."""
    status = str(conv_status or 'active')
    order_state = str(order_status or '')
    if status == 'active' and order_state in ('completed', 'cancelled'):
        cursor.execute(
            """
            UPDATE conversations
            SET status = 'archived', archived_at = CURRENT_TIMESTAMP
            WHERE conversation_id = %s AND status = 'active'
            """,
            (conversation_id,),
        )
        return 'archived'
    if status == 'active' and order_id and not my_can_speak:
        if _volunteer_rejected_on_order(cursor, int(order_id), int(user_id)):
            # Shared chat stays active for the new assignee; rejected volunteer sees 已关闭.
            return 'closed'
    return status


@conversation_bp.route('', methods=['GET'])
def list_conversations():
    user_id = request.args.get('user_id', type=int)
    if not user_id:
        return jsonify({'code': 400, 'message': '缺少用户编号'}), 400
    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute('SELECT role FROM users WHERE user_id = %s', (user_id,))
            user = cursor.fetchone()
            role = str((user or {}).get('role') or '')
            # Admins keep every archive; other roles hide soft-deleted threads.
            hide_filter = '' if role == 'admin' else 'AND cm.hidden_at IS NULL'
            cursor.execute(
                f'''
                SELECT c.conversation_id, c.conversation_type, c.status, c.order_id, c.incident_id,
                       c.upgraded_to_sos, c.created_at AS conversation_created_at,
                       e.name AS elder_name, o.service_type, o.status AS order_status,
                       o.address AS order_address, o.volunteer_id, o.created_at AS order_created_at,
                       d.urgency AS order_urgency,
                       vu.real_name AS volunteer_name,
                       cm.can_speak AS my_can_speak,
                       (SELECT m.content FROM conversation_messages m WHERE m.conversation_id = c.conversation_id
                        ORDER BY m.message_id DESC LIMIT 1) AS last_message,
                       (SELECT m.created_at FROM conversation_messages m WHERE m.conversation_id = c.conversation_id
                        ORDER BY m.message_id DESC LIMIT 1) AS last_message_at,
                       (SELECT COUNT(*) FROM conversation_messages m
                        WHERE m.conversation_id = c.conversation_id
                          AND (m.sender_user_id IS NULL OR m.sender_user_id <> %s)
                          AND m.created_at > COALESCE(cm.last_read_at, TIMESTAMP '1970-01-01 00:00:00')) AS unread_count
                FROM conversation_members cm
                JOIN conversations c ON c.conversation_id = cm.conversation_id
                LEFT JOIN elders e ON e.elder_id = c.elder_id
                LEFT JOIN orders o ON o.order_id = c.order_id
                LEFT JOIN dispatch_orders d ON d.order_id = c.order_id
                LEFT JOIN users vu ON vu.user_id = o.volunteer_id
                WHERE cm.user_id = %s {hide_filter}
                ORDER BY last_message_at DESC NULLS LAST, c.conversation_id DESC
                ''',
                (user_id, user_id),
            )
            rows = cursor.fetchall()
            data = []
            for row in rows:
                participants = _participant_roster(cursor, int(row['conversation_id']))
                item = dict(row)
                ctype = str(row['conversation_type'])
                was_mid = _was_upgraded_from_normal(cursor, row.get('order_id'))
                order_urgency = str(row.get('order_urgency') or '')
                # Native SOS must not keep a sticky「升级」flag from contact-admin bugs.
                upgraded = was_mid
                if (
                    not was_mid
                    and bool(row.get('upgraded_to_sos'))
                    and (ctype == 'sos' or order_urgency == 'sos')
                ):
                    cursor.execute(
                        """UPDATE conversations SET upgraded_to_sos = FALSE
                           WHERE conversation_id = %s AND upgraded_to_sos = TRUE""",
                        (int(row['conversation_id']),),
                    )
                raw_can_speak = bool(row.get('my_can_speak', True))
                effective_status = _heal_and_effective_status(
                    cursor,
                    conversation_id=int(row['conversation_id']),
                    user_id=int(user_id),
                    conv_status=row.get('status'),
                    order_id=row.get('order_id'),
                    order_status=row.get('order_status'),
                    my_can_speak=raw_can_speak,
                )
                item['status'] = effective_status
                item['participants'] = participants
                item['participant_subtitle'] = _participant_subtitle(participants, ctype)
                item['member_guide'] = _member_guide(participants, ctype, upgraded)
                item['thread_code'] = _thread_code(
                    row.get('order_id'),
                    row.get('order_created_at') or row.get('conversation_created_at'),
                    row.get('conversation_id'),
                )
                item['upgraded_to_sos'] = upgraded
                item['was_upgraded_from_normal'] = was_mid
                item['can_hide'] = _conversation_can_hide(cursor, int(row['conversation_id']), int(user_id)) and role != 'admin'
                item['my_can_speak'] = raw_can_speak and effective_status == 'active'
                item['title'] = _build_conversation_title(item)
                for field in (
                    'conversation_created_at',
                    'order_created_at',
                    'last_message_at',
                ):
                    item[field] = _display_time(item.get(field))
                data.append(item)
            conn.commit()
            return jsonify({'code': 200, 'message': '会话列表已更新', 'data': data})
    finally:
        conn.close()


@conversation_bp.route('/<int:conversation_id>/messages', methods=['GET'])
def list_messages(conversation_id: int):
    user_id = request.args.get('user_id', type=int)
    if not user_id:
        return jsonify({'code': 400, 'message': '缺少用户编号'}), 400
    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            if not _ensure_admin_sos_access(cursor, conversation_id, user_id):
                return jsonify({'code': 403, 'message': '您无权查看此会话'}), 403
            member = _member_row(cursor, conversation_id, user_id)
            if member and member.get('hidden_at'):
                return jsonify({'code': 404, 'message': '该会话已从您的列表删除'}), 404
            cursor.execute(
                '''
                SELECT m.message_id, m.sender_user_id, u.real_name AS sender_name, m.message_type, m.content, m.created_at
                FROM conversation_messages m LEFT JOIN users u ON u.user_id = m.sender_user_id
                WHERE m.conversation_id = %s ORDER BY m.message_id ASC LIMIT 200
                ''',
                (conversation_id,),
            )
            messages = cursor.fetchall()
            payload_messages = []
            for row in messages:
                item = dict(row)
                item['created_at'] = _display_time(item.get('created_at'))
                payload_messages.append(item)
            cursor.execute(
                'UPDATE conversation_members SET last_read_at = CURRENT_TIMESTAMP WHERE conversation_id = %s AND user_id = %s',
                (conversation_id, user_id),
            )
            participants = _participant_roster(cursor, conversation_id)
            cursor.execute(
                """SELECT c.conversation_type, c.status, c.order_id, c.upgraded_to_sos,
                          c.created_at AS conversation_created_at,
                          e.name AS elder_name, o.service_type, o.status AS order_status,
                          o.created_at AS order_created_at, d.urgency AS order_urgency
                   FROM conversations c
                   LEFT JOIN elders e ON e.elder_id = c.elder_id
                   LEFT JOIN orders o ON o.order_id = c.order_id
                   LEFT JOIN dispatch_orders d ON d.order_id = c.order_id
                   WHERE c.conversation_id = %s""",
                (conversation_id,),
            )
            meta = cursor.fetchone() or {}
            ctype = str(meta.get('conversation_type') or '')
            was_mid = _was_upgraded_from_normal(cursor, meta.get('order_id'))
            order_urgency = str(meta.get('order_urgency') or '')
            upgraded = was_mid
            if (
                not was_mid
                and bool(meta.get('upgraded_to_sos'))
                and (ctype == 'sos' or order_urgency == 'sos')
            ):
                cursor.execute(
                    """UPDATE conversations SET upgraded_to_sos = FALSE
                       WHERE conversation_id = %s AND upgraded_to_sos = TRUE""",
                    (conversation_id,),
                )
            raw_can_speak = bool((member or {}).get('can_speak', True))
            effective_status = _heal_and_effective_status(
                cursor,
                conversation_id=conversation_id,
                user_id=int(user_id),
                conv_status=meta.get('status'),
                order_id=meta.get('order_id'),
                order_status=meta.get('order_status'),
                my_can_speak=raw_can_speak,
            )
            title_meta = {
                **meta,
                'upgraded_to_sos': upgraded,
                'was_upgraded_from_normal': was_mid,
                'order_urgency': order_urgency,
            }
            conn.commit()
            return jsonify({
                'code': 200,
                'message': '会话消息已更新',
                'data': {
                    'messages': payload_messages,
                    'participants': participants,
                    'participant_subtitle': _participant_subtitle(participants, ctype),
                    'member_guide': _member_guide(participants, ctype, upgraded),
                    'thread_code': _thread_code(
                        meta.get('order_id'),
                        meta.get('order_created_at') or meta.get('conversation_created_at'),
                        conversation_id,
                    ),
                    'title': _build_conversation_title(title_meta),
                    'upgraded_to_sos': upgraded,
                    'conversation_type': meta.get('conversation_type'),
                    'status': effective_status,
                    'order_id': meta.get('order_id'),
                    'elder_name': meta.get('elder_name'),
                    'service_type': meta.get('service_type'),
                    'order_status': meta.get('order_status'),
                    'my_can_speak': raw_can_speak and effective_status == 'active',
                    'can_hide': _conversation_can_hide(cursor, conversation_id, int(user_id)),
                },
            })
    finally:
        conn.close()


@conversation_bp.route('/<int:conversation_id>/messages', methods=['POST'])
def send_message(conversation_id: int):
    data = request.get_json() or {}
    user_id = data.get('user_id')
    content = str(data.get('content') or '').strip()
    message_type = str(data.get('message_type') or 'text')
    if not user_id or not content:
        return jsonify({'code': 400, 'message': '消息内容不能为空'}), 400
    if message_type not in ('text', 'quick_status'):
        return jsonify({'code': 400, 'message': '不支持的消息类型'}), 400
    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            if not _ensure_admin_sos_access(cursor, conversation_id, int(user_id)):
                return jsonify({'code': 403, 'message': '您无权在此会话发言'}), 403
            member = _member_row(cursor, conversation_id, int(user_id))
            if member and member.get('hidden_at'):
                return jsonify({'code': 404, 'message': '该会话已从您的列表删除'}), 404
            if member and not bool(member.get('can_speak', True)):
                return jsonify({'code': 403, 'message': '您已离开本群，无法继续发言'}), 403
            cursor.execute("SELECT status FROM conversations WHERE conversation_id = %s", (conversation_id,))
            conversation = cursor.fetchone()
            if not conversation or conversation['status'] != 'active':
                return jsonify({'code': 409, 'message': '该会话已归档'}), 409
            cursor.execute(
                '''INSERT INTO conversation_messages
                   (conversation_id, sender_user_id, message_type, content)
                   VALUES (%s, %s, %s, %s) RETURNING message_id, created_at''',
                (conversation_id, user_id, message_type, content[:1000]),
            )
            created = cursor.fetchone()
            conn.commit()
            return jsonify({'code': 200, 'message': '消息已发送', 'data': created})
    except Exception as exc:
        conn.rollback()
        return jsonify({'code': 500, 'message': f'发送消息失败: {exc}'}), 500
    finally:
        conn.close()


@conversation_bp.route('/<int:conversation_id>/hide', methods=['POST'])
def hide_conversation(conversation_id: int):
    """Elder / family / volunteer may remove finished chats from their inbox.

    Admin archives remain untouched.
    """
    data = request.get_json() or {}
    user_id = data.get('user_id')
    if not user_id:
        return jsonify({'code': 400, 'message': '缺少用户编号'}), 400
    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute('SELECT role FROM users WHERE user_id = %s', (user_id,))
            user = cursor.fetchone()
            if not user:
                return jsonify({'code': 404, 'message': '用户不存在'}), 404
            if str(user.get('role') or '') == 'admin':
                return jsonify({'code': 403, 'message': '管理员需留档，不可删除会话'}), 403
            if not _member(cursor, conversation_id, int(user_id)):
                return jsonify({'code': 403, 'message': '您不在该会话中'}), 403
            if not _conversation_can_hide(cursor, conversation_id, int(user_id)):
                return jsonify({'code': 409, 'message': '进行中的会话不能删除，请待服务结束或归档后再删'}), 409
            cursor.execute(
                '''UPDATE conversation_members
                   SET hidden_at = CURRENT_TIMESTAMP
                   WHERE conversation_id = %s AND user_id = %s''',
                (conversation_id, user_id),
            )
            conn.commit()
            return jsonify({'code': 200, 'message': '已从您的会话列表删除（管理员仍保留归档）'})
    except Exception as exc:
        conn.rollback()
        return jsonify({'code': 500, 'message': f'删除会话失败: {exc}'}), 500
    finally:
        conn.close()
