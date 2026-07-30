#!/bin/sh
# 后端启动脚本：等待数据库就绪后启动 Flask

echo "⏳ 等待数据库就绪..."

python -c "
import psycopg2
import os
import time

host = os.getenv('DB_HOST', 'db')
port = int(os.getenv('DB_PORT', '5432'))
user = os.getenv('DB_USER', 'gaussdb')
password = os.getenv('DB_PASSWORD', 'Enmo@123')
dbname = os.getenv('DB_NAME', 'omm')

for _ in range(30):
    try:
        conn = psycopg2.connect(
            host=host, port=port,
            user=user, password=password,
            dbname=dbname
        )
        conn.close()
        print('✓ 数据库已就绪')
        break
    except Exception as e:
        time.sleep(2)
else:
    print('⚠ 数据库等待超时，继续启动...')
"

if [ "${APP_ENV:-development}" = "production" ]; then
    # The dispatch clock currently runs inside the app process. Keep one
    # worker until that clock is moved to a dedicated scheduler service.
    exec gunicorn \
        --bind "0.0.0.0:${PORT:-5000}" \
        --workers "${WEB_CONCURRENCY:-1}" \
        --threads "${WEB_THREADS:-4}" \
        --timeout "${WEB_TIMEOUT:-120}" \
        --access-logfile - \
        --error-logfile - \
        app:app
fi

exec python app.py
