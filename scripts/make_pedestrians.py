#!/usr/bin/env python3
"""一次性素材管线：把 imagegen 生成的青底宋代行人图处理成
透明底、脚底对齐、统一高度的 PNG 精灵（入库后运行时不再处理）。

用法：python3 scripts/make_pedestrians.py
输入：imagegen/ 下按时间排序的 4 张 512x1024 原图
输出：assets/pedestrians/ped1..4.png（RGBA，高 96px，脚底贴底边）
"""

import os
import sys

from PIL import Image, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_GLOB_DIR = os.path.join(ROOT, "imagegen")
OUT_DIR = os.path.join(ROOT, "assets", "pedestrians")

OUT_H = 96          # 精灵高度（页面显示约 24px，留 4x 余量）
SILK = (233, 220, 194)  # 页面绢色
ALPHA_LO = 18       # 距背景色 < 18 → 完全透明
ALPHA_HI = 60       # 距背景色 > 60 → 完全不透明


def border_samples(img, n=400):
    """沿四边采样背景色（跳过四角 40px，避开人物落笔）。"""
    w, h = img.size
    px = img.load()
    pts = []
    for i in range(n):
        t = i / n * (w - 80) + 40
        pts.append((int(t), 3))
        pts.append((int(t), h - 4))
        t2 = i / n * (h - 80) + 40
        pts.append((3, int(t2)))
        pts.append((w - 4, int(t2)))
    samples = [px[x, y] for x, y in pts]
    return samples


def two_ref_colors(samples):
    """从边框样本里取「主背景色」与「最大偏离色」两个参考（青色底 + 米色斑驳）。"""
    def mean(cols):
        k = len(cols)
        return tuple(sum(c[i] for c in cols) // k for i in range(3))

    primary = mean(samples)
    # 与 primary 距离 > 45 的样本视为斑驳带
    outliers = [s for s in samples if dist(s, primary) > 45]
    secondary = mean(outliers) if outliers else primary
    return primary, secondary


def dist(a, b):
    return ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2) ** 0.5


def alpha_map(img, refs):
    """逐像素：距最近背景参考色 → 0..1 alpha（远=不透明）。"""
    w, h = img.size
    px = img.load()
    out = [[0.0] * w for _ in range(h)]
    for y in range(h):
        row = out[y]
        for x in range(w):
            d = min(dist(px[x, y], r) for r in refs)
            if d <= ALPHA_LO:
                row[x] = 0.0
            elif d >= ALPHA_HI:
                row[x] = 1.0
            else:
                row[x] = (d - ALPHA_LO) / (ALPHA_HI - ALPHA_LO)
    return out


def largest_component(alpha, w, h):
    """保留与人物相连的最大连通块，丢弃残留背景斑点。BFS（4 邻域）。"""
    best = None
    best_n = 0
    seen = [[False] * w for _ in range(h)]
    from collections import deque

    for sy in range(h):
        for sx in range(w):
            if seen[sy][sx] or alpha[sy][sx] < 0.5:
                continue
            q = deque([(sx, sy)])
            seen[sy][sx] = True
            comp = []
            while q:
                x, y = q.popleft()
                comp.append((x, y))
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < w and 0 <= ny < h and not seen[ny][nx] and alpha[ny][nx] >= 0.5:
                        seen[ny][nx] = True
                        q.append((nx, ny))
            if len(comp) > best_n:
                best_n = len(comp)
                best = set(comp)
    return best


def desaturate_toward_silk(rgb):
    """降饱和 + 轻混绢色，贴近页面色调。"""
    r, g, b = rgb
    mx, mn = max(r, g, b), min(r, g, b)
    if mx:
        sat = (mx - mn) / mx
        new_sat = sat * 0.72
        lum = 0.299 * r + 0.587 * g + 0.114 * b
        # 向 (lum,lum,lum) 收缩后再混 12% 绢色
        f = new_sat / max(sat, 1e-6)
        vals = [
            int(round((lum + (v - lum) * f) * 0.88 + SILK[i] * 0.12))
            for i, v in enumerate((r, g, b))
        ]
        return tuple(min(255, max(0, v)) for v in vals)
    return (r, g, b)


def process(src, dst):
    img = Image.open(src).convert("RGB")
    w, h = img.size
    refs = two_ref_colors(border_samples(img))
    alpha = alpha_map(img, refs)
    comp = largest_component(alpha, w, h)
    if comp is None:
        raise RuntimeError(f"{src}: 未找到人物主体")

    # 裁剪到主体包围盒
    xs = [p[0] for p in comp]
    ys = [p[1] for p in comp]
    x0, x1, y0, y1 = min(xs), max(xs) + 1, min(ys), max(ys) + 1

    crop = img.crop((x0, y0, x1, y1))
    cw, ch = crop.size
    px = crop.load()
    comp_rel = {(x - x0, y - y0) for (x, y) in comp}

    rgba = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
    apx = rgba.load()
    for y in range(ch):
        for x in range(cw):
            a = alpha[y0 + y][x0 + x]
            if (x, y) in comp_rel and a > 0:
                r, g, b = desaturate_toward_silk(px[x, y])
                apx[x, y] = (r, g, b, int(round(a * 255)))
    # 丢弃最大连通块之外仍半透明的像素（斑驳残留）
    # alpha 边缘羽化
    a_layer = rgba.getchannel("A")
    a_layer = a_layer.filter(ImageFilter.GaussianBlur(1.0))
    rgba = Image.merge("RGBA", (rgba.getchannel("R"), rgba.getchannel("G"),
                                rgba.getchannel("B"), a_layer))

    # 再裁一次（羽化后透明边），脚底贴底边
    bbox = rgba.getbbox()
    if not bbox:
        raise RuntimeError(f"{src}: 主体丢失")
    rgba = rgba.crop(bbox)

    # 统一高度
    nw = max(8, round(rgba.width * OUT_H / rgba.height))
    rgba = rgba.resize((nw, OUT_H), Image.LANCZOS)
    os.makedirs(OUT_DIR, exist_ok=True)
    rgba.save(dst, "PNG")
    print(f"{os.path.basename(src)} -> {os.path.relpath(dst, ROOT)}  {rgba.size}")


def main():
    import glob

    srcs = sorted(glob.glob(os.path.join(SRC_GLOB_DIR, "2026-08-28-02-56-*.png")))
    if len(srcs) < 4:
        sys.exit(f"需要 4 张原图，实际 {len(srcs)}: {srcs}")
    for i, s in enumerate(srcs[:4], 1):
        process(s, os.path.join(OUT_DIR, f"ped{i}.png"))


if __name__ == "__main__":
    main()
