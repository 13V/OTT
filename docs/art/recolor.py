# Recolour an ink scene from navy and orange to the Raven Black and Poppy Red palette.
import sys
import numpy as np
from PIL import Image
src, dst, width = sys.argv[1], sys.argv[2], int(sys.argv[3])
im = Image.open(src).convert('RGB')
if im.width > width:
    im = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
hsv = np.asarray(im.convert('HSV')).astype(np.float32) / 255.0
h, s, v = hsv[..., 0], hsv[..., 1], hsv[..., 2]
def smooth(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)
# Orange and the warm browns lean to poppy red; the stronger the colour, the further it moves.
warm = (h > 0.0) & (h < 0.16)
w = smooth(0.30, 0.65, s) * warm
h2 = np.where(warm, h - (h - 0.004) * (0.85 * w + 0.25 * (1 - w) * smooth(0.15, 0.35, s)), h)
s2 = np.where(warm, np.minimum(1.0, s * (1 + 0.08 * w)), s)
# The navy ground and blue shadows turn to a warm black.
blue = (h > 0.48) & (h < 0.75)
dark = 1 - smooth(0.25, 0.55, v)
h2 = np.where(blue, h2 * (1 - dark) + 0.0 * dark, h2)
s2 = np.where(blue, s2 * (1 - 0.82 * dark), s2)
# Deepen the darks so the ground meets #080202 while the lights keep their value.
v2 = v * (0.42 + 0.58 * smooth(0.06, 0.5, v))
out = np.stack([np.mod(h2, 1.0), s2, v2], axis=-1)
img = Image.fromarray((out * 255).round().astype(np.uint8), 'HSV').convert('RGB')
# The deepest blacks take Raven Black's warmth (#080202), so a scene meets the page without a seam.
rgb = np.asarray(img).astype(np.float32)
lum = (0.2126 * rgb[..., 0] + 0.7152 * rgb[..., 1] + 0.0722 * rgb[..., 2]) / 255.0
d = (1 - smooth(0.02, 0.14, lum))[..., None] * 0.75
rgb = rgb * (1 - d) + np.array([8.0, 2.0, 2.0]) * d
img = Image.fromarray(rgb.clip(0, 255).round().astype(np.uint8), 'RGB')
img.save(dst, 'WEBP', quality=int(sys.argv[4]) if len(sys.argv) > 4 else 74, method=6)
print(dst.rsplit('/', 1)[-1], img.size)
