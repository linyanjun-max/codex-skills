# -*- coding: utf-8 -*-
"""Phase 6: assemble the translated chunk files into the final Word document.

Reads <work>/tr/chunk_*.md (see references/workflow.md for the record format)
and writes a .docx via docxkit.

    python assemble.py --workspace "<ws>" --out "book.docx" \
        --cover-page 1 --toc-page 4 --skip-pages 2
"""
import argparse
import glob
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from docxkit import Docx
from docxkit import texomml as T

WORKDIR = '_translate_work'

# NOTE: longer alternatives must precede their prefixes (EQN before EQ, H1..H4
# before nothing else) or "#EQN 1.1 ..." parses as "#EQ" with body "N 1.1 ..."
# and every numbered equation silently loses its number.
MARKER = re.compile(r'^#(EQN|H1|H2|H3|H4|P|EQ|FIG|BUL|CAP|NOTE)\s*(.*)$')


class Problem(object):
    def __init__(self, kind, detail, where):
        self.kind, self.detail, self.where = kind, detail, where

    def __str__(self):
        return '[%s] %s  (%s)' % (self.kind, self.detail, self.where)


def strip_math(s):
    s = s.strip()
    if s.startswith('$$') and s.endswith('$$') and len(s) > 4:
        s = s[2:-2]
    elif s.startswith('$') and s.endswith('$') and len(s) > 2:
        s = s[1:-1]
    s = re.sub(r'\\tag\{[^}]*\}', '', s)
    s = re.sub(r'\\label\{[^}]*\}', '', s)
    return s.strip()


def split_eqn(rest):
    """`1.1 <latex>` / `(1.1) <latex>` -> ('1.1', '<latex>')"""
    m = re.match(r'^\s*\(?\s*([0-9]+(?:\.[0-9]+)*[A-Za-z\u0400-\u04ff]?)\s*\)?\s+(.*)$',
                 rest, re.DOTALL)
    if m:
        return m.group(1), m.group(2).strip()
    return None, rest.strip()


def parse_files(files):
    blocks, problems, pages_seen = [], [], []
    for path in files:
        name = os.path.basename(path)
        with open(path, encoding='utf-8') as fh:
            for lineno, raw in enumerate(fh, 1):
                line = raw.rstrip('\n').rstrip()
                where = '%s:%d' % (name, lineno)
                if not line.strip() or line.lstrip().startswith('```'):
                    continue
                m = re.match(r'^@@PAGE\s+(\d+)', line)
                if m:
                    pg = int(m.group(1))
                    if pg not in pages_seen:
                        pages_seen.append(pg)
                    blocks.append(('page', pg, where))
                    continue
                mm = MARKER.match(line.strip())
                if not mm:
                    problems.append(Problem('NO-MARKER', line[:70], where))
                    blocks.append(('p', line.strip(), where))
                    continue
                kind, rest = mm.group(1), mm.group(2).strip()
                if kind in ('H1', 'H2', 'H3', 'H4'):
                    blocks.append(('h', int(kind[1]), rest, where))
                elif kind == 'P':
                    blocks.append(('p', rest, where))
                elif kind in ('CAP', 'NOTE'):
                    blocks.append(('cap', rest, where))
                elif kind == 'BUL':
                    blocks.append(('bullet', rest, where))
                elif kind == 'EQ':
                    blocks.append(('eq', strip_math(rest), None, where))
                elif kind == 'EQN':
                    num, tex = split_eqn(rest)
                    blocks.append(('eq', strip_math(tex), num, where))
                elif kind == 'FIG':
                    fn, _, cap = rest.partition('|')
                    blocks.append(('fig', fn.strip().strip('`'), cap.strip(), where))
                else:
                    problems.append(Problem('UNKNOWN', line[:70], where))
    return blocks, problems, sorted(set(pages_seen))


def parse(work):
    files = sorted(glob.glob(os.path.join(work, 'tr', 'chunk_*.md')))
    if not files:
        sys.exit('no chunk files found in %s' % os.path.join(work, 'tr'))
    return parse_files(files)


def validate_latex(blocks):
    bad = []
    for b in blocks:
        if b[0] == 'eq':
            try:
                T.latex_to_omml(b[1])
            except Exception as e:
                bad.append((b[1], str(e), b[-1]))
    return bad


