"""AI companion, transcription and speech settings APIs."""

from __future__ import annotations

import asyncio
import concurrent.futures
import os
import tempfile
from io import BytesIO
from typing import Any

from flask import Blueprint, jsonify, request, send_file

from db import get_db_connection

try:
    import requests
except ImportError:  # pragma: no cover - dependency is declared in requirements.txt
    requests = None

try:
    import edge_tts
except ImportError:  # pragma: no cover - dependency is declared in requirements.txt
    edge_tts = None


ai_bp = Blueprint('ai', __name__)

AI_SETTINGS_TABLE = 'ai_service_settings'
DEFAULT_AI_SETTINGS: dict[str, str] = {
    # Groq (fallback when no custom model is configured)
    'groq_api_key': os.getenv('GROQ_API_KEY', ''),
    'groq_chat_model': os.getenv('GROQ_CHAT_MODEL', 'llama-3.1-8b-instant'),
    'groq_transcribe_model': os.getenv('GROQ_TRANSCRIBE_MODEL', 'whisper-large-v3'),
    # Custom chat model (OpenAI-compatible API) — when set, overrides Groq for chat
    'chat_api_key': os.getenv('CHAT_API_KEY', ''),
    'chat_api_base_url': os.getenv('CHAT_API_BASE_URL', ''),
    'chat_model_name': os.getenv('CHAT_MODEL_NAME', ''),
    # TTS
    'tts_voice': os.getenv('EDGE_TTS_VOICE', 'zh-CN-XiaoxiaoNeural'),
    'tts_rate': os.getenv('EDGE_TTS_RATE', '+0%'),
    'tts_volume': os.getenv('EDGE_TTS_VOLUME', '+0%'),
    # 智能周报专用模型（OpenAI 兼容接口）
    'report_api_key': os.getenv('REPORT_API_KEY', ''),
    'report_api_base_url': os.getenv('REPORT_API_BASE_URL', ''),
    'report_model_name': os.getenv('REPORT_MODEL_NAME', ''),
    # System prompt
    'companion_system_prompt': os.getenv(
        'COMPANION_SYSTEM_PROMPT',
        '你是智慧伴老平台的智能陪聊助手。请用亲切、耐心、简洁的中文与老人交流。'
        '优先关心情绪、健康和安全，不要输出夸张或不现实的承诺。'
        '如果涉及紧急医疗风险，请明确提醒老人立即联系家属、志愿者或拨打当地急救电话。',
    ),
}

_TTS_EXECUTOR = concurrent.futures.ThreadPoolExecutor(max_workers=2, thread_name_prefix='tts')


def _ensure_ai_schema(cursor) -> None:
    cursor.execute(
        f"""
        CREATE TABLE IF NOT EXISTS {AI_SETTINGS_TABLE} (
            config_key VARCHAR(64) PRIMARY KEY,
            config_value TEXT NOT NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS companion_chat_history (
            message_id SERIAL PRIMARY KEY,
            user_id INT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
            role VARCHAR(16) NOT NULL CHECK (role IN ('user', 'assistant')),
            content TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    cursor.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_companion_chat_user
        ON companion_chat_history(user_id, created_at)
        """
    )


def _default_settings() -> dict[str, str]:
    return dict(DEFAULT_AI_SETTINGS)


def _load_settings(cursor) -> dict[str, str]:
    _ensure_ai_schema(cursor)
    settings = _default_settings()
    cursor.execute(f"SELECT config_key, config_value FROM {AI_SETTINGS_TABLE}")
    for row in cursor.fetchall():
        settings[str(row['config_key'])] = str(row.get('config_value') or '')
    return settings


def _persist_settings(cursor, updates: dict[str, str]) -> dict[str, str]:
    _ensure_ai_schema(cursor)
    merged = _load_settings(cursor)
    merged.update({key: value for key, value in updates.items() if value is not None})
    for key, value in merged.items():
        cursor.execute(
            f"UPDATE {AI_SETTINGS_TABLE} SET config_value = %s, updated_at = CURRENT_TIMESTAMP WHERE config_key = %s",
            (str(value or ''), key),
        )
        if cursor.rowcount == 0:
            cursor.execute(
                f"INSERT INTO {AI_SETTINGS_TABLE} (config_key, config_value, updated_at) VALUES (%s, %s, CURRENT_TIMESTAMP)",
                (key, str(value or '')),
            )
    return merged


