# -*- coding: utf-8 -*-
"""Phase 1-3 of the PDF -> translated Word pipeline.

Renders every PDF page to PNG (the authoritative source for the translator),
extracts raster figures composited with their soft masks, splits the text layer
per page, and emits the chunk plan.  Also reports pages that carry a figure
caption but no raster image - those figures are vector art and need
crop_vector_figs.py.

    python pipeline_prepare.py --workspace "<ws>" --pdf "book.pdf" [--dpi 150]
                               [--chunk-pages 4] [--work _translate_work]
"""
import argparse
import json
import os
import re
import subprocess
import sys

WORKDIR = '_translate_work'


def run(cmd):
    p = subprocess.run(cmd, capture_output=True)
    return p.returncode, (p.stdout or b'').decode('utf-8', 'replace'), \
        (p.stderr or b'').decode('utf-8', 'replace')


def have(tool):
    from shutil import which
    return which(tool) is not None


def pdfinfo_pages(pdf):
    rc, out, _ = run(['pdfinfo', pdf])
    if rc == 0:
        m = re.search(r'^Pages:\s+(\d+)', out, re.M)
        if m:
            return int(m.group(1))
    # fall back to counting rendered pages later
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--workspace', required=True)
    ap.add_argument('--pdf', required=True,
                    help='path to the PDF (absolute, or relative to workspace)')
    ap.add_argument('--work', default=WORKDIR)
    ap.add_argument('--dpi', type=int, default=150)
    ap.add_argument('--chunk-pages', type=int, default=4)
    ap.add_argument('--caption-word', default='Рис.',
                    help='caption prefix in the source language (regex-safe)')
    args = ap.parse_args()

    ws = os.path.abspath(args.workspace)
    pdf = args.pdf if os.path.isabs(args.pdf) else os.path.join(ws, args.pdf)
    if not os.path.exists(pdf):
        sys.exit('PDF not found: %s' % pdf)

    missing = [t for t in ('pdftoppm', 'pdfimages', 'pdftotext', 'pdfinfo')
               if not have(t)]
    if missing:
        sys.exit('missing poppler tools: %s' % ', '.join(missing))

    w = os.path.join(ws, args.work)
    for sub in ('pages', 'img', 'figs', 'ptext', 'tmp'):
        os.makedirs(os.path.join(w, sub), exist_ok=True)

    total = pdfinfo_pages(pdf)
    print('PDF: %s' % pdf)
    print('pages: %s' % total)

    # ---- 1. render every page ------------------------------------------
    print('\n[1] rendering pages at %d dpi ...' % args.dpi)
    rc, _, err = run(['pdftoppm', '-png', '-r', str(args.dpi), pdf,
                      os.path.join(w, 'pages', 'p')])
    # pdftoppm pads to 2 digits below 100 pages and 3 above; normalise to a
    # fixed 3-digit form so prompts and figure names are always predictable.
    import re as _re
    for f in list(os.listdir(os.path.join(w, 'pages'))):
        m = _re.match(r'^p-(\d+)\.png$', f)
        if not m:
            continue
        want = 'p-%03d.png' % int(m.group(1))
        if f != want:
            os.replace(os.path.join(w, 'pages', f),
                       os.path.join(w, 'pages', want))
    pages = sorted(f for f in os.listdir(os.path.join(w, 'pages'))
                   if f.startswith('p-') and f.endswith('.png'))
    npages = len(pages)
    print('    rendered %d pages (names like %s)' % (npages, pages[0]))

    # ---- 2. extract + composite raster figures --------------------------
    print('\n[2] extracting raster figures ...')
    rc, listing, _ = run(['pdfimages', '-png', '-list', pdf])
    open(os.path.join(w, 'img_manifest.txt'), 'w', encoding='utf-8').write(listing)
    run(['pdfimages', '-png', pdf, os.path.join(w, 'img', 'i')])

    entries = []
    for line in listing.splitlines():
        parts = line.split()
        if len(parts) < 15 or parts[0] in ('page',) or parts[0].startswith('-'):
            continue
        try:
            page, num = int(parts[0]), int(parts[1])
        except ValueError:
            continue
        if parts[2] not in ('image', 'smask'):
            continue
        entries.append({'page': page, 'num': num, 'type': parts[2],
                        'w': int(parts[3]), 'h': int(parts[4]),
                        'xppi': int(float(parts[-4]))})

    figs = []
    per_page_count = {}
    for idx, e in enumerate(entries):
        if e['type'] != 'image':
            continue
        base_path = os.path.join(w, 'img', 'i-%03d.png' % e['num'])
        if not os.path.exists(base_path):
            continue
        try:
            from PIL import Image
        except ImportError:
            sys.exit('Pillow is required for figure compositing')
        base = Image.open(base_path).convert('RGB')
        mask = None
        if idx + 1 < len(entries) and entries[idx + 1]['type'] == 'smask':
            mpath = os.path.join(w, 'img', 'i-%03d.png' % entries[idx + 1]['num'])
            if os.path.exists(mpath):
                mask = Image.open(mpath).convert('L')
                if mask.size != base.size:
                    mask = mask.resize(base.size, Image.LANCZOS)
        if mask is not None:
            white = Image.new('RGB', base.size, (255, 255, 255))
            white.paste(base, (0, 0), mask)
            base = white
        if base.size[0] < 24 or base.size[1] < 24:
            continue                      # degenerate artefacts
        k = per_page_count.get(e['page'], 0)
        per_page_count[e['page']] = k + 1
        name = 'fig_p%03d_%02d.png' % (e['page'], k)
        base.save(os.path.join(w, 'figs', name))
        figs.append({'page': e['page'], 'name': name,
                     'w': base.size[0], 'h': base.size[1]})
    with open(os.path.join(w, 'figs_manifest.txt'), 'w', encoding='utf-8') as fh:
        for f in figs:
            fh.write('%d\t%s\t%d\t%d\n' % (f['page'], f['name'], f['w'], f['h']))
    print('    %d raster figures on %d pages'
          % (len(figs), len(set(f['page'] for f in figs))))

    # ---- 3. per-page text layer ----------------------------------------
    print('\n[3] splitting the text layer ...')
    run(['pdftotext', '-layout', '-enc', 'UTF-8', pdf,
         os.path.join(w, 'text_layout.txt')])
    txt = open(os.path.join(w, 'text_layout.txt'), encoding='utf-8').read() \
        if os.path.exists(os.path.join(w, 'text_layout.txt')) else ''
    chunks_txt = txt.split('\f')
    for i in range(1, npages + 1):
        body = chunks_txt[i - 1] if i - 1 < len(chunks_txt) else ''
        open(os.path.join(w, 'ptext', 'p%03d.txt' % i), 'w',
             encoding='utf-8').write(body)

    # ---- report: pages with captions but no raster figure ---------------
    fig_pages = set(f['page'] for f in figs)
    cap_re = re.compile(re.escape(args.caption_word) + r'\s*\d+')
    vector_pages = []
    for i in range(1, npages + 1):
        p = os.path.join(w, 'ptext', 'p%03d.txt' % i)
        t = open(p, encoding='utf-8').read() if os.path.exists(p) else ''
        n = len(cap_re.findall(t))
        if n and i not in fig_pages:
            vector_pages.append((i, n))

    # ---- chunk plan -----------------------------------------------------
    chunks = []
    start = 1
    while start <= npages:
        end = min(start + args.chunk_pages - 1, npages)
        chunks.append({'id': 'chunk_%02d' % (len(chunks) + 1),
                       'from': start, 'to': end,
                       'out': 'tr/chunk_%02d.md' % (len(chunks) + 1)})
        start = end + 1
    os.makedirs(os.path.join(w, 'tr'), exist_ok=True)
    with open(os.path.join(w, 'chunks.json'), 'w', encoding='utf-8') as fh:
        json.dump({'pdf': os.path.basename(pdf), 'pages': npages,
                   'figs': figs, 'vector_pages': vector_pages,
                   'chunks': chunks}, fh, ensure_ascii=False, indent=1)

    print('\n    %d chunks of <=%d pages' % (len(chunks), args.chunk_pages))
    if vector_pages:
        print('\n[!] VECTOR FIGURES - these pages have a caption but no raster')
        print('    image, so pdfimages cannot extract them. Read the page image,')
        print('    then crop with crop_vector_figs.py:')
        for pg, n in vector_pages:
            print('      page %-4d %d caption(s)' % (pg, n))
        print('    (a caption at the top of a page may belong to a figure on the')
        print('     previous page - check before cropping)')
    else:
        print('\n    no missing-figure pages detected')

    print('\nwork dir: %s' % w)
    print('next: translate tr/chunk_NN.md, then validate.py, then assemble.py')


if __name__ == '__main__':
    main()
