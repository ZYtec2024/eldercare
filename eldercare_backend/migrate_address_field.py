#!/usr/bin/env python
# -*- coding: utf-8 -*-
import psycopg2
import os

DB_CONFIG = {
    'host': os.getenv('DB_HOST', '127.0.0.1'),
    'port': int(os.getenv('DB_PORT', '5432')),
    'user': os.getenv('DB_USER', 'gaussdb'),
    'password': os.getenv('DB_PASSWORD', 'Enmo@123'),
    'dbname': os.getenv('DB_NAME', 'omm'),
}

try:
    conn = psycopg2.connect(**DB_CONFIG)
    cursor = conn.cursor()
    
    # 检查address列是否存在
    cursor.execute("""
        SELECT column_name FROM information_schema.columns 
        WHERE table_name='orders' AND column_name='address'
    """)
    
    if not cursor.fetchone():
        print('正在添加address字段...')
        cursor.execute("ALTER TABLE orders ADD COLUMN address VARCHAR(255) DEFAULT NULL")
        conn.commit()
        print('✓ address字段添加成功')
    else:
        print('✓ address字段已存在')
        
except Exception as e:
    conn.rollback()
    print(f'✗ 错误: {str(e)}')
finally:
    cursor.close()
    conn.close()

