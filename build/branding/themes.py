"""Generates the ORVO Dark and ORVO Light colour themes (the defaults) from VS Code's 2026 themes.

The ORVO themes include the 2026 themes and only override their blue accent colours, moved to the ORVO indigo
from logo.py. Syntax colours, backgrounds and colours that carry meaning (git, diff, charts, terminal ANSI, info and
validation) are kept. Text and button colours are adjusted until they reach WCAG AA contrast (4.5:1).

    python3 build/branding/themes.py
"""
import colorsys, json, os, re, sys

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import logo

REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
THEMES = os.path.join(REPO, 'extensions', 'theme-defaults', 'themes')

# Colour keys left as they are: their blue means something other than "accent".
KEEP_PREFIXES = ('charts.', 'terminal.ansi', 'inputValidation.info', 'notificationsInfoIcon', 'editorGutter.',
                 'editorOverviewRuler.', 'gitDecoration.', 'diffEditor.', 'editorInfo.', 'minimapGutter.')
# Colours shown as text, or as a background behind white text, that must stay readable.
TEXT_KEYS = ('textLink.foreground', 'textLink.activeForeground', 'editorLink.activeForeground', 'notificationLink.foreground')
BUTTON_KEYS = ('button.background', 'button.hoverBackground', 'extensionButton.prominentBackground',
               'extensionButton.prominentHoverBackground', 'badge.background', 'activityBarBadge.background',
               'statusBarItem.remoteBackground')


def jsonc(path):
    """Parses JSON with comments and trailing commas, leaving // inside strings alone."""
    s, out, i, in_string = open(path).read(), [], 0, False
    while i < len(s):
        c = s[i]
        if in_string:
            out.append(c)
            if c == '\\':
                out.append(s[i + 1]); i += 2; continue
            in_string = c != '"'
        elif c == '"':
            in_string = True; out.append(c)
        elif s.startswith('//', i):
            i = s.find('\n', i); i = len(s) if i < 0 else i; continue
        elif s.startswith('/*', i):
            i = s.index('*/', i) + 2; continue
        else:
            out.append(c)
        i += 1
    return json.loads(re.sub(r',(\s*[}\]])', r'\1', ''.join(out)))


def resolve(name):
    data = jsonc(os.path.join(THEMES, name))
    colors = resolve(os.path.basename(data['include'])) if data.get('include') else {}
    colors.update(data.get('colors', {}))
    return colors


def parse(hex_color):
    h = hex_color.lstrip('#')
    return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)), h[6:8]


def fmt(rgb, alpha=''):
    return '#' + ''.join(f'{round(max(0, min(1, v)) * 255):02X}' for v in rgb) + alpha.upper()


def luminance(rgb):
    lin = [v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4 for v in rgb]
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]


def contrast(a, b):
    la, lb = sorted((luminance(a), luminance(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


def is_accent(key, value):
    if not isinstance(value, str) or not re.fullmatch(r'#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?', value) or key.startswith(KEEP_PREFIXES):
        return False
    h, l, s = colorsys.rgb_to_hls(*parse(value)[0])
    return 185 <= h * 360 <= 225 and s > 0.3


def link_color(brand, background, text):
    """The brand-hue colour nearest the logo lightness that is readable on the background (4.5:1) and still stands
    out from body text (3:1), the same rules the default theme tests check; readability alone if both can't be met."""
    h, l, s = colorsys.rgb_to_hls(*brand)
    candidates = [colorsys.hls_to_rgb(h, i / 400, s) for i in range(401)]
    for rules in ((4.5, 3), (4.5, 0)):
        ok = [c for c in candidates if contrast(c, background) >= rules[0] and contrast(c, text) >= rules[1]]
        if ok:
            return min(ok, key=lambda c: abs(colorsys.rgb_to_hls(*c)[1] - l))
    return brand


def readable(rgb, against, lighter):
    """Moves the lightness until the colour reaches 4.5:1 against `against`."""
    h, l, s = colorsys.rgb_to_hls(*rgb)
    while contrast(colorsys.hls_to_rgb(h, l, s), against) < 4.5 and 0 < l < 1:
        l += 0.01 if lighter else -0.01
    return colorsys.hls_to_rgb(h, l, s)


def generate(base, name, dark):
    colors = resolve(base)
    brand = parse(logo.INDIGO_MID)[0]
    brand_h, brand_l, brand_s = colorsys.rgb_to_hls(*brand)
    background = parse(colors.get('editor.background', '#1F1F1F' if dark else '#FFFFFF'))[0]
    foreground = parse(colors.get('foreground', '#CCCCCC' if dark else '#3B3B3B'))[0]
    overrides = {}
    for key, value in colors.items():
        if not is_accent(key, value):
            continue
        rgb, alpha = parse(value)
        h, l, s = colorsys.rgb_to_hls(*rgb)
        if key in BUTTON_KEYS and not alpha:
            # Filled accents use the logo indigo itself (hover a step darker), darkened only if white text needs it
            step = -0.07 if 'hover' in key.lower() else 0
            rgb = readable(colorsys.hls_to_rgb(brand_h, brand_l + step, brand_s), (1, 1, 1), lighter=False)
        elif key in TEXT_KEYS:
            # Links start from the logo indigo and move just far enough to be readable on the editor background
            rgb = link_color(brand, background, foreground)
        elif key in ('focusBorder', 'progressBar.background') or key.endswith('activeBorder') or key.endswith('activeBorderTop'):
            rgb = brand
        else:
            # Everything else keeps its lightness (and alpha) and takes the brand hue, no more saturated than the logo
            rgb = colorsys.hls_to_rgb(brand_h, l, min(s, brand_s))
        overrides[key] = fmt(rgb, alpha)
    theme = {
        '$schema': 'vscode://schemas/color-theme',
        'name': name,
        'include': f'./{base}',
        'type': 'dark' if dark else 'light',
        'colors': dict(sorted(overrides.items())),
    }
    path = os.path.join(THEMES, f"orvo-{'dark' if dark else 'light'}.json")
    with open(path, 'w') as f:
        f.write(json.dumps(theme, indent='\t') + '\n')
    print(f'{name}: {len(overrides)} accent colours -> {os.path.relpath(path, REPO)}')


if __name__ == '__main__':
    generate('2026-dark.json', 'ORVO Dark', dark=True)
    generate('2026-light.json', 'ORVO Light', dark=False)
