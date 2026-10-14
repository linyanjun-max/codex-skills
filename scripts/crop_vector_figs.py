# -*- coding: utf-8 -*-
"""Crop vector-graphic figures that pdfimages cannot extract.

Mathcad/MATLAB plots pasted into a document as vector art are invisible to
pdfimages.  This tool renders the page at high resolution and crops a band you
specify in PDF points (72 dpi), then tightens the crop to the ink bounding box.

Auto-detection is deliberately only a *suggestion*: axis labels inside a figure
look exactly like body text to a text-layer heuristic, so the reliable procedure
is (1) look at pages/p-NNN.png yourself, (2) run --suggest for exact line boxes,
(3) crop with explicit --top/--bottom, (4) read the PNG back to confirm neither
the caption nor the surrounding prose was included.

    # list text-line boxes so you can pick the band
    python crop_vector_figs.py --workspace "<ws>" --suggest --pages 22

    # crop one figure: page 22, 1st figure on that page, y from 246 to 458 pt
    python crop_vector_figs.py --workspace "<ws>" --page 22 --idx 0 \
        --top 246 --bottom 458

    # or several at once
    python crop_vector_figs.py --workspace "<ws>" --bands "22:0:246:458" "25:0:257:500"
"""
import argparse
import os
import re
import subprocess
import sys

WORKDIR = '_translate_work'


def bbox_lines(pdf, page, tmp):
    out = os.path.join(tmp, 'bb_%03d.xhtml' % page)
    os.makedirs(tmp, exist_ok=True)
    subprocess.run(['pdftotext', '-bbox', '-f', str(page), '-l', str(page),
                    pdf, out], capture_output=True)
    if not os.path.exists(out):
        return []
    xml = open(out, encoding='utf-8').read()
    words = []
    for m in re.finditer(
            r'<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">(.*?)</word>',
            xml):
        x0, y0, x1, y1 = map(float, m.groups()[:4])
        words.append({'x0': x0, 'y0': y0, 'x1': x1, 'y1': y1, 't': m.group(5)})
    words.sort(key=lambda d: (round(d['y0'], 1), d['x0']))
    lines = []
    for d in words:
        if lines and abs(lines[-1]['y0'] - d['y0']) < 3.0:
            L = lines[-1]
            L['x0'] = min(L['x0'], d['x0']); L['x1'] = max(L['x1'], d['x1'])
            L['y1'] = max(L['y1'], d['y1']); L['t'] += ' ' + d['t']
        else:
            lines.append(dict(d))
    return lines


def render(pdf, page, dpi, tmp):
    stem = os.path.join(tmp, 'hi_%03d' % page)
    for f in os.listdir(tmp):
        if f.startswith('hi_%03d' % page):
            os.remove(os.path.join(tmp, f))
    subprocess.run(['pdftoppm', '-png', '-r', str(dpi), '-f', str(page),
                    '-l', str(page), pdf, stem], capture_output=True)
    cand = sorted(f for f in os.listdir(tmp) if f.startswith('hi_%03d' % page))
    if not cand:
        sys.exit('render failed for page %d' % page)
    return os.path.join(tmp, cand[0])


