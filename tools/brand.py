#!/usr/bin/env python3
"""
tools/brand.py: the favicon set and the nav mark from ~/Experimental/ponchem.png (a rainbow protein ribbon on
off-white). Run with the project venv:  .venv/bin/python tools/brand.py [path/to/ponchem.png]

What it does:
  1. keys the off-white ground out by colour distance (the ribbons are saturated or dark, the ground is one flat
     tone, so a global key keeps the loops' holes transparent, which a flood fill from the corners would not);
  2. crops to the ribbon's bounding box, pads to a square, and writes:
       img/brand/mark.png            512 px, transparent (nav mark, 32 px on screen)
       img/brand/mark-64.png          64 px, transparent (small uses)
       img/brand/favicon-32.png       32 px on the paper tone (tiny transparent ribbons read as noise)
       img/brand/favicon-16.png       16 px, same
       img/brand/favicon.ico          16 + 32 + 48
       img/brand/apple-touch-icon.png 180 px on the paper tone
       img/brand/icon-192.png, icon-512.png            transparent, for the manifest
       img/brand/icon-maskable-192.png, icon-maskable-512.png   paper tone, ribbon inside the 80 percent safe zone
"""
import os
import sys

from PIL import Image, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'img', 'brand')
PAPER = (245, 243, 236, 255)  # SPEC-DESIGN paper #F5F3EC


def key_out(im, ground, lo=14, hi=44):
    """alpha 0 at colour distance <= lo from the ground, 255 at >= hi, linear between."""
    im = im.convert('RGBA')
    px = im.load()
    w, h = im.size
    gr, gg, gb = ground
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            d = ((r - gr) ** 2 + (g - gg) ** 2 + (b - gb) ** 2) ** 0.5
            if d <= lo:
                px[x, y] = (r, g, b, 0)
            elif d < hi:
                px[x, y] = (r, g, b, int(255 * (d - lo) / (hi - lo)))
    return im


def square(im, pad_ratio):
    box = im.getbbox()
    im = im.crop(box)
    w, h = im.size
    side = int(max(w, h) * (1 + 2 * pad_ratio))
    canvas = Image.new('RGBA', (side, side), (0, 0, 0, 0))
    canvas.paste(im, ((side - w) // 2, (side - h) // 2), im)
    return canvas


def on_paper(im, size, pad_ratio):
    sq = square(im, pad_ratio).resize((size, size), Image.LANCZOS)
    bg = Image.new('RGBA', (size, size), PAPER)
    bg.alpha_composite(sq)
    return bg.convert('RGB')


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser('~/Experimental/ponchem.png')
    im = Image.open(src).convert('RGB')
    ground = im.getpixel((2, 2))
    print('source', src, im.size, 'ground', ground)
    cut = key_out(im, ground)
    # soften the keyed edge a touch so downsampled ribbons do not sparkle
    alpha = cut.getchannel('A').filter(ImageFilter.GaussianBlur(0.6))
    cut.putalpha(alpha)
    os.makedirs(OUT, exist_ok=True)

    mark = square(cut, 0.04)
    mark.resize((512, 512), Image.LANCZOS).save(os.path.join(OUT, 'mark.png'), optimize=True)
    mark.resize((64, 64), Image.LANCZOS).save(os.path.join(OUT, 'mark-64.png'), optimize=True)
    square(cut, 0.02).resize((192, 192), Image.LANCZOS).save(os.path.join(OUT, 'icon-192.png'), optimize=True)
    square(cut, 0.02).resize((512, 512), Image.LANCZOS).save(os.path.join(OUT, 'icon-512.png'), optimize=True)

    on_paper(cut, 32, 0.02).save(os.path.join(OUT, 'favicon-32.png'), optimize=True)
    on_paper(cut, 16, 0.0).save(os.path.join(OUT, 'favicon-16.png'), optimize=True)
    on_paper(cut, 180, 0.10).save(os.path.join(OUT, 'apple-touch-icon.png'), optimize=True)
    on_paper(cut, 192, 0.18).save(os.path.join(OUT, 'icon-maskable-192.png'), optimize=True)
    on_paper(cut, 512, 0.18).save(os.path.join(OUT, 'icon-maskable-512.png'), optimize=True)
    # Pillow keeps only the frames no larger than the base image, so the 48 px frame goes first.
    ico = [on_paper(cut, s, 0.02 if s > 16 else 0.0) for s in (48, 32, 16)]
    ico[0].save(os.path.join(OUT, 'favicon.ico'), format='ICO', sizes=[(48, 48), (32, 32), (16, 16)],
                append_images=ico[1:])
    for f in sorted(os.listdir(OUT)):
        p = os.path.join(OUT, f)
        print(f'{f:28s} {os.path.getsize(p):8d} bytes')


if __name__ == '__main__':
    main()
