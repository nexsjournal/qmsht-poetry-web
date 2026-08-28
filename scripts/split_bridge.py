#!/usr/bin/env python3
"""一次性素材管线：把 hongqiao-web.png 拆成
  - hongqiao-back.png  后层：桥身 + 栏杆以外的全部
  - hongqiao-front.png 前层：近侧栏杆带（扶手顶包络 → 桥面脚底线 +5px）
页面中 z-index：back(3) < 诗帘画布(2 之上) < front(5)。

脚底线（桥面顶板，已实测校准）：walkY(x) = 59 + 0.0004099·(x−600)²
前层上缘 = 每列首个不透明像素（栏杆/望柱顶包络）
仅 x∈[60,1140] 且该列栏杆高度 ≥6px 时生成前层。
"""

import os

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "assets", "hongqiao-web.png")
X0, X1 = 60, 1140
DECK_MARGIN = 5  # 脚底线以下再含 5px 桥面板前沿（盖住脚底边缘）


def walkY(x):
    return 59 + 0.0004099 * (x - 600) ** 2


def main():
    im = Image.open(SRC).convert("RGBA")
    w, h = im.size
    px = im.load()

    front = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    back = im.copy()
    fpx = front.load()
    bpx = back.load()

    n = 0
    for x in range(X0, X1 + 1):
        top = None
        for y in range(0, min(h, 220)):
            if px[x, y][3] > 10:
                top = y
                break
        wy = walkY(x)
        if top is None or wy - top < 6:
            continue
        for y in range(top, min(h, int(wy) + DECK_MARGIN)):
            a = px[x, y][3]
            if a == 0:
                continue
            r, g, b = px[x, y][:3]
            fpx[x, y] = (r, g, b, a)
            bpx[x, y] = (0, 0, 0, 0)
            n += 1

    front.save(os.path.join(ROOT, "assets", "hongqiao-front.png"), "PNG")
    back.save(os.path.join(ROOT, "assets", "hongqiao-back.png"), "PNG")
    print(f"拆分完成：前层 {n} 像素")

    # 自检：back + front 合成应与原图一致
    comp = back.copy()
    comp.alpha_composite(front)
    import hashlib

    def sig(im):
        return hashlib.md5(im.tobytes()).hexdigest()[:8]

    print("原图签名", sig(im), "合成签名", sig(comp),
          "一致" if sig(im) == sig(comp) else "!! 不一致")


if __name__ == "__main__":
    main()
