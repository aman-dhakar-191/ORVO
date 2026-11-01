"""The ORVO logo: a ring broken at the upper right by an orbiting dot, on an indigo tile."""
import math

C = 512            # centre of the 1024 canvas
R = 250            # ring radius
W = 112            # ring stroke width
DOT_ANGLE = -45    # degrees, SVG coords (y down): upper right
DOT_R = 64
GAP = 37           # degrees on each side of the dot where the ring stops (before the round cap)

INDIGO_TOP = '#7C6CFF'
INDIGO_MID = '#5B3DF5'
INDIGO_BOTTOM = '#2B1689'
MINT = '#6EF2D8'

def pt(angle, r=R, cx=C, cy=C):
    a = math.radians(angle)
    return cx + r * math.cos(a), cy + r * math.sin(a)

def ring_path():
    # Arc from just after the gap, clockwise (increasing angle in SVG), round to just before it.
    start = DOT_ANGLE + GAP
    end = DOT_ANGLE - GAP + 360
    x1, y1 = pt(start); x2, y2 = pt(end)
    return f'M{x1:.2f} {y1:.2f}A{R} {R} 0 1 1 {x2:.2f} {y2:.2f}'

def mark(ring='#fff', dot=MINT, scale=1.0, tx=0, ty=0):
    dx, dy = pt(DOT_ANGLE)
    return (f'<g transform="translate({tx} {ty}) scale({scale})">'
            f'<path d="{ring_path()}" fill="none" stroke="{ring}" stroke-width="{W}" stroke-linecap="round"/>'
            f'<circle cx="{dx:.2f}" cy="{dy:.2f}" r="{DOT_R}" fill="{dot}"/></g>')

def defs():
    return (f'<defs>'
            f'<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">'
            f'<stop offset="0" stop-color="{INDIGO_TOP}"/><stop offset=".5" stop-color="{INDIGO_MID}"/><stop offset="1" stop-color="{INDIGO_BOTTOM}"/></linearGradient>'
            f'<radialGradient id="glow" cx=".28" cy=".2" r=".75">'
            f'<stop offset="0" stop-color="#fff" stop-opacity=".28"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>'
            f'<filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="14" stdDeviation="18" flood-color="#000" flood-opacity=".28"/></filter>'
            f'</defs>')

def tile(x, y, size, rx):
    return (f'<rect x="{x}" y="{y}" width="{size}" height="{size}" rx="{rx}" fill="url(#bg)"/>'
            f'<rect x="{x}" y="{y}" width="{size}" height="{size}" rx="{rx}" fill="url(#glow)"/>')

def app_icon(padding=24, mac=False):
    """Full colour app icon on a 1024 canvas. mac=True follows the macOS grid (824 tile + shadow)."""
    if mac:
        x, size, rx = 100, 824, 185
        body = f'<g filter="url(#shadow)">{tile(x, x, size, rx)}</g>'
        s = size / 1024
        return svg(defs() + body + mark(scale=s * 0.92, tx=x + size * 0.04, ty=x + size * 0.04))
    size = 1024 - 2 * padding
    rx = round(size * 0.225)
    s = size / 1024
    return svg(defs() + tile(padding, padding, size, rx) + mark(scale=s, tx=padding, ty=padding))

def mono(color, opacity=None):
    """Single colour mark (no tile), for the empty editor letterpress, on a 260 canvas like the original."""
    op = f' opacity="{opacity}"' if opacity is not None else ''
    s = 260 / 1024
    return (f'<svg width="260" height="260" viewBox="0 0 260 260"{op} xmlns="http://www.w3.org/2000/svg">'
            + mark(ring=color, dot=color, scale=s) + '</svg>\n')

def svg(inner, w=1024, h=1024):
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">{inner}</svg>\n'
