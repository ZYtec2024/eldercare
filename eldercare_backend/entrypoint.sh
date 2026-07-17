#!/bin/sh
# 后端启动脚本：等待数据库就绪后启动 Flask

echo "⏳ 等待数据库就绪..."

python -c "
import psycopg2
import os
import time

host = os.getenv('DB_HOST', 'db')
password = os.getenv('DB_PASSWORD', 'root')

for _ in range(30):
    try:
        conn = psycopg2.connect(
            host=host, port=5432,
            user='postgres', password=password,
            dbname='elderly_care_system'
        )
        conn.close()
        print('✓ 数据库已就绪')
        break
    except Exception as e:
        time.sleep(2)
else:
    print('⚠ 数据库等待超时，继续启动...')
"

exec python app.py
