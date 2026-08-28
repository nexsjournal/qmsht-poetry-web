#!/usr/bin/env python3
"""一次性素材管线 v2：把 imagegen 生成的「4 格步行序列条」处理成
透明底、脚底对齐、统一高度的 4 帧步行精灵（入库后运行时不再处理）。

输入：imagegen/ 下 4 张 1024x512 青底 4 格序列条（按文件名排序 = 角色序）
输出：assets/pedestrians/ped{i}_f{j}.png（RGBA，高 96px，脚底贴底边，i=1..4 角色，j=0..3 帧）

步骤：整条 1024x512 一次处理：
  1) 背景参考色 = 条带边缘采样中位数（青底，含噪声）
  2) 逐像素距离 → 软 alpha
  3) 连通块分析：取 4 个人物主体（含跨格的拖曳裙裾），按 x 排序
  4) 各自裁剪到包围盒（脚底=底边），统一缩放到 96px 高
  5) 轻微降饱和贴近绢色
"""

import os
import sys
import glob
from collections import deque

from PIL import Image, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_DIR = os.path.join(ROOT, "imagegen")
OUT_DIR = os.path.join(ROOT, "assets", "pedestrians")

OUT_H = 96            # 精灵高度（页面显示约 24px）
SILK = (233, 220, 194)
ALPHA_LO = 30         # 距背景色 < 30 → 透明
ALPHA_HI = 90         # 距背景色 > 90 → 不透明（淡彩人物与青底色差大）
MIN_AREA = 4000       # 人物连通块最小面积（px）


def dist(a, b):
    return ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2) ** 0.5