def crop(pdf, page, idx, top, bottom, xl, xr, dpi, figs_dir, tmp, caption_word):
    from PIL import Image
    img = Image.open(render(pdf, page, dpi, tmp))
    s = dpi / 72.0
    sub = img.crop((int(xl * s), int(top * s), int(xr * s), int(bottom * s)))
    g = sub.convert('L')
    px = g.load()
    wdt, hgt = g.size
    X0, Y0, X1, Y1 = wdt, hgt, 0, 0
    found = False
    for y in range(hgt):
        for x in range(wdt):
            if px[x, y] < 205:
                found = True
                X0 = min(X0, x); X1 = max(X1, x)
                Y0 = min(Y0, y); Y1 = max(Y1, y)
    if not found:
        print('    page %d idx %d: band is blank - skipped' % (page, idx))
        return None
    pad = 6
    out = sub.crop((max(0, X0 - pad), max(0, Y0 - pad),
                    min(wdt, X1 + 1 + pad), min(hgt, Y1 + 1 + pad)))
    name = 'fig_p%03d_%02d.png' % (page, idx)
    out.save(os.path.join(figs_dir, name))
    print('    -> %s  %s' % (name, out.size))
    return name


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--workspace', required=True)
    ap.add_argument('--pdf', default=None, help='defaults to <work>/source.pdf')
    ap.add_argument('--work', default=WORKDIR)
    ap.add_argument('--dpi', type=int, default=300)
    ap.add_argument('--pages', default='', help='pages to inspect with --suggest')
    ap.add_argument('--suggest', action='store_true')
    ap.add_argument('--page', type=int)
    ap.add_argument('--idx', type=int, default=0)
    ap.add_argument('--top', type=float)
    ap.add_argument('--bottom', type=float)
    ap.add_argument('--left', type=float, default=None,
                    help='crop x-start in points; default = page text margin')
    ap.add_argument('--right', type=float, default=None,
                    help='crop x-end in points; default = page text margin')
    ap.add_argument('--bands', nargs='*', default=[],
                    help='page:idx:top:bottom entries')
    ap.add_argument('--caption-word', default='Рис.')
    args = ap.parse_args()

    ws = os.path.abspath(args.workspace)
    w = os.path.join(ws, args.work)
    tmp = os.path.join(w, 'tmp')
    figs = os.path.join(w, 'figs')
    pdf = args.pdf or os.path.join(w, 'source.pdf')
    if not os.path.exists(pdf):
        sys.exit('PDF not found: %s (copy the source into the work dir or pass --pdf)' % pdf)
    os.makedirs(tmp, exist_ok=True)
    os.makedirs(figs, exist_ok=True)

    if args.suggest:
        for page in [int(x) for x in re.findall(r'\d+', args.pages)]:
            print('===== page %d =====' % page)
            for L in bbox_lines(pdf, page, tmp):
                mark = '  <-- CAPTION' if args.caption_word in L['t'] else ''
                print('  y=%7.1f..%7.1f  x=%6.1f..%6.1f  %r%s'
                      % (L['y0'], L['y1'], L['x0'], L['x1'], L['t'][:70], mark))
        print('\nPick --top just below the last body line and --bottom just above')
        print('the caption line.  Then run with --page/--idx/--top/--bottom.')
        return

    todo = []
    for b in args.bands:
        pg, idx, top, bottom = b.split(':')
        todo.append((int(pg), int(idx), float(top), float(bottom)))
    if args.page is not None:
        if args.top is None or args.bottom is None:
            sys.exit('--page requires --top and --bottom')
        todo.append((args.page, args.idx, args.top, args.bottom))
    if not todo:
        sys.exit('nothing to do: pass --suggest, --bands or --page/--top/--bottom')

    for pg, idx, top, bottom in todo:
        # Derive the horizontal band from the page's own text margins when the
        # caller did not pin it: portrait A4 pages and landscape slides differ.
        xl, xr = args.left, args.right
        if xl is None or xr is None:
            lines = bbox_lines(pdf, pg, tmp)
            if lines:
                auto_l = min(L['x0'] for L in lines)
                auto_r = max(L['x1'] for L in lines)
            else:
                auto_l, auto_r = 40.0, 560.0
            xl = auto_l - 6 if xl is None else xl
            xr = auto_r + 6 if xr is None else xr
        crop(pdf, pg, idx, top, bottom, xl, xr,
             args.dpi, figs, tmp, args.caption_word)
    print('\nNow read the produced PNGs back and confirm they contain the figure')
    print('but NOT its caption line or any surrounding prose.')


if __name__ == '__main__':
    main()
