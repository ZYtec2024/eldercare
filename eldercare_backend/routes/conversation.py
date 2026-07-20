"""Privacy-scoped family, service and SOS conversation APIs."""

from flask import Blueprint, jsonify, request

from db import get_db_connection


conversation_bp = Blueprint('conversation', __name__)


def _member(cursor, conversation_id: int, user_id: int) -> bool:
    cursor.execute('SELECT 1 FROM conversation_members WHERE conversation_id = %s AND user_id = %s',
                   (conversation_id, user_id))
    return bool(cursor.fetchone())


@conversation_bp.route('', methods=['GET'])
def list_conversations():
    user_id = request.args.get('user_id', type=int)
    if not user_id:
        return jsonify({'code': 400, 'message': '缺少用户编号'}), 400
    conn = get_db_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute('''
                SELECT c.conversation_id, c.conversation_type, c.status, c.order_id, c.incident_id,
                       e.name AS elder_name, o.service_type,
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
                WHERE cm.user_id = %s
                ORDER BY last_message_at DESC NULLS LAST, c.conversation_id DESC
            ''', (user_id, user_id))
            return jsonify({'code': 200, 'message': '会话列表已更新', 'data': cursor.fetchall()})
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
            if not _member(cursor, conversation_id, user_id):
                return jsonify({'code': 403, 'message': '您无权查看此会话'}), 403
            cursor.execute('''
                SELECT m.message_id, m.sender_user_id, u.real_name AS sender_name, m.message_type, m.content, m.created_at
                FROM conversation_messages m LEFT JOIN users u ON u.user_id = m.sender_user_id
                WHERE m.conversation_id = %s ORDER BY m.message_id ASC LIMIT 200
            ''', (conversation_id,))
            messages = cursor.fetchall()
            cursor.execute('UPDATE conversation_members SET last_read_at = CURRENT_TIMESTAMP WHERE conversation_id = %s AND user_id = %s',
                           (conversation_id, user_id))
            conn.commit()
            return jsonify({'code': 200, 'message': '会话消息已更新', 'data': messages})
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
            if not _member(cursor, conversation_id, int(user_id)):
                return jsonify({'code': 403, 'message': '您无权在此会话发言'}), 403
            cursor.execute("SELECT status FROM conversations WHERE conversation_id = %s", (conversation_id,))
            conversation = cursor.fetchone()
            if not conversation or conversation['status'] != 'active':
                return jsonify({'code': 409, 'message': '该会话已归档'}), 409
            cursor.execute('''INSERT INTO conversation_messages
                              (conversation_id, sender_user_id, message_type, content)
                              VALUES (%s, %s, %s, %s) RETURNING message_id, created_at''',
                           (conversation_id, user_id, message_type, content[:1000]))
            created = cursor.fetchone()
            conn.commit()
            return jsonify({'code': 200, 'message': '消息已发送', 'data': created})
    except Exception as exc:
        conn.rollback()
        return jsonify({'code': 500, 'message': f'发送消息失败: {exc}'}), 500
    finally:
        conn.close()
