# -*- coding: utf-8 -*-
"""LaTeX -> OMML (Office Math Markup Language) converter.

Covers the subset of LaTeX used in technical textbooks: fractions, roots, scripts,
n-ary operators, delimiters, accents, matrices/cases arrays, Greek letters,
operators and spacing commands.

DESIGN NOTE (important): every OMML argument container (``m:num``, ``m:den``,
``m:sub``, ``m:sup``, ``m:lim``, ``m:e``, ``m:deg``, ``m:fName``) accepts a
*sequence* of math elements directly, so this module never nests an ``m:e`` inside
another argument container.  Parser methods therefore return Python lists of
elements rather than a single wrapped element.  Violating this makes Word report
"the file may be corrupted" with no further detail.
"""
import re
from lxml import etree

M = 'http://schemas.openxmlformats.org/officeDocument/2006/math'
XML = 'http://www.w3.org/XML/1998/namespace'
W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'


def q(tag):
    return '{%s}%s' % (M, tag)


def E(tag, *children):
    el = etree.Element(q(tag))
    for c in children:
        if c is not None:
            el.append(c)
    return el


def mrun(text, plain=False):
    """A math run. plain=True forces upright (non-italic) style."""
    r = etree.Element(q('r'))
    if plain:
        rpr = etree.SubElement(r, q('rPr'))
        sty = etree.SubElement(rpr, q('sty'))
        sty.set(q('val'), 'p')
    t = etree.SubElement(r, q('t'))
    t.set('{%s}space' % XML, 'preserve')
    t.text = text
    return r


# --------------------------------------------------------------------------
# symbol tables
# --------------------------------------------------------------------------
SYMBOLS = {
    'alpha': '\u03b1', 'beta': '\u03b2', 'gamma': '\u03b3', 'delta': '\u03b4',
    'epsilon': '\u03b5', 'varepsilon': '\u03b5', 'zeta': '\u03b6', 'eta': '\u03b7',
    'theta': '\u03b8', 'vartheta': '\u03d1', 'iota': '\u03b9', 'kappa': '\u03ba',
    'lambda': '\u03bb', 'mu': '\u03bc', 'nu': '\u03bd', 'xi': '\u03be',
    'pi': '\u03c0', 'varpi': '\u03d6', 'rho': '\u03c1', 'varrho': '\u03f1',
    'sigma': '\u03c3', 'varsigma': '\u03c2', 'tau': '\u03c4', 'upsilon': '\u03c5',
    'phi': '\u03c6', 'varphi': '\u03c6', 'chi': '\u03c7', 'psi': '\u03c8',
    'omega': '\u03c9',
    'Gamma': '\u0393', 'Delta': '\u0394', 'Theta': '\u0398', 'Lambda': '\u039b',
    'Xi': '\u039e', 'Pi': '\u03a0', 'Sigma': '\u03a3', 'Upsilon': '\u03a5',
    'Phi': '\u03a6', 'Psi': '\u03a8', 'Omega': '\u03a9',
    'cdot': '\u22c5', 'times': '\u00d7', 'div': '\u00f7', 'pm': '\u00b1',
    'mp': '\u2213', 'ast': '\u2217', 'star': '\u22c6', 'circ': '\u2218',
    'bullet': '\u2219', 'oplus': '\u2295', 'ominus': '\u2296', 'otimes': '\u2297',
    'le': '\u2264', 'leq': '\u2264', 'ge': '\u2265', 'geq': '\u2265',
    'ne': '\u2260', 'neq': '\u2260', 'approx': '\u2248', 'equiv': '\u2261',
    'sim': '\u223c', 'simeq': '\u2243', 'cong': '\u2245', 'propto': '\u221d',
    'll': '\u226a', 'gg': '\u226b', 'to': '\u2192', 'rightarrow': '\u2192',
    'leftarrow': '\u2190', 'leftrightarrow': '\u2194', 'Rightarrow': '\u21d2',
    'Leftarrow': '\u21d0', 'Leftrightarrow': '\u21d4', 'mapsto': '\u21a6',
    'in': '\u2208', 'notin': '\u2209', 'subset': '\u2282', 'supset': '\u2283',
    'subseteq': '\u2286', 'supseteq': '\u2287', 'cup': '\u222a', 'cap': '\u2229',
    'forall': '\u2200', 'exists': '\u2203', 'nexists': '\u2204',
    'angle': '\u2220', 'perp': '\u22a5', 'parallel': '\u2225',
    'infty': '\u221e', 'partial': '\u2202', 'nabla': '\u2207',
    'int': '\u222b', 'oint': '\u222e', 'sum': '\u2211', 'prod': '\u220f',
    'ldots': '\u2026', 'cdots': '\u22ef', 'vdots': '\u22ee', 'ddots': '\u22f1',
    'prime': '\u2032', 'degree': '\u00b0', 'neg': '\u00ac', 'land': '\u2227',
    'lor': '\u2228', 'emptyset': '\u2205', 'surd': '\u221a',
    'langle': '\u27e8', 'rangle': '\u27e9', 'lceil': '\u2308', 'rceil': '\u2309',
    'lfloor': '\u230a', 'rfloor': '\u230b', 'triangle': '\u25b3',
    'Longrightarrow': '\u27f9', 'iff': '\u21d4', 'implies': '\u21d2',
    'nmid': '\u2224', 'varnothing': '\u2205', 'aleph': '\u2135',
}

