# -*- coding: utf-8 -*-
"""Phase 5: hard gate before assembling.

Checks, in order:
  1. page coverage   - every source page emitted a @@PAGE marker
  2. figure refs     - every #FIG file exists on disk
  3. LaTeX health    - every equation converts to OMML
  4. stray captions  - caption-looking lines that should have been #FIG
  5. equation numbers- diff preserved numbering against the source text layer

    python validate.py --workspace "<ws>" [--eqnums "<work>/text_layout.txt"]
"""
import argparse
import os
import re
import sys
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import assemble as A

WORKDIR = '_translate_work'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--workspace', required=True)
    ap.add_argument('--work', default=WORKDIR)
    ap.add_argument('--total-pages', type=int, default=None)
    ap.add_argument('--eqnums', default=None,
                    help='source text layer, to diff equation numbers')
    ap.add_argument('--caption-pattern', default=r'\u56fe\s*\d+(\.\d+)?',
                    help='regex for translated figure captions (default: 图 N.N)')
    args = ap.parse_args()

    work = os.path.join(os.path.abspath(args.workspace), args.work)
    blocks, problems, pages = A.parse(work)
    figs_dir = os.path.join(work, 'figs')
    ok = True

    total = args.total_pages
    if total is None:
        cj = os.path.join(work, 'chunks.json')
        if os.path.exists(cj):
            import json
            total = json.load(open(cj, encoding='utf-8')).get('pages')
    total = total or (max(pages) if pages else 0)

    print('=== PAGE COVERAGE ===')
    missing = [p for p in range(1, total + 1) if p not in pages]
    print('pages emitted: %d/%d' % (len(pages), total))
    if missing:
        ok = False
        print('MISSING PAGES: %s' % missing)
    else:
        print('missing pages: none')

    print('\n=== FIGURE REFERENCES ===')
    figs = [b for b in blocks if b[0] == 'fig']
    bad = [b[1] for b in figs
           if not os.path.exists(os.path.join(figs_dir, b[1]))
           and not os.path.exists(os.path.join(work, b[1]))]
    print('figure references: %d' % len(figs))
    if bad:
        ok = False
        print('MISSING IMAGE FILES: %s' % bad)
    else:
        print('missing image files: none')

    print('\n=== LATEX HEALTH ===')
    eqs = [b for b in blocks if b[0] == 'eq']
    errs = A.validate_latex(blocks)
    numbered = [b for b in eqs if b[2]]
    print('equations: %d (numbered %d, unnumbered %d)'
          % (len(eqs), len(numbered), len(eqs) - len(numbered)))
    if errs:
        ok = False
        print('parse errors: %d' % len(errs))
        for tex, err, where in errs[:20]:
            print('   %s  <-  %s   (%s)' % (err, tex[:80], where))
    else:
        print('parse errors: 0')

    print('\n=== CAPTION-LIKE LINES WITHOUT A FIGURE ===')
    capre = re.compile(args.caption_pattern)
    susp = [b for b in blocks if b[0] in ('cap', 'p') and capre.search(b[1])]
    if susp:
        ok = False
        print('found %d - these are probably figures missing from the manifest:' % len(susp))
        for b in susp:
            print('   %s   (%s)' % (b[1][:80], b[-1]))
    else:
        print('none')

    if args.eqnums and os.path.exists(args.eqnums):
        print('\n=== EQUATION NUMBERING vs SOURCE ===')
        src_text = open(args.eqnums, encoding='utf-8').read()
        src = set(re.findall(r'\((\d+\.\d+)\)\s*$', src_text, re.M))
        tr = set(b[2] for b in numbered)
        miss = sorted(src - tr)
        extra = sorted(tr - src)
        print('source: %d   translation: %d' % (len(src), len(tr)))
        print('missing in translation: %s' % (miss if miss else 'none'))
        print('not in source (typos in the source may explain these): %s'
              % (extra if extra else 'none'))
        if miss:
            print('NOTE: verify each missing number is not just a source')
            print('      cross-reference such as "по формуле (2.71)".')

    print('\n=== COUNTS ===')
    for k, v in sorted(Counter(b[0] for b in blocks).items()):
        print('   %-8s %d' % (k, v))

    print('\nRESULT: %s' % ('OK - ready to assemble' if ok else 'REVIEW NEEDED'))
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