def _has_api_key(value: str) -> bool:
    return bool(str(value or '').strip())


def _require_root_admin(cursor, admin_user_id: Any):
    try:
        admin_id = int(admin_user_id)
    except (TypeError, ValueError):
        return None, (jsonify({"code": 400, "message": "缺少管理员身份"}), 400)

    cursor.execute("SELECT role FROM users WHERE user_id = %s", (admin_id,))
    user = cursor.fetchone()
    if not user or str(user.get('role') or '') != 'admin':
        return None, (jsonify({"code": 403, "message": "仅管理员可访问"}), 403)

    cursor.execute(
        "SELECT 1 FROM admin_region_scope WHERE admin_user_id = %s AND region_adcode = '*'",
        (admin_id,),
    )
    if not cursor.fetchone():
        return None, (jsonify({"code": 403, "message": "仅总管理员可管理 AI 配置"}), 403)

    return admin_id, None


def _require_elder(cursor, user_id: Any):
    try:
        elder_id = int(user_id)
    except (TypeError, ValueError):
        return None, (jsonify({"code": 400, "message": "缺少用户编号"}), 400)

    cursor.execute(
        """
        SELECT u.user_id, u.real_name, u.role, e.name, e.age, e.medical_history,
               e.personality_bio, e.address
        FROM users u
        LEFT JOIN elders e ON e.user_id = u.user_id
        WHERE u.user_id = %s
        """,
        (elder_id,),
    )
    user = cursor.fetchone()
    if not user:
        return None, (jsonify({"code": 404, "message": "用户不存在"}), 404)
    if str(user.get('role') or '') != 'elder':
        return None, (jsonify({"code": 403, "message": "仅老人端可使用智能陪聊"}), 403)
    return user, None