NARY = {'int': '\u222b', 'oint': '\u222e', 'sum': '\u2211', 'prod': '\u220f',
        'bigcup': '\u22c3', 'bigcap': '\u22c2', 'iint': '\u222c'}

FUNCS = {'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos',
         'arctan', 'sinh', 'cosh', 'tanh', 'coth', 'log', 'ln', 'lg', 'exp',
         'lim', 'limsup', 'liminf', 'min', 'max', 'sup', 'inf', 'det', 'dim',
         'ker', 'deg', 'arg', 'gcd', 'mod', 'Re', 'Im', 'const', 'rank',
         'sign', 'sgn', 'tr', 'diag'}

ACCENTS = {
    'hat': '^', 'widehat': '^', 'check': '\u02c7', 'breve': '\u02d8',
    'acute': '\u00b4', 'grave': '`', 'dot': '\u02d9', 'ddot': '\u00a8',
    'tilde': '~', 'widetilde': '~', 'vec': '\u20d7', 'bar': '\u00af',
    'mathring': '\u02da',
}

SPACES = {',': '\u2009', ';': '\u2005', ':': '\u2005', '!': '',
          'quad': '\u2003', 'qquad': '\u2003\u2003', ' ': '\u00a0',
          'thinspace': '\u2009', 'enspace': '\u2002'}

PLAIN_TEXT_CMDS = ('text', 'mathrm', 'textrm', 'operatorname', 'mbox',
                   'textnormal')

IGNORED_CMDS = ('limits', 'nolimits', 'displaystyle', 'textstyle', 'scriptstyle',
                'scriptscriptstyle', 'left', 'right', 'big', 'Big', 'bigg',
                'Bigg', 'bigl', 'bigr', 'Bigl', 'Bigr', 'bigm', 'Bigm',
                'mathstrut', 'strut', 'allowbreak', 'noindent', 'relax')


class TexError(Exception):
    pass


TOKEN_RE = re.compile(r"""
    (?P<env>\\begin\s*\{[A-Za-z*]+\})
  | (?P<endenv>\\end\s*\{[A-Za-z*]+\})
  | (?P<cmd>\\[A-Za-z]+)
  | (?P<esym>\\[^A-Za-z])
  | (?P<brace>[{}])
  | (?P<script>[\^_])
  | (?P<amp>&)
  | (?P<char>[^\s{}^_&\\])
""", re.VERBOSE)


def tokenize(s):
    toks = []
    i, n = 0, len(s)
    while i < n:
        c = s[i]
        if c.isspace():
            i += 1
            continue
        if s.startswith('\\\\', i):
            toks.append(('row', '\\\\'))
            i += 2
            continue
        m = TOKEN_RE.match(s, i)
        if not m:
            i += 1
            continue
        kind, text = m.lastgroup, m.group()
        if kind == 'env':
            toks.append(('begin', re.search(r'\{([A-Za-z*]+)\}', text).group(1)))
        elif kind == 'endenv':
            toks.append(('end', re.search(r'\{([A-Za-z*]+)\}', text).group(1)))
        elif kind == 'cmd':
            toks.append(('cmd', text[1:]))
        elif kind == 'esym':
            toks.append(('cmd', text[1]))
        elif kind == 'brace':
            toks.append(('brace', text))
        elif kind == 'script':
            toks.append((text, text))
        elif kind == 'amp':
            toks.append(('amp', '&'))
        else:
            toks.append(('char', text))
        i = m.end()
    return toks


