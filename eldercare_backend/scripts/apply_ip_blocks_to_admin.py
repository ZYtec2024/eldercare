# -*- coding: utf-8 -*-
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
admin_path = ROOT / "routes" / "admin.py"
prod = admin_path.read_text(encoding="utf-8")
if "@admin_bp.route('/ip-blocks'" in prod:
    print("already has ip-blocks")
    raise SystemExit(0)

stash = subprocess.check_output(
    ["git", "show", "stash@{0}:eldercare_backend/routes/admin.py"]
).decode("utf-8")
start = stash.find("@admin_bp.route('/ip-blocks', methods=['GET'])")
end = stash.find("def _admin_regions", start)
if start < 0 or end < 0:
    raise SystemExit("ip-blocks block not found in stash")
block = stash[start:end]
marker = "def _admin_regions(cursor, raw_admin_user_id):"
if marker not in prod:
    raise SystemExit("marker missing in production admin.py")
admin_path.write_text(prod.replace(marker, block + marker, 1), encoding="utf-8")
print("inserted", len(block), "chars; has Chinese=", "仅总管理员" in block)