def edge_reference(panel):
    """取格子四周像素的中位数颜色作为背景参考。"""
    w, h = panel.size
    px = panel.load()
    cols = []
    for x in range(w):
        cols.append(px[x, 2])
        cols.append(px[x, h - 3])
    for y in range(h):
        cols.append(px[2, y])
        cols.append(px[w - 3, y])
    cols.sort()
    return cols[len(cols) // 2]


def alpha_map(img, ref):
    w, h = img.size
    px = img.load()
    out = [[0.0] * w for _ in range(h)]
    for y in range(h):
        row = out[y]
        for x in range(w):
            r, g, b = px[x, y][:3]
            d = ((r - ref[0]) ** 2 + (g - ref[1]) ** 2 + (b - ref[2]) ** 2) ** 0.5
            if d <= ALPHA_LO:
                row[x] = 0.0
            elif d >= ALPHA_HI:
                row[x] = 1.0
            else:
                row[x] = (d - ALPHA_LO) / (ALPHA_HI - ALPHA_LO)
    return out


def desaturate_toward_silk(rgb):
    r, g, b = rgb
    mx, mn = max(r, g, b), min(r, g, b)
    if mx == 0:
        return (0, 0, 0)
    sat = (mx - mn) / mx
    f = (sat * 0.85) / max(sat, 1e-6)  # 轻度降饱和
    lum = 0.299 * r + 0.587 * g + 0.114 * b
    vals = [
        int(round((lum + (v - lum) * f) * 0.93 + SILK[i] * 0.07))
        for i, v in enumerate((r, g, b))
    ]
    return tuple(min(255, max(0, v)) for v in vals)


def erase_dividers(strip, alpha):
    """擦除 4 格之间的黑色分格线：找每个四分点附近「最长竖直暗色游程」的列，
    仅清除该列 ±1 内的暗像素（保留裙裾等亮色人物像素）。"""
    w, h = strip.size
    px = strip.load()
    for bx in (w // 4, w // 2, 3 * w // 4):
        best_x, best_run = None, 0
        for x in range(bx - 12, bx + 13):
            run = col = 0
            for y in range(h):
                r, g, b = px[x, y][:3]
                lum = 0.299 * r + 0.587 * g + 0.114 * b
                if lum < 110:
                    run += 1
                    col = max(col, run)
                else:
                    run = 0
            if col > best_run:
                best_run, best_x = col, x
        if best_x is None or best_run < 150:
            print(f"  ?? 分格线未找到 (x≈{bx}, 最长暗游程 {best_run})")
            continue
        for x in (best_x - 1, best_x, best_x + 1):
            for y in range(h):
                r, g, b = px[x, y][:3]
                if 0.299 * r + 0.587 * g + 0.114 * b < 120:
                    alpha[y][x] = 0.0


def all_components(alpha, w, h, min_area):
    """返回所有 ≥min_area 的连通块 [(x0,y0,x1,y1,points)]，按 x0 排序。"""
    seen = [[False] * w for _ in range(h)]
    coms = []
    for sy in range(h):
        for sx in range(w):
            if seen[sy][sx] or alpha[sy][sx] < 0.5:
                continue
            q = deque([(sx, sy)])
            seen[sy][sx] = True
            pts = []
            while q:
                x, y = q.popleft()
                pts.append((x, y))
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < w and 0 <= ny < h and not seen[ny][nx] and alpha[ny][nx] >= 0.5:
                        seen[ny][nx] = True
                        q.append((nx, ny))
            if len(pts) >= min_area:
                xs = [p[0] for p in pts]
                ys = [p[1] for p in pts]
                coms.append((min(xs), min(ys), max(xs) + 1, max(ys) + 1, pts))
    coms.sort(key=lambda c: c[0])
    return coms


def process_component(strip, alpha, comp, dst):
    """把一个连通块（人物，可含跨格裙裾）裁成统一高度的精灵。"""
    x0, y0, x1, y1, pts = comp
    w, h = strip.size
    if x0 <= 1 or x1 >= w - 1:
        print(f"  !! 人物贴条带边缘 (x0={x0}, x1={x1}, w={w})，可能被截断")
    crop = strip.crop((x0, y0, x1, y1))
    cw, ch = crop.size
    px = crop.load()
    comp_rel = {(x - x0, y - y0) for (x, y) in pts}

    rgba = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
    apx = rgba.load()
    for y in range(ch):
        for x in range(cw):
            a = alpha[y0 + y][x0 + x]
            if (x, y) in comp_rel and a > 0:
                r, g, b = desaturate_toward_silk(px[x, y][:3])
                apx[x, y] = (r, g, b, int(round(a * 255)))
    # 边缘羽化
    a_layer = rgba.getchannel("A").filter(ImageFilter.GaussianBlur(1.0))
    rgba = Image.merge("RGBA", (rgba.getchannel("R"), rgba.getchannel("G"),
                                rgba.getchannel("B"), a_layer))
    bbox = rgba.getbbox()
    if not bbox:
        return None
    rgba = rgba.crop(bbox)
    nw = max(8, round(rgba.width * OUT_H / rgba.height))
    rgba = rgba.resize((nw, OUT_H), Image.LANCZOS)
    rgba.save(dst, "PNG")
    return rgba.size


def process_strip(src, i):
    strip = Image.open(src).convert("RGBA")
    w, h = strip.size
    if w != 1024 or h != 512:
        print(f"  !! {src} 尺寸 {w}x{h} 非 1024x512，跳过")
        return False
    ref = edge_reference(strip)
    alpha = alpha_map(strip, ref)
    erase_dividers(strip, alpha)
    coms = all_components(alpha, w, h, MIN_AREA)
    if len(coms) != 4:
        print(f"  !! {os.path.basename(src)} 期望 4 个人物，实际 {len(coms)} 个连通块")
        for c in coms:
            print(f"     bbox x[{c[0]},{c[2]}] y[{c[1]},{c[3]}] area={len(c[4])}")
        return False
    ok = True
    for j, comp in enumerate(coms):
        dst = os.path.join(OUT_DIR, f"ped{i}_f{j}.png")
        size = process_component(strip, alpha, comp, dst)
        if size is None:
            print(f"  !! ped{i} 帧{j} 处理失败")
            ok = False
        else:
            print(f"  ped{i} 帧{j}: {size[0]}x{size[1]}  (源 bbox x[{comp[0]},{comp[2]}])")
    return ok


def main():
    # 4 张合格序列条（按文件名排序 = 角色序：书生/杖者/商人/仕女）
    names = [
        "2026-08-28-03-52-31-1.png",  # ped1 书生（折扇）
        "2026-08-28-03-39-52-1.png",  # ped2 杖者（竹杖）
        "2026-08-28-03-40-04-1.png",  # ped3 商人（包袱）
        "2026-08-28-03-51-16-1.png",  # ped4 仕女（襦裙）
    ]
    srcs = [os.path.join(SRC_DIR, n) for n in names]
    missing = [n for n in names if not os.path.exists(os.path.join(SRC_DIR, n))]
    if missing:
        sys.exit(f"缺少序列条: {missing}")
    os.makedirs(OUT_DIR, exist_ok=True)
    # 清掉旧单帧素材
    for f in glob.glob(os.path.join(OUT_DIR, "ped[1-4].png")):
        os.remove(f)
    all_ok = True
    for i, s in enumerate(srcs, 1):
        print(f"[{i}] {os.path.basename(s)}")
        all_ok &= process_strip(s, i)
    sys.exit(0 if all_ok else 1)


if __name__ == "__main__":
    main()
