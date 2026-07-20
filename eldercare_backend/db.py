# db.py
import os
import psycopg2
from psycopg2.extras import RealDictCursor

DB_CONFIG = {
    'host': os.getenv('DB_HOST', '127.0.0.1'),
    'port': int(os.getenv('DB_PORT', '5432')),
    # Matches the local opengauss-eldercare Docker container.  Deployment
    # environments can still override every setting with DB_* variables.
    'user': os.getenv('DB_USER', 'gaussdb'),
    'password': os.getenv('DB_PASSWORD', 'openGauss@123'),
    'dbname': os.getenv('DB_NAME', 'elderly_care_system'),
    'cursor_factory': RealDictCursor,
}


def get_db_connection():
    """获取数据库连接"""
    try:
        conn = psycopg2.connect(**DB_CONFIG)
        conn.autocommit = False
        return conn
    except Exception as e:
        print(f"数据库连接失败: {e}")
        return None
