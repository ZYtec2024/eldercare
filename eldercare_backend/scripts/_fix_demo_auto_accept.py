import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from db import get_db_connection

conn = get_db_connection()
if conn is None:
    raise SystemExit("db connection failed")

cur = conn.cursor()
cur.execute(
    """
    SELECT u.user_id, u.real_name, p.auto_accept_enabled, p.service_region_adcode
    FROM users u
    JOIN volunteer_location_state p ON p.volunteer_id = u.user_id
    WHERE u.real_name LIKE %s OR p.service_region_adcode IN ('310115', '110105')
    ORDER BY p.service_region_adcode, u.user_id
    """,
    ("%李晨%",),
)
print("before:")
for row in cur.fetchall():
    print(dict(row))

cur.execute(
    """
    UPDATE volunteer_location_state p
    SET auto_accept_enabled = FALSE, updated_at = CURRENT_TIMESTAMP
    FROM users u
    WHERE u.user_id = p.volunteer_id
      AND u.username LIKE 'demo_%'
      AND p.auto_accept_enabled = TRUE
    """
)
print("updated", cur.rowcount)
conn.commit()

cur.execute(
    """
    SELECT u.real_name, p.auto_accept_enabled, p.service_region_adcode
    FROM users u
    JOIN volunteer_location_state p ON p.volunteer_id = u.user_id
    WHERE u.real_name LIKE %s OR p.service_region_adcode = '310115'
    ORDER BY u.user_id
    """,
    ("%李晨%",),
)
print("after:")
for row in cur.fetchall():
    print(dict(row))
conn.close()