def _normalize_chat_history(items: Any) -> list[dict[str, str]]:
    if not isinstance(items, list):
        return []
    normalized: list[dict[str, str]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        role = str(item.get('role') or '').strip()
        content = str(item.get('content') or '').strip()
        if role not in ('user', 'assistant') or not content:
            continue
        normalized.append({'role': role, 'content': content[:2000]})
    return normalized[-12:]


def _build_companion_context(elder_row: dict[str, Any]) -> str:
    name = str(elder_row.get('name') or elder_row.get('real_name') or '长者')
    age = elder_row.get('age')
    medical_history = str(elder_row.get('medical_history') or '').strip()
    personality_bio = str(elder_row.get('personality_bio') or '').strip()
    address = str(elder_row.get('address') or '').strip()
    fragments = [f'对话对象：{name}']
    if age:
        fragments.append(f'年龄：{age} 岁')
    if address:
        fragments.append(f'住址：{address}')
    if medical_history:
        fragments.append(f'健康背景：{medical_history}')
    if personality_bio:
        fragments.append(f'性格简介：{personality_bio}')
    return '；'.join(fragments)


def _groq_headers(api_key: str) -> dict[str, str]:
    return {
        'Authorization': f'Bearer {api_key}',
        'Content-Type': 'application/json',
    }


def _groq_request(path: str, api_key: str, payload: dict[str, Any]) -> dict[str, Any]:
    if requests is None:
        raise RuntimeError('requests 依赖未安装，无法调用 Groq API')
    response = requests.post(
        f'https://api.groq.com/openai/v1/{path.lstrip("/")}',
        headers=_groq_headers(api_key),
        json=payload,
        timeout=90,
    )
    try:
        response_data = response.json()
    except Exception:
        response_data = {'message': response.text[:500]}
    if not response.ok:
        message = response_data.get('error', {}).get('message') if isinstance(response_data, dict) else None
        raise RuntimeError(message or response_data.get('message') or 'Groq 请求失败')
    if not isinstance(response_data, dict):
        raise RuntimeError('Groq 返回的数据格式不正确')
    return response_data


async def _render_tts_audio(text: str, voice: str, rate: str, volume: str) -> bytes:
    if edge_tts is None:
        raise RuntimeError('edge-tts 依赖未安装，无法生成语音')
    with tempfile.NamedTemporaryFile(delete=False, suffix='.mp3') as tmp:
        temp_path = tmp.name
    try:
        communicator = edge_tts.Communicate(text=text, voice=voice, rate=rate, volume=volume)
        await communicator.save(temp_path)
        with open(temp_path, 'rb') as audio_file:
            return audio_file.read()
    finally:
        try:
            os.remove(temp_path)
        except OSError:
            pass


def _run_tts(text: str, voice: str, rate: str, volume: str) -> bytes:
    """Safely run the async edge-tts call from a sync Flask handler."""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(_render_tts_audio(text, voice, rate, volume))
    # If a loop is already running (e.g. under gunicorn with gevent, or nested),
    # run the coroutine in a thread to avoid nesting conflicts.
    future = _TTS_EXECUTOR.submit(asyncio.run, _render_tts_audio(text, voice, rate, volume))
    return future.result(timeout=60)


@ai_bp.route('/admin/ai-config', methods=['GET'])
def get_ai_config():
    admin_user_id = request.args.get('admin_user_id')
    conn = get_db_connection()
    if not conn:
        return jsonify({"code": 500, "message": "数据库连接失败"}), 500
    try:
        with conn.cursor() as cursor:
            _, error = _require_root_admin(cursor, admin_user_id)
            if error:
                return error
            settings = _load_settings(cursor)
            return jsonify({
                "code": 200,
                "message": "获取 AI 配置成功",
                "data": {
                    "has_groq_api_key": _has_api_key(settings.get('groq_api_key', '')),
                    "groq_chat_model": settings.get('groq_chat_model', DEFAULT_AI_SETTINGS['groq_chat_model']),
                    "groq_transcribe_model": settings.get('groq_transcribe_model', DEFAULT_AI_SETTINGS['groq_transcribe_model']),
                    "has_chat_api_key": _has_api_key(settings.get('chat_api_key', '')),
                    "chat_api_base_url": settings.get('chat_api_base_url', DEFAULT_AI_SETTINGS['chat_api_base_url']),
                    "chat_model_name": settings.get('chat_model_name', DEFAULT_AI_SETTINGS['chat_model_name']),
                    "tts_voice": settings.get('tts_voice', DEFAULT_AI_SETTINGS['tts_voice']),
                    "tts_rate": settings.get('tts_rate', DEFAULT_AI_SETTINGS['tts_rate']),
                    "tts_volume": settings.get('tts_volume', DEFAULT_AI_SETTINGS['tts_volume']),
                    "companion_system_prompt": settings.get('companion_system_prompt', DEFAULT_AI_SETTINGS['companion_system_prompt']),
                    "has_report_api_key": _has_api_key(settings.get('report_api_key', '')),
                    "report_api_base_url": settings.get('report_api_base_url', DEFAULT_AI_SETTINGS['report_api_base_url']),
                    "report_model_name": settings.get('report_model_name', DEFAULT_AI_SETTINGS['report_model_name']),
                },
            })
    finally:
        conn.close()


@ai_bp.route('/admin/ai-config', methods=['PUT'])
def update_ai_config():
    data = request.get_json(silent=True) or {}
    conn = get_db_connection()
    if not conn:
        return jsonify({"code": 500, "message": "数据库连接失败"}), 500
    try:
        with conn.cursor() as cursor:
            _, error = _require_root_admin(cursor, data.get('admin_user_id'))
            if error:
                return error
            current = _load_settings(cursor)
            updates = {
                'groq_api_key': str(data.get('groq_api_key') or '').strip() or current.get('groq_api_key', ''),
                'groq_chat_model': str(data.get('groq_chat_model') or current.get('groq_chat_model', DEFAULT_AI_SETTINGS['groq_chat_model'])).strip(),
                'groq_transcribe_model': str(data.get('groq_transcribe_model') or current.get('groq_transcribe_model', DEFAULT_AI_SETTINGS['groq_transcribe_model'])).strip(),
                'chat_api_key': str(data.get('chat_api_key') or '').strip() or current.get('chat_api_key', ''),
                'chat_api_base_url': str(data.get('chat_api_base_url') or current.get('chat_api_base_url', DEFAULT_AI_SETTINGS['chat_api_base_url'])).strip(),
                'chat_model_name': str(data.get('chat_model_name') or current.get('chat_model_name', DEFAULT_AI_SETTINGS['chat_model_name'])).strip(),
                'tts_voice': str(data.get('tts_voice') or current.get('tts_voice', DEFAULT_AI_SETTINGS['tts_voice'])).strip(),
                'tts_rate': str(data.get('tts_rate') or current.get('tts_rate', DEFAULT_AI_SETTINGS['tts_rate'])).strip(),
                'tts_volume': str(data.get('tts_volume') or current.get('tts_volume', DEFAULT_AI_SETTINGS['tts_volume'])).strip(),
                'companion_system_prompt': str(data.get('companion_system_prompt') or current.get('companion_system_prompt', DEFAULT_AI_SETTINGS['companion_system_prompt'])).strip(),
                'report_api_key': str(data.get('report_api_key') or '').strip() or current.get('report_api_key', ''),
                'report_api_base_url': str(data.get('report_api_base_url') or current.get('report_api_base_url', DEFAULT_AI_SETTINGS['report_api_base_url'])).strip(),
                'report_model_name': str(data.get('report_model_name') or current.get('report_model_name', DEFAULT_AI_SETTINGS['report_model_name'])).strip(),
            }
            _persist_settings(cursor, updates)
            conn.commit()
            return jsonify({
                "code": 200,
                "message": "AI 配置已更新",
                "data": {
                    "has_groq_api_key": _has_api_key(updates['groq_api_key']),
                    "groq_chat_model": updates['groq_chat_model'],
                    "groq_transcribe_model": updates['groq_transcribe_model'],
                    "has_chat_api_key": _has_api_key(updates['chat_api_key']),
                    "chat_api_base_url": updates['chat_api_base_url'],
                    "chat_model_name": updates['chat_model_name'],
                    "tts_voice": updates['tts_voice'],
                    "tts_rate": updates['tts_rate'],
                    "tts_volume": updates['tts_volume'],
                    "companion_system_prompt": updates['companion_system_prompt'],
                    "has_report_api_key": _has_api_key(updates['report_api_key']),
                    "report_api_base_url": updates['report_api_base_url'],
                    "report_model_name": updates['report_model_name'],
                },
            })
    finally:
        conn.close()


def _openai_compatible_request(api_key: str, base_url: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Call any OpenAI-compatible chat API (DeepSeek, Doubao, GPT, etc.)."""
    if requests is None:
        raise RuntimeError('requests 依赖未安装，无法调用对话 API')
    url = str(base_url).rstrip('/') + '/chat/completions'
    response = requests.post(
        url,
        headers={
            'Authorization': f'Bearer {api_key}',
            'Content-Type': 'application/json',
        },
        json=payload,
        timeout=90,
    )
    try:
        response_data = response.json()
    except Exception:
        response_data = {'message': response.text[:500]}
    if not response.ok:
        message = response_data.get('error', {}).get('message') if isinstance(response_data, dict) else None
        raise RuntimeError(message or response_data.get('message') or '对话 API 请求失败')
    if not isinstance(response_data, dict):
        raise RuntimeError('对话 API 返回的数据格式不正确')
    return response_data


@ai_bp.route('/elder/companion/chat', methods=['POST'])
def elder_companion_chat():
    data = request.get_json(silent=True) or {}
    message = str(data.get('message') or '').strip()
    if not message:
        return jsonify({"code": 400, "message": "聊天内容不能为空"}), 400

    conn = get_db_connection()
    if not conn:
        return jsonify({"code": 500, "message": "数据库连接失败"}), 500
    try:
        with conn.cursor() as cursor:
            elder_row, error = _require_elder(cursor, data.get('user_id'))
            if error:
                return error
            settings = _load_settings(cursor)

            # ── Resolve which API to use ──
            custom_api_key = str(settings.get('chat_api_key') or '').strip()
            custom_base_url = str(settings.get('chat_api_base_url') or '').strip()
            custom_model = str(settings.get('chat_model_name') or '').strip()
            use_custom = bool(custom_api_key and custom_base_url and custom_model)

            if use_custom:
                api_key = custom_api_key
                model = custom_model
                api_label = '自定义'
            else:
                api_key = str(settings.get('groq_api_key') or '').strip()
                model = str(settings.get('groq_chat_model') or DEFAULT_AI_SETTINGS['groq_chat_model'])
                api_label = 'Groq'

            if not api_key:
                return jsonify({"code": 400, "message": "尚未配置对话 API Key，请联系总管理员"}), 400

            system_prompt = str(settings.get('companion_system_prompt') or DEFAULT_AI_SETTINGS['companion_system_prompt']).strip()
            context = _build_companion_context(elder_row)
            history = _normalize_chat_history(data.get('history'))
            payload_messages = [
                {
                    'role': 'system',
                    'content': f'{system_prompt}\n\n当前用户背景：{context}',
                },
                *history,
                {
                    'role': 'user',
                    'content': message[:2000],
                },
            ]
            chat_payload = {
                'model': model,
                'messages': payload_messages,
                'temperature': 0.7,
                'max_tokens': 512,
            }

            if use_custom:
                response_data = _openai_compatible_request(api_key, custom_base_url, chat_payload)
            else:
                response_data = _groq_request('chat/completions', api_key, chat_payload)

            reply = ''
            try:
                reply = str(response_data['choices'][0]['message']['content']).strip()
            except Exception:
                reply = ''
            if not reply:
                return jsonify({"code": 502, "message": f"{api_label} 未返回有效回复"}), 502
            return jsonify({
                "code": 200,
                "message": "已生成陪聊回复",
                "data": {
                    "reply": reply,
                    "model": model,
                    "api": api_label,
                },
            })
    except Exception as exc:
        return jsonify({"code": 502, "message": str(exc) if str(exc) else '陪聊服务暂时不可用'}), 502
    finally:
        conn.close()


@ai_bp.route('/elder/companion/transcribe', methods=['POST'])
def elder_companion_transcribe():
    conn = get_db_connection()
    if not conn:
        return jsonify({"code": 500, "message": "数据库连接失败"}), 500
    try:
        with conn.cursor() as cursor:
            _, error = _require_elder(cursor, request.form.get('user_id') or request.args.get('user_id'))
            if error:
                return error
            settings = _load_settings(cursor)
            api_key = str(settings.get('groq_api_key') or '').strip()
            if not api_key:
                return jsonify({"code": 400, "message": "尚未配置 Groq API Key，请联系总管理员"}), 400

            uploaded = request.files.get('audio') or request.files.get('file')
            if not uploaded:
                return jsonify({"code": 400, "message": "请上传音频文件"}), 400

            if requests is None:
                return jsonify({"code": 502, "message": "requests 依赖未安装，无法转写语音"}), 502

            try:
                response = requests.post(
                    'https://api.groq.com/openai/v1/audio/transcriptions',
                    headers={'Authorization': f'Bearer {api_key}'},
                    files={'file': (uploaded.filename or 'audio.webm', uploaded.read(), uploaded.mimetype or 'application/octet-stream')},
                    data={'model': str(settings.get('groq_transcribe_model') or DEFAULT_AI_SETTINGS['groq_transcribe_model']), 'language': 'zh'},
                    timeout=90,
                )
                try:
                    response_data = response.json()
                except Exception:
                    response_data = {'message': response.text[:500]}
                if not response.ok:
                    message = response_data.get('error', {}).get('message') if isinstance(response_data, dict) else None
                    raise RuntimeError(message or response_data.get('message') or 'Groq 语音转写失败')
                text = str(response_data.get('text') or '').strip()
                if not text:
                    raise RuntimeError('Groq 未返回识别文本')
            except Exception as exc:
                return jsonify({"code": 502, "message": str(exc) if str(exc) else '语音转写服务暂时不可用'}), 502
            return jsonify({
                "code": 200,
                "message": "语音转写成功",
                "data": {
                    "text": text,
                    "model": str(settings.get('groq_transcribe_model') or DEFAULT_AI_SETTINGS['groq_transcribe_model']),
                },
            })
    finally:
        conn.close()


@ai_bp.route('/elder/companion/tts', methods=['POST'])
def elder_companion_tts():
    data = request.get_json(silent=True) or {}
    text = str(data.get('text') or '').strip()
    user_id = data.get('user_id')

    if not text:
        return jsonify({"code": 400, "message": "朗读内容不能为空"}), 400

    conn = get_db_connection()
    if not conn:
        return jsonify({"code": 500, "message": "数据库连接失败"}), 500
    try:
        with conn.cursor() as cursor:
            _, error = _require_elder(cursor, user_id)
            if error:
                return error
            settings = _load_settings(cursor)
            voice = str(settings.get('tts_voice') or DEFAULT_AI_SETTINGS['tts_voice'])
            rate = str(settings.get('tts_rate') or DEFAULT_AI_SETTINGS['tts_rate'])
            volume = str(settings.get('tts_volume') or DEFAULT_AI_SETTINGS['tts_volume'])

        audio_bytes = _run_tts(text[:2000], voice, rate, volume)
        return send_file(
            BytesIO(audio_bytes),
            mimetype='audio/mpeg',
            as_attachment=False,
            download_name='companion-tts.mp3',
            max_age=0,
        )
    except Exception as exc:
        return jsonify({"code": 502, "message": str(exc) if str(exc) else '语音合成服务暂时不可用'}), 502
    finally:
        conn.close()


@ai_bp.route('/elder/companion/history', methods=['GET'])
def companion_history():
    """Load recent chat history for the elder."""
    user_id = request.args.get('user_id')
    conn = get_db_connection()
    if not conn:
        return jsonify({"code": 500, "message": "数据库连接失败"}), 500
    try:
        with conn.cursor() as cursor:
            _, error = _require_elder(cursor, user_id)
            if error:
                return error
            _ensure_ai_schema(cursor)
            cursor.execute(
                """
                SELECT role, content FROM companion_chat_history
                WHERE user_id = %s
                ORDER BY created_at ASC
                LIMIT 60
                """,
                (int(user_id),),
            )
            rows = cursor.fetchall()
            history = [{"role": row['role'], "content": row['content']} for row in rows]
        return jsonify({"code": 200, "message": "获取历史成功", "data": {"history": history}})
    finally:
        conn.close()


@ai_bp.route('/elder/companion/history', methods=['POST'])
def save_companion_message():
    """Save a single chat message (user or assistant)."""
    data = request.get_json(silent=True) or {}
    user_id = data.get('user_id')
    role = str(data.get('role') or '').strip()
    content = str(data.get('content') or '').strip()
    if role not in ('user', 'assistant') or not content:
        return jsonify({"code": 400, "message": "参数无效"}), 400
    conn = get_db_connection()
    if not conn:
        return jsonify({"code": 500, "message": "数据库连接失败"}), 500
    try:
        with conn.cursor() as cursor:
            _, error = _require_elder(cursor, user_id)
            if error:
                return error
            _ensure_ai_schema(cursor)
            cursor.execute(
                "INSERT INTO companion_chat_history (user_id, role, content) VALUES (%s, %s, %s)",
                (int(user_id), role, content[:2000]),
            )
            conn.commit()
        return jsonify({"code": 200, "message": "保存成功"})
    finally:
        conn.close()