def _clone(el):
    import copy
    return copy.deepcopy(el)


class Parser(object):
    """Parses a LaTeX token stream into lists of OMML elements."""

    def __init__(self, toks):
        self.t = toks
        self.i = 0

    # ---- token helpers --------------------------------------------------
    def peek(self):
        return self.t[self.i] if self.i < len(self.t) else None

    def take(self):
        tok = self.peek()
        if tok is not None:
            self.i += 1
        return tok

    def at_end(self):
        return self.i >= len(self.t)

    # ---- sequences ------------------------------------------------------
    def parse_group(self):
        """Parse one required argument; returns a list of elements."""
        tok = self.peek()
        if tok is None:
            return []
        if tok == ('brace', '{'):
            self.take()
            items = self.parse_seq(stop='}')
            if self.peek() == ('brace', '}'):
                self.take()
            return items
        return [self.parse_atom()]

    def parse_seq(self, stop=None, stop_chars=None, stop_right=False):
        items = []
        while True:
            tok = self.peek()
            if tok is None:
                break
            if stop == '}' and tok == ('brace', '}'):
                break
            if tok[0] in ('end', 'row', 'amp'):
                break
            if stop_chars and tok[0] == 'char' and tok[1] in stop_chars:
                break
            if stop_right and tok[0] == 'cmd' and tok[1] == 'right':
                break
            if tok[0] in ('^', '_'):
                self.take()
                items = self._attach_script(items, tok[0], self.parse_group())
                continue
            if tok == ('brace', '{'):
                # a bare group inside a sequence: splice its elements in place
                self.take()
                inner = self.parse_seq(stop='}')
                if self.peek() == ('brace', '}'):
                    self.take()
                items.extend(inner)
                continue
            if tok == ('brace', '}'):
                break
            items.append(self.parse_atom())
        return items

    # ---- scripts --------------------------------------------------------
    @staticmethod
    def _attach_script(items, kind, arg):
        base = items.pop() if items else mrun('')
        if kind == '^':
            if base.tag == q('sSub'):
                node = E('sSubSup', _clone(base.find(q('e'))),
                         _clone(base.find(q('sub'))), E('sup', *arg))
            else:
                node = E('sSup', base, E('sup', *arg))
        else:
            if base.tag == q('sSup'):
                node = E('sSubSup', _clone(base.find(q('e'))), E('sub', *arg),
                         _clone(base.find(q('sup'))))
            else:
                node = E('sSub', base, E('sub', *arg))
        items.append(node)
        return items

    # ---- atoms ----------------------------------------------------------
    def parse_atom(self):
        tok = self.take()
        if tok is None:
            return mrun('')
        kind, val = tok
        if kind == 'brace':
            if val == '{':
                inner = self.parse_seq(stop='}')
                if self.peek() == ('brace', '}'):
                    self.take()
                return self._wrap(inner)
            return mrun('')
        if kind == 'char':
            return self._char_atom(val)
        if kind == 'begin':
            return self.parse_environment(val)
        if kind == 'cmd':
            return self.cmd_atom(val)
        if kind == 'amp':
            return mrun('\u00a0')
        return mrun('')

    @staticmethod
    def _wrap(items):
        """Represent a group that must become a single atom."""
        if len(items) == 1:
            return items[0]
        box = E('e')
        for it in items:
            box.append(it)
        return box

    def _char_atom(self, ch):
        if ch == '~':
            return mrun('\u00a0')
        if ch == '-':
            return mrun('\u2212')
        if ch == '*':
            return mrun('\u2217')
        if ch == "'":
            return mrun('\u2032')
        if ch in '()[]|':
            return mrun(ch)
        if ch.isdigit():
            return mrun(ch, plain=True)
        return mrun(ch)

    # ---- commands -------------------------------------------------------
    def cmd_atom(self, name):
        if name in SPACES:
            return mrun(SPACES[name])
        if name in IGNORED_CMDS:
            return mrun('')
        if name in SYMBOLS and name not in NARY:
            return mrun(SYMBOLS[name])
        if name in ACCENTS:
            arg = self.parse_group()
            acc = E('acc')
            pr = etree.SubElement(acc, q('accPr'))
            ch = etree.SubElement(pr, q('chr'))
            ch.set(q('val'), ACCENTS[name])
            acc.append(E('e', *arg))
            return acc
        if name in ('overline', 'underline'):
            arg = self.parse_group()
            bar = E('bar')
            pr = etree.SubElement(bar, q('barPr'))
            pos = etree.SubElement(pr, q('pos'))
            pos.set(q('val'), 'top' if name == 'overline' else 'bot')
            bar.append(E('e', *arg))
            return bar
        if name in ('frac', 'dfrac', 'tfrac'):
            num = self.parse_group()
            den = self.parse_group()
            return E('f', E('num', *num), E('den', *den))
        if name == 'sqrt':
            deg = None
            tok = self.peek()
            if tok == ('char', '['):
                self.take()
                degitems = []
                while self.peek() is not None and self.peek() != ('char', ']'):
                    degitems.append(self.parse_atom())
                if self.peek() is not None:
                    self.take()
                deg = degitems
            body = self.parse_group()
            rad = E('rad')
            pr = etree.SubElement(rad, q('radPr'))
            if deg is None:
                dh = etree.SubElement(pr, q('degHide'))
                dh.set(q('val'), '1')
                rad.append(E('deg'))
            else:
                rad.append(E('deg', *deg))
            rad.append(E('e', *body))
            return rad
        if name in NARY:
            return self._nary(name)
        if name in FUNCS:
            return self._func(name)
        if name in PLAIN_TEXT_CMDS or name in ('mathbf', 'boldsymbol', 'bm',
                                               'mathit', 'mathsf', 'mathtt'):
            return mrun(self._read_raw_group_text(), plain=True)
        if name in ('cdotp', 'ldotp'):
            return mrun('\u22c5')
        if name in ('lVert', 'rVert', 'Vert'):
            return mrun('\u2016')
        if name in ('{', '}', '%', '&', '#', '_', '$', ' '):
            return mrun(name, plain=True)
        if len(name) == 1:
            return self._char_atom(name)
        raise TexError('unknown LaTeX command: \\%s' % name)

    def _func(self, name):
        # CT_Func requires <m:funcPr/><m:fName/><m:e/> - the name must go in
        # m:fName, never m:e.  Plain upright runs render identically, so use them
        # and reserve m:limLow for names that carry an under-limit.
        if name in ('lim', 'limsup', 'liminf', 'min', 'max', 'sup', 'inf'):
            low = None
            if self.peek() == ('_', '_'):
                self.take()
                low = self.parse_group()
            if low is not None:
                node = E('limLow')
                node.append(E('e', mrun(name, plain=True)))
                node.append(E('lim', *low))
                return node
        return mrun(name, plain=True)

    def _nary(self, name):
        node = E('nary')
        pr = etree.SubElement(node, q('naryPr'))
        ch = etree.SubElement(pr, q('chr'))
        ch.set(q('val'), NARY[name])
        limloc = etree.SubElement(pr, q('limLoc'))
        limloc.set(q('val'), 'subSup' if name in ('int', 'oint', 'iint')
                   else 'undOvr')
        grow = etree.SubElement(pr, q('grow'))
        grow.set(q('val'), '1')
        sub = sup = None
        while self.peek() is not None and self.peek()[0] in ('_', '^'):
            k = self.take()[0]
            arg = self.parse_group()
            if k == '_':
                sub = arg
            else:
                sup = arg
        node.append(E('sub', *sub) if sub else E('sub'))
        node.append(E('sup', *sup) if sup else E('sup'))
        operand = self._nary_operand()
        node.append(E('e', *operand) if operand else E('e'))
        return node

    def _nary_operand(self):
        """The operand of an n-ary operator: everything up to the delimiter that
        closes the surrounding group.  This must go through the sequence parser so
        that scripts and brace groups are handled - using parse_atom() here emits
        stray empty runs and nested m:e elements and corrupts the document."""
        return self.parse_seq(stop='}', stop_chars=')]}', stop_right=True)

    def _read_raw_group_text(self):
        tok = self.peek()
        if tok == ('brace', '{'):
            self.take()
            depth = 1
            out = []
            while not self.at_end():
                t = self.take()
                if t == ('brace', '{'):
                    depth += 1
                    out.append('{')
                elif t == ('brace', '}'):
                    depth -= 1
                    if depth == 0:
                        break
                    out.append('}')
                elif t[0] == 'cmd':
                    out.append(t[1] if len(t[1]) == 1 else '\\' + t[1])
                elif t[0] == 'char':
                    out.append(t[1])
                elif t[0] in ('^', '_'):
                    out.append(t[0])
                else:
                    out.append(' ')
            return ''.join(out)
        atom = self.parse_atom()
        if atom.tag == q('r'):
            return atom.find(q('t')).text or ''
        return ''

    # ---- environments ---------------------------------------------------
    def parse_environment(self, name):
        rows = []
        row = []
        while not self.at_end():
            tok = self.peek()
            if tok[0] == 'end':
                self.take()
                break
            if tok[0] == 'row':
                self.take()
                rows.append(row)
                row = []
                continue
            if tok[0] == 'amp':
                self.take()
                row.append(None)
                continue
            row.append(self.parse_seq())
        if row:
            rows.append(row)
        cells = [[c for c in r if c is not None] for r in rows]

        def make_row(cells_row):
            line = E('e')
            for k, c in enumerate(cells_row):
                if k:
                    line.append(mrun('  '))
                if isinstance(c, list):
                    for it in c:
                        line.append(it)
                elif c is not None:
                    line.append(c)
            return line

        if name in ('cases', 'dcases', 'cases*'):
            arr = E('eqArr')
            arr.append(E('eqArrPr'))
            for r in cells:
                arr.append(make_row(r))
            d = E('d')
            pr = etree.SubElement(d, q('dPr'))
            beg = etree.SubElement(pr, q('begChr'))
            beg.set(q('val'), '{')
            end = etree.SubElement(pr, q('endChr'))
            end.set(q('val'), '')
            d.append(E('e', arr))
            return d
        if name in ('array', 'aligned', 'align', 'split', 'gathered'):
            arr = E('eqArr')
            arr.append(E('eqArrPr'))
            for r in cells:
                arr.append(make_row(r))
            return arr
        if name in ('matrix', 'pmatrix', 'bmatrix', 'vmatrix', 'Bmatrix'):
            m = E('m')
            pr = etree.SubElement(m, q('mPr'))
            mcs = etree.SubElement(pr, q('mcs'))
            mc = etree.SubElement(mcs, q('mc'))
            mcp = etree.SubElement(mc, q('mcPr'))
            cnt = etree.SubElement(mcp, q('count'))
            cnt.set(q('val'), str(max(len(r) for r in cells) if cells else 1))
            jc = etree.SubElement(mcp, q('mcJc'))
            jc.set(q('val'), 'center')
            for r in cells:
                mr = E('mr')
                for c in r:
                    arg = E('e')
                    if isinstance(c, list):
                        for it in c:
                            arg.append(it)
                    elif c is not None:
                        arg.append(c)
                    mr.append(arg)
                m.append(mr)
            beg, end = {'pmatrix': ('(', ')'), 'bmatrix': ('[', ']'),
                        'vmatrix': ('|', '|'), 'Bmatrix': ('{', '}')}.get(
                            name, ('', ''))
            if beg or end:
                d = E('d')
                dpr = etree.SubElement(d, q('dPr'))
                b = etree.SubElement(dpr, q('begChr')); b.set(q('val'), beg)
                e2 = etree.SubElement(dpr, q('endChr')); e2.set(q('val'), end)
                d.append(E('e', m))
                return d
            return m
        flat = []
        for r in cells:
            for c in r:
                if isinstance(c, list):
                    flat.extend(c)
                elif c is not None:
                    flat.append(c)
        return self._wrap(flat)


# --------------------------------------------------------------------------
# public API
# --------------------------------------------------------------------------
def latex_to_omml(latex):
    """Return an <m:oMath> element for the given LaTeX string."""
    parser = Parser(tokenize(latex))
    items = parser.parse_seq()
    math = E('oMath')
    for it in items:
        math.append(it)
    return math


def latex_to_omml_para(latex, center=True):
    """Return an <m:oMathPara> element (display equation)."""
    para = E('oMathPara')
    pr = etree.SubElement(para, q('oMathParaPr'))
    jc = etree.SubElement(pr, q('jc'))
    jc.set(q('val'), 'center' if center else 'left')
    para.append(latex_to_omml(latex))
    return para
