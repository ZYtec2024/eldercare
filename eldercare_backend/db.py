# db.py
import os
import psycopg2
from psycopg2.extras import RealDictCursor

DB_CONFIG = {
    'host': os.getenv('DB_HOST', '127.0.0.1'),
    'port': int(os.getenv('DB_PORT', '5432')),
    'user': os.getenv('DB_USER', 'gaussdb'),
    'password': os.getenv('DB_PASSWORD', 'Enmo@123'),
    'dbname': os.getenv('DB_NAME', 'omm'),
    'cursor_factory': RealDictCursor,
}


def get_db_connection():
    """获取数据库连接"""
    try:
        conn = psycopg2.connect(**DB_CONFIG)
        conn.autocommit = False
        # Keep system timestamps stable across openGauss images and host TZs.
        # Business wall-clock values such as appointments are handled by the
        # route layer and are not converted by this connection setting.
        with conn.cursor() as cursor:
            cursor.execute("SET TIME ZONE 'UTC'")
        conn.commit()
        return conn
    except Exception as e:
        print(f"数据库连接失败: {e}")
        return None