def _group_by_page(blocks):
    pages, cur = [], None
    for b in blocks:
        if b[0] == 'page':
            cur = (b[1], [])
            pages.append(cur)
        else:
            if cur is None:
                cur = (None, [])
                pages.append(cur)
            cur[1].append(b)
    return pages


def build(blocks, work, outpath, cover_page=1, toc_page=None, skip_pages=(),
          break_before_h1=True, title='', creator=''):
    figs_dir = os.path.join(work, 'figs')
    d = Docx(title=title, creator=creator)
    pages = _group_by_page(blocks)
    first = True

    for page_no, page_blocks in pages:
        if page_no in skip_pages and not any(
                b[0] in ('h', 'p', 'eq', 'fig', 'bullet') for b in page_blocks):
            continue

        if cover_page is not None and page_no == cover_page:
            lines = [b[1] for b in page_blocks if b[0] in ('p', 'cap')]
            for i, text in enumerate(lines):
                if i <= 2:
                    d.center(text, size=12, before=0 if i else 40)
                elif i == 3:
                    d.center(text, size=14, before=70)
                elif i == 4:
                    d.center(text, size=24, bold=True, before=30, after=20)
                elif i <= 7:
                    d.center(text, size=11, before=6)
                else:
                    d.center(text, size=12, before=10)
            d.pagebreak()
            first = False
            continue

        if toc_page is not None and page_no == toc_page:
            headings = [b for b in page_blocks if b[0] == 'h']
            d.h(1, headings[0][2] if headings else '\u76ee\u5f55')
            d.toc()
            d.h(2, '\u539f\u4e66\u76ee\u5f55\uff08\u9875\u7801\u4e3a\u539f\u4e66\u9875\u7801\uff09')
            for b in page_blocks:
                if b[0] != 'h':
                    d.raw(b[1])
            d.pagebreak()
            first = False
            continue

        for b in page_blocks:
            kind = b[0]
            if kind == 'h':
                lvl, text = b[1], b[2]
                if lvl == 1 and break_before_h1 and not first:
                    d.pagebreak()
                d.h(lvl, text)
            elif kind == 'p':
                d.p(b[1])
            elif kind == 'cap':
                d.raw(b[1])
            elif kind == 'bullet':
                d.bullet(b[1])
            elif kind == 'eq':
                if b[2]:
                    d.eq(b[1], b[2])
                else:
                    d.eqn(b[1])
            elif kind == 'fig':
                fn, cap = b[1], b[2]
                path = os.path.join(figs_dir, fn)
                if not os.path.exists(path):
                    path = os.path.join(work, fn)
                if os.path.exists(path):
                    d.fig(path, cap)
                else:
                    d.raw('\uff3b\u7f3a\u56fe\uff1a%s\uff3d%s' % (fn, cap))
            first = False
    return d.save(outpath)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--workspace', required=True)
    ap.add_argument('--work', default=WORKDIR)
    ap.add_argument('--out', required=True)
    ap.add_argument('--cover-page', type=int, default=None)
    ap.add_argument('--toc-page', type=int, default=None)
    ap.add_argument('--skip-pages', type=int, nargs='*', default=[])
    ap.add_argument('--no-break-h1', action='store_true')
    ap.add_argument('--title', default='')
    ap.add_argument('--creator', default='')
    args = ap.parse_args()

    work = os.path.join(os.path.abspath(args.workspace), args.work)
    blocks, problems, pages = parse(work)

    print('pages seen: %d  (%s..%s)' % (len(pages), min(pages), max(pages)))
    bad = validate_latex(blocks)
    print('equation parse errors: %d' % len(bad))
    for tex, err, where in bad[:20]:
        print('   %s  <-  %s  (%s)' % (err, tex[:80], where))
    if problems:
        print('parse notes: %d (first 5)' % len(problems))
        for p in problems[:5]:
            print('   ', p)

    build(blocks, work, args.out,
          cover_page=args.cover_page, toc_page=args.toc_page,
          skip_pages=set(args.skip_pages),
          break_before_h1=not args.no_break_h1,
          title=args.title, creator=args.creator)
    print('WROTE %s  (%d bytes)' % (args.out, os.path.getsize(args.out)))


if __name__ == '__main__':
    main()
