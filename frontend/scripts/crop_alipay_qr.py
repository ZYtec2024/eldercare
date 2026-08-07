from pathlib import Path

from PIL import Image

wx_path = Path(r'c:\Users\86191\eldercare\frontend\public\donate\wechat-qr.png')
ali_path = Path(r'c:\Users\86191\eldercare\frontend\public\donate\alipay-qr.png')
out_path = Path(r'c:\Users\86191\eldercare\frontend\public\donate\alipay-qr.png')

wx = Image.open(wx_path).convert('RGB')
ali = Image.open(ali_path).convert('RGB')
print('wechat', wx.size)
print('alipay before', ali.size)

w, h = ali.size


def row_kind(y: int) -> str:
    step = max(1, w // 50)
    row = [ali.getpixel((x, y)) for x in range(0, w, step)]
    r = sum(c[0] for c in row) / len(row)
    g = sum(c[1] for c in row) / len(row)
    b = sum(c[2] for c in row) / len(row)
    if r > 220 and g > 220 and b > 220:
        return 'white'
    if b > r + 25 and b > g + 15 and b > 120:
        return 'blue'
    return 'other'


# Top white Alipay header ends when we hit blue background.
crop_top = 0
for y in range(0, min(h, int(h * 0.35))):
    kind = row_kind(y)
    if kind == 'blue':
        crop_top = y
        break

# Keep a tiny bit of blue above the slogan area? User asked to cut the top Alipay strip.
# Crop from first blue row (removes white header with 支付宝 logo).
print('crop_top', crop_top)

cropped = ali.crop((0, crop_top, w, h))
print('alipay after crop', cropped.size)

# Match displayed footprint to WeChat: same width, proportional height scaled to wechat width.
target_w = wx.size[0]
scale = target_w / cropped.size[0]
target_h = max(1, int(cropped.size[1] * scale))
resized = cropped.resize((target_w, target_h), Image.Resampling.LANCZOS)
print('alipay resized', resized.size, 'wechat', wx.size)

resized.save(out_path, format='PNG', optimize=True)
print('saved', out_path)
