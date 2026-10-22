"""Regenerate brand/assets (wordmark component, favicons, desktop icons) from a TTF.

Usage: python brand/generate.py Caladea-Regular.ttf   (needs fonttools + pillow)
Caladea is the open, metric-compatible substitute for Cambria.
"""
import sys
from pathlib import Path

from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw

FONT = sys.argv[1]
OUT = Path(__file__).parent / 'assets'
INK, PAPER = '#0f1115', '#ffffff'

font = TTFont(FONT)
cmap, glyphs, hmtx = font.getBestCmap(), font.getGlyphSet(), font['hmtx']


def outline(text: str):
    """Path data (y-down) for text, cropped to its ink box; returns (d, width, height)."""
    names = [cmap[ord(c)] for c in text]
    bounds = BoundsPen(glyphs)
    x = 0
    for n in names:
        glyphs[n].draw(TransformPen(bounds, (1, 0, 0, 1, x, 0)))
        x += hmtx[n][0]
    x0, y0, x1, y1 = bounds.bounds
    pen = SVGPathPen(glyphs, ntos=lambda v: f'{v:.0f}')
    x = 0
    for n in names:
        glyphs[n].draw(TransformPen(pen, (1, 0, 0, -1, x - x0, y1)))
        x += hmtx[n][0]
    return pen.getCommands(), round(x1 - x0), round(y1 - y0)


def write(path: str, data):
    target = OUT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(data, str):
        target.write_text(data)
    else:
        data.save(target)


word_d, word_w, word_h = outline('mumbo')
m_d, m_w, m_h = outline('m')

write('packages/client/ui-brand-official/src/client/Brand.tsx', f'''import type {{ SidebarBrandMarkOwnerProps }} from '@deepseek-ai/dsh-client-ui-sidebar/client'

const WORDMARK_PATH = '{word_d}'

/**
 * The sidebar shows the wordmark alone, so the mark slot is empty.
 * @param _props - Host-supplied mark presentation.
 * @returns nothing.
 */
export function OfficialBrandMark(_props: SidebarBrandMarkOwnerProps) {{
  return null
}}

/**
 * Render the mumbo wordmark (Caladea outlines, a Cambria substitute).
 * @returns the wordmark svg.
 */
export function OfficialBrandName() {{
  return (
    <svg width={{{round(18 * word_w / word_h)}}} height={{18}} viewBox="0 0 {word_w} {word_h}" fill="none" aria-hidden="true">
      <path d={{WORDMARK_PATH}} fill="currentColor" />
    </svg>
  )
}}
''')

# Welcome page wordmark, centred in the original 472x40 frame.
scale = 30 / word_h
write('apps/desktop/renderer/assets/welcome-brand.svg', f'''<svg width="472" height="40" viewBox="0 0 472 40" fill="none" xmlns="http://www.w3.org/2000/svg">
<style>path {{ fill: {INK}; }} @media (prefers-color-scheme: dark) {{ path {{ fill: #f9fafb; }} }}</style>
<path transform="translate({(472 - word_w * scale) / 2:.1f} 5) scale({scale:.5f})" d="{word_d}"/>
</svg>
''')


def tile_svg(size: int, inset: int, radius: int, bg: str, fg: str) -> str:
    inner = size - 2 * inset
    s = inner * 0.62 / m_w
    tx = inset + (inner - m_w * s) / 2
    ty = inset + (inner - m_h * s) / 2
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 {size} {size}">'
            f'<rect x="{inset}" y="{inset}" width="{inner}" height="{inner}" rx="{radius}" fill="{bg}"/>'
            f'<path transform="translate({tx:.1f} {ty:.1f}) scale({s:.5f})" d="{m_d}" fill="{fg}"/></svg>\n')


write('apps/web/public/favicon.svg', tile_svg(50, 0, 11, INK, PAPER))
write('apps/web/public/favicon-dark.svg', tile_svg(50, 0, 11, PAPER, INK))
write('apps/desktop/resources/icon.svg', tile_svg(1104, 40, 230, INK, PAPER))
write('apps/desktop/resources/icon-macos.svg', tile_svg(1024, 100, 185, INK, PAPER))
write('apps/desktop/resources/icon-windows.svg', tile_svg(1024, 0, 200, INK, PAPER))


def tile_png(size: int, inset: int, radius: int) -> Image.Image:
    """Raster tile drawn at 4x and downsampled for smooth edges."""
    k = 4
    big = size * k
    img = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.rounded_rectangle([inset * k, inset * k, big - inset * k - 1, big - inset * k - 1], radius * k, fill=INK)
    # Rasterise the glyph outline: flatten the path with a recording pen.
    from fontTools.pens.basePen import BasePen

    inner = (size - 2 * inset) * k
    s = inner * 0.62 / m_w
    name = cmap[ord('m')]
    bp = BoundsPen(glyphs)
    glyphs[name].draw(bp)
    gx0, gy0, gx1, gy1 = bp.bounds
    ox = inset * k + (inner - m_w * s) / 2
    oy = inset * k + (inner - m_h * s) / 2

    class Flatten(BasePen):
        def __init__(self):
            super().__init__(glyphs)
            self.polys, self.cur = [], []

        def _pt(self, p):
            return (ox + (p[0] - gx0) * s, oy + (gy1 - p[1]) * s)

        def _moveTo(self, p):
            self.cur = [self._pt(p)]

        def _lineTo(self, p):
            self.cur.append(self._pt(p))

        def _curveToOne(self, p1, p2, p3):
            a = self._getCurrentPoint()
            for i in range(1, 17):
                t = i / 16
                u = 1 - t
                x = u**3 * a[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t**3 * p3[0]
                y = u**3 * a[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t**3 * p3[1]
                self.cur.append(self._pt((x, y)))

        def _closePath(self):
            self.polys.append(self.cur)

    pen = Flatten()
    glyphs[name].draw(pen)
    # 'm' has no counters, so filling each contour is exact.
    for poly in pen.polys:
        draw.polygon(poly, fill=PAPER)
    return img.resize((size, size), Image.LANCZOS)


write('apps/desktop/resources/icon.png', tile_png(1104, 40, 230))
write('apps/desktop/resources/icon-macos.png', tile_png(1024, 100, 185))
write('apps/desktop/resources/icon-windows.png', tile_png(1024, 0, 200))
write('apps/desktop/resources/tray-windows.ico', tile_png(256, 0, 48))
