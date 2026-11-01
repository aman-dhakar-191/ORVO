"""Generates every ORVO icon and installer image from the logo in logo.py.

Requires Python 3 with Pillow, and Node.js with the repo's Playwright (Chromium renders the SVGs):
run `npx playwright install chromium` first, or point ORVO_CHROMIUM at a Chromium executable.

    python3 build/branding/generate.py

Writes into resources/ and src/ of this repository, plus resources/branding/orvo.svg (the master logo).
"""
import os, shutil, subprocess, sys, tempfile
from PIL import Image

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import logo

REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
OUT = tempfile.mkdtemp(prefix='orvo-branding-')

# Renders an SVG file to a PNG of exactly w x h with Chromium, so small sizes are drawn, not downscaled.
RENDER_JS = """
const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
	const [inp, out, w, h, bg] = process.argv.slice(1);
	const browser = await chromium.launch({ executablePath: process.env.ORVO_CHROMIUM || undefined });
	const page = await browser.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: 1 });
	const svg = fs.readFileSync(inp, 'utf8').replace(/width="[^"]+" height="[^"]+" viewBox/, `width="${w}" height="${h}" viewBox`);
	await page.setContent(`<html><body style="margin:0;background:${bg || 'transparent'}">${svg}</body></html>`);
	await page.screenshot({ path: out, omitBackground: !bg, clip: { x: 0, y: 0, width: +w, height: +h } });
	await browser.close();
})();
"""

def render(svg_text, name, w, h, bg=None):
    p = f'{OUT}/{name}.svg'
    with open(p, 'w') as f:
        f.write(svg_text)
    png = f'{OUT}/{name}-{w}x{h}.png'
    subprocess.run(['node', '-e', RENDER_JS, p, png, str(w), str(h)] + ([bg] if bg else []), check=True)
    return Image.open(png).convert('RGBA')

app = logo.app_icon(padding=24)
app_padded = logo.app_icon(padding=64)   # Linux / web: icon themes expect some breathing room
mac = logo.app_icon(mac=True)
open(f'{REPO}/resources/branding/orvo.svg', 'w').write(app)

def save_ico(svg_text, name, sizes, path):
    imgs = [render(svg_text, name, s, s) for s in sizes]
    imgs[-1].save(path, format='ICO', sizes=[(s, s) for s in sizes], append_images=imgs[:-1])

# Windows app icon and web favicon
save_ico(app, 'app', [16, 20, 24, 32, 40, 48, 64, 128, 256], f'{REPO}/resources/win32/code.ico')
save_ico(app, 'app', [16, 24, 32, 48, 64], f'{REPO}/resources/server/favicon.ico')

# Linux and web app icons
render(app_padded, 'app-padded', 1024, 1024).save(f'{REPO}/resources/linux/code.png', optimize=True)
render(app_padded, 'app-padded', 192, 192).save(f'{REPO}/resources/server/code-192.png', optimize=True)
render(app_padded, 'app-padded', 512, 512).save(f'{REPO}/resources/server/code-512.png', optimize=True)

# macOS
render(mac, 'mac', 1024, 1024).save(f'{REPO}/resources/darwin/code.icns', format='ICNS')

# Windows Start menu tiles: transparent mark, the tile colour comes from VisualElementsManifest.xml.
# The 150 tile shows the name at the bottom, so the mark sits a little higher.
for size, scale, lift in ((70, 0.62, 0), (150, 0.5, 0.06)):
    s = scale
    off = (1 - s) / 2 * 1024
    tile = logo.svg(logo.mark(scale=s, tx=off, ty=off - lift * 1024))
    render(tile, f'tile{size}', size, size).save(f'{REPO}/resources/win32/code_{size}x{size}.png', optimize=True)

# Installer artwork. Big: welcome/finish page sidebar. Small: header of the inner pages (white).
BIG = {100: (164, 314), 125: (192, 386), 150: (246, 459), 175: (273, 556), 200: (328, 604), 225: (355, 700), 250: (410, 797)}
SMALL = {100: (55, 55), 125: (64, 68), 150: (83, 80), 175: (92, 97), 200: (110, 106), 225: (119, 123), 250: (138, 140)}
for pct, (w, h) in BIG.items():
    k = pct / 100
    mark_size = 96 * k
    mx, my = (w - mark_size) / 2, h * 0.30 - mark_size / 2
    sc = mark_size / 1024
    text_y = my + mark_size + 46 * k
    inner = (f'<defs><linearGradient id="v" x1="0" y1="0" x2=".35" y2="1">'
             f'<stop offset="0" stop-color="{logo.INDIGO_TOP}"/><stop offset=".55" stop-color="{logo.INDIGO_MID}"/><stop offset="1" stop-color="{logo.INDIGO_BOTTOM}"/></linearGradient>'
             f'<radialGradient id="g" cx=".2" cy=".1" r=".9"><stop offset="0" stop-color="#fff" stop-opacity=".22"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient></defs>'
             f'<rect width="{w}" height="{h}" fill="url(#v)"/><rect width="{w}" height="{h}" fill="url(#g)"/>'
             # faint large orbit in the background
             f'<circle cx="{w * 0.5}" cy="{h * 0.30}" r="{w * 0.62}" fill="none" stroke="#fff" stroke-opacity=".07" stroke-width="{3 * k}"/>'
             f'<circle cx="{w * 0.5}" cy="{h * 0.30}" r="{w * 0.95}" fill="none" stroke="#fff" stroke-opacity=".05" stroke-width="{3 * k}"/>'
             + logo.mark(scale=sc, tx=mx, ty=my) +
             f'<text x="{w / 2}" y="{text_y}" text-anchor="middle" fill="#fff" font-family="Inter Display, Inter, sans-serif" font-weight="700" font-size="{30 * k}" letter-spacing="{6 * k}">ORVO</text>')
    render(logo.svg(inner, w, h), f'big{pct}', w, h, bg='#ffffff').convert('RGB').save(f'{REPO}/resources/win32/inno-big-{pct}.bmp')
for pct, (w, h) in SMALL.items():
    side = min(w, h) * 0.86
    sc = side / 1024
    inner = f'<rect width="{w}" height="{h}" fill="#fff"/><g transform="translate({(w - side) / 2} {(h - side) / 2}) scale({sc})">' + app.split('>', 1)[1].rsplit('</svg>', 1)[0] + '</g>'
    render(logo.svg(inner, w, h), f'small{pct}', w, h, bg='#ffffff').convert('RGB').save(f'{REPO}/resources/win32/inno-small-{pct}.bmp')

# In-product SVGs
shutil.copy(f'{REPO}/resources/branding/orvo.svg', f'{REPO}/src/vs/workbench/browser/media/code-icon.svg')
media = f'{REPO}/src/vs/workbench/browser/parts/editor/media'
open(f'{media}/letterpress-dark.svg', 'w').write(logo.mono('#000', 0.3))
open(f'{media}/letterpress-light.svg', 'w').write(logo.mono('#000', 0.1))
open(f'{media}/letterpress-hcDark.svg', 'w').write(logo.mono('#3C3C3C'))
open(f'{media}/letterpress-hcLight.svg', 'w').write(logo.mono('#D9D9D9'))
shutil.rmtree(OUT)
print('done')
