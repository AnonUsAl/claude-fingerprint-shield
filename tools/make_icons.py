#!/usr/bin/env python3
"""生成扩展图标：圆角矩形渐变底 + 白色盾牌 + 蓝色对勾。
纯标准库实现（zlib + struct），不依赖 Pillow。
用法： python3 tools/make_icons.py
"""
import math
import os
import struct
import zlib

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "icons")
SIZES = [16, 32, 48, 128]

TOP = (29, 78, 216)      # #1D4ED8
BOTTOM = (59, 130, 246)  # #3B82F6
MARK = (29, 78, 216)
WHITE = (255, 255, 255)


def lerp(a, b, t):
    return a + (b - a) * t


def in_rounded_rect(x, y, radius):
    if x < 0 or x > 1 or y < 0 or y > 1:
        return False
    cx = min(max(x, radius), 1 - radius)
    cy = min(max(y, radius), 1 - radius)
    dx = x - cx
    dy = y - cy
    return dx * dx + dy * dy <= radius * radius


def in_shield(x, y):
    top, bottom = 0.155, 0.862
    if y < top or y > bottom:
        return False
    t = (y - top) / (bottom - top)
    half = 0.302 * math.sqrt(max(0.0, 1.0 - t ** 2.4)) + 0.030
    return abs(x - 0.5) <= half


def dist_to_segment(px, py, ax, ay, bx, by):
    vx, vy = bx - ax, by - ay
    wx, wy = px - ax, py - ay
    seg = vx * vx + vy * vy
    t = 0.0 if seg == 0 else max(0.0, min(1.0, (wx * vx + wy * vy) / seg))
    dx = px - (ax + t * vx)
    dy = py - (ay + t * vy)
    return math.hypot(dx, dy)


CHECK_A = (0.325, 0.505)
CHECK_B = (0.452, 0.635)
CHECK_C = (0.688, 0.372)
CHECK_HALF = 0.041


def in_check(x, y):
    return (dist_to_segment(x, y, *CHECK_A, *CHECK_B) <= CHECK_HALF or
            dist_to_segment(x, y, *CHECK_B, *CHECK_C) <= CHECK_HALF)


def sample(x, y):
    """返回 (r, g, b, alpha)，alpha ∈ [0,1]。"""
    if not in_rounded_rect(x, y, 0.225):
        return (0, 0, 0, 0.0)
    r = lerp(TOP[0], BOTTOM[0], y)
    g = lerp(TOP[1], BOTTOM[1], y)
    b = lerp(TOP[2], BOTTOM[2], y)
    if in_shield(x, y):
        if in_check(x, y):
            r, g, b = MARK
        else:
            r, g, b = WHITE
    return (r, g, b, 1.0)


def render(size, ss):
    n = size * ss
    rows = []
    for py in range(size):
        row = []
        for px in range(size):
            rs = gs = bs = asum = 0.0
            for sy in range(ss):
                for sx in range(ss):
                    x = (px + (sx + 0.5) / ss) / size
                    y = (py + (sy + 0.5) / ss) / size
                    r, g, b, a = sample(x, y)
                    rs += r * a
                    gs += g * a
                    bs += b * a
                    asum += a
            total = ss * ss
            if asum > 0:
                cr = int(round(rs / asum))
                cg = int(round(gs / asum))
                cb = int(round(bs / asum))
            else:
                cr = cg = cb = 0
            ca = int(round(asum / total * 255))
            row.append((min(255, cr), min(255, cg), min(255, cb), ca))
        rows.append(row)
    return rows


def write_png(path, rows):
    h = len(rows)
    w = len(rows[0])
    raw = bytearray()
    for row in rows:
        raw.append(0)
        for px in row:
            raw.extend(px)

    def chunk(kind, data):
        return (struct.pack(">I", len(data)) + kind + data +
                struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF))

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in SIZES:
        ss = 4 if size <= 48 else 3
        rows = render(size, ss)
        path = os.path.normpath(os.path.join(OUT_DIR, "icon%d.png" % size))
        write_png(path, rows)
        print("wrote", path)


if __name__ == "__main__":
    main()
