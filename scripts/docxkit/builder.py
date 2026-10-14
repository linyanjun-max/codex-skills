# -*- coding: utf-8 -*-
"""A small OOXML (.docx) writer.

Builds a Word document from a simple block model, with real OMML equations,
embedded figures, headings, captions, a page footer and an auto-updating TOC field.
Requires only lxml (Pillow is optional, used to size figures).

Block model (list of tuples):
    ('h', level, text)
    ('p', text)                      # inline $...$ math and **bold**
    ('eq', latex, number_or_None)
    ('fig', image_path, caption)
    ('bullet', text)
    ('pagebreak',)
    ('toc',)
    ('center', text, size, bold, before, after)
"""
import os
import re
import zipfile
from lxml import etree

from . import texomml as T

W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing'
A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
PIC = 'http://schemas.openxmlformats.org/drawingml/2006/picture'
M = T.M
XML = 'http://www.w3.org/XML/1998/namespace'

NSMAP = {'w': W, 'r': R, 'wp': WP, 'a': A, 'pic': PIC, 'm': M}

PAGE_W = 11906                 # A4 portrait, twips
MARGIN = 1247                  # ~2.2 cm
CONTENT_W = PAGE_W - 2 * MARGIN
TAB_CENTER = CONTENT_W // 2
TAB_RIGHT = CONTENT_W

MAX_FIG_IN = 6.3
EMU_PER_IN = 914400

EA_BODY = '\u5b8b\u4f53'       # SimSun
EA_HEAD = '\u9ed1\u4f53'       # SimHei


def w(tag):
    return '{%s}%s' % (W, tag)


def sub(parent, tag, **attrs):
    e = etree.SubElement(parent, w(tag))
    for k, v in attrs.items():
        e.set(k if k.startswith('{') else w(k), str(v))
    return e


# ---------------------------------------------------------------------------
# inline text
# ---------------------------------------------------------------------------
TOKEN_RE = re.compile(r'(\$[^$]+\$|\*\*[^*]+\*\*)')


def _run(text, bold=False, italic=False, size=None, color=None,
         font_ea=None, font_ascii=None):
    r = etree.Element(w('r'))
    rpr = etree.SubElement(r, w('rPr'))
    if font_ascii or font_ea:
        rf = etree.SubElement(rpr, w('rFonts'))
        rf.set(w('ascii'), font_ascii or 'Times New Roman')
        rf.set(w('hAnsi'), font_ascii or 'Times New Roman')
        rf.set(w('eastAsia'), font_ea or EA_BODY)
    if bold:
        etree.SubElement(rpr, w('b'))
        etree.SubElement(rpr, w('bCs'))
    if italic:
        etree.SubElement(rpr, w('i'))
        etree.SubElement(rpr, w('iCs'))
    if color:
        c = etree.SubElement(rpr, w('color'))
        c.set(w('val'), color)
    if size:
        s = etree.SubElement(rpr, w('sz'))
        s.set(w('val'), str(int(size * 2)))
        sc = etree.SubElement(rpr, w('szCs'))
        sc.set(w('val'), str(int(size * 2)))
    t = etree.SubElement(r, w('t'))
    t.set('{%s}space' % XML, 'preserve')
    t.text = text
    return r


def inline_runs(parent, text, base_bold=False, font_ea=None, font_ascii=None):
    """Append runs for `text`, handling $math$ and **bold**."""
    for part in TOKEN_RE.split(text):
        if not part:
            continue
        if part.startswith('$') and part.endswith('$') and len(part) > 2:
            try:
                parent.append(T.latex_to_omml(part[1:-1]))
            except Exception:
                parent.append(_run(part, bold=base_bold, font_ea=font_ea,
                                   font_ascii=font_ascii))
        elif part.startswith('**') and part.endswith('**') and len(part) > 4:
            parent.append(_run(part[2:-2], bold=True,
                               font_ea=font_ea or EA_HEAD,
                               font_ascii=font_ascii))
        else:
            parent.append(_run(part, bold=base_bold, font_ea=font_ea,
                               font_ascii=font_ascii))


def _tab():
    r = etree.Element(w('r'))
    etree.SubElement(r, w('tab'))
    return r


# ---------------------------------------------------------------------------
# static package parts
# ---------------------------------------------------------------------------
STYLES = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="{w}" xmlns:m="{m}">
 <w:docDefaults>
  <w:rPrDefault><w:rPr>
    <w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="\u5b8b\u4f53" w:cs="Times New Roman"/>
    <w:sz w:val="22"/><w:szCs w:val="22"/>
  </w:rPr></w:rPrDefault>
  <w:pPrDefault><w:pPr>
    <w:spacing w:before="60" w:after="60" w:line="320" w:lineRule="auto"/>
    <w:jc w:val="both"/>
  </w:pPr></w:pPrDefault>
 </w:docDefaults>
 <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
 <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:qFormat/>
   <w:pPr><w:keepNext/><w:spacing w:before="340" w:after="200" w:line="300" w:lineRule="auto"/><w:jc w:val="center"/>
     <w:outlineLvl w:val="0"/></w:pPr>
   <w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="\u9ed1\u4f53"/><w:b/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:style>
 <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:qFormat/>
   <w:pPr><w:keepNext/><w:spacing w:before="300" w:after="140"/><w:jc w:val="left"/>
     <w:outlineLvl w:val="1"/></w:pPr>
   <w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="\u9ed1\u4f53"/><w:b/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style>
 <w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:qFormat/>
   <w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:jc w:val="left"/>
     <w:outlineLvl w:val="2"/></w:pPr>
   <w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="\u9ed1\u4f53"/><w:b/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style>
 <w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="heading 4"/><w:basedOn w:val="Normal"/><w:qFormat/>
   <w:pPr><w:keepNext/><w:spacing w:before="180" w:after="100"/><w:jc w:val="left"/>
     <w:outlineLvl w:val="3"/></w:pPr>
   <w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="\u9ed1\u4f53"/><w:b/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:style>
 <w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="Caption"/><w:basedOn w:val="Normal"/>
   <w:pPr><w:spacing w:before="60" w:after="180" w:line="260" w:lineRule="auto"/><w:jc w:val="center"/></w:pPr>
   <w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="\u5b8b\u4f53"/><w:sz w:val="19"/><w:szCs w:val="19"/></w:rPr></w:style>
 <w:style w:type="paragraph" w:styleId="EqPara"><w:name w:val="Equation Para"/><w:basedOn w:val="Normal"/>
   <w:pPr><w:spacing w:before="120" w:after="120" w:line="280" w:lineRule="auto"/></w:pPr></w:style>
 <w:style w:type="paragraph" w:styleId="BodyCN"><w:name w:val="Body CN"/><w:basedOn w:val="Normal"/>
   <w:pPr><w:spacing w:before="80" w:after="80" w:line="330" w:lineRule="auto"/><w:ind w:firstLineChars="200" w:firstLine="440"/></w:pPr>
 </w:style>
</w:styles>'''

NUMBERING = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="{w}">
 <w:abstractNum w:abstractNumId="0">
  <w:multiLevelType w:val="hybridMultilevel"/>
  <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="\u25cf"/><w:lvlJc w:val="left"/>
    <w:pPr><w:ind w:left="780" w:hanging="360"/></w:pPr>
    <w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol" w:hint="default"/></w:rPr></w:lvl>
  <w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="\u25cb"/><w:lvlJc w:val="left"/>
    <w:pPr><w:ind w:left="1560" w:hanging="360"/></w:pPr>
    <w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:hint="default"/></w:rPr></w:lvl>
 </w:abstractNum>
 <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
</w:numbering>'''

FOOTER = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr xmlns:w="{w}" xmlns:r="{r}">
 <w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="0" w:after="0"/></w:pPr>
  <w:r><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="\u5b8b\u4f53"/><w:sz w:val="18"/></w:rPr>
   <w:t xml:space="preserve">- </w:t></w:r>
  <w:r><w:fldChar w:fldCharType="begin"/></w:r>
  <w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>
  <w:r><w:fldChar w:fldCharType="separate"/></w:r>
  <w:r><w:t>1</w:t></w:r>
  <w:r><w:fldChar w:fldCharType="end"/></w:r>
  <w:r><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="\u5b8b\u4f53"/><w:sz w:val="18"/></w:rPr>
   <w:t xml:space="preserve"> -</w:t></w:r>
 </w:p>
</w:ftr>'''

RELS_ROOT = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
 <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
 <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>'''

CONTENT_TYPES = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="xml" ContentType="application/xml"/>
 <Default Extension="png" ContentType="image/png"/>
 <Default Extension="jpg" ContentType="image/jpeg"/>
 <Default Extension="jpeg" ContentType="image/jpeg"/>
 <Default Extension="gif" ContentType="image/gif"/>
 <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
 <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
 <Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
 <Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>
 <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
 <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>'''


class Docx(object):
    def __init__(self, title='', creator=''):
        self.blocks = []
        self.media = []
        self._media_seen = {}
        self.title = title
        self.creator = creator

    # -- block API ------------------------------------------------------
    def h(self, level, text):
        self.blocks.append(('h', level, text))

    def p(self, text):
        self.blocks.append(('p', text))

    def raw(self, text):
        self.blocks.append(('raw', text))

    def eq(self, latex, number=None):
        self.blocks.append(('eq', latex, number))

    def eqn(self, latex):
        self.blocks.append(('eq', latex, None))

    def fig(self, path, caption, width_in=None):
        self.blocks.append(('fig', path, caption, width_in))

    def bullet(self, text):
        self.blocks.append(('bullet', text))

    def pagebreak(self):
        self.blocks.append(('pagebreak',))

    def toc(self):
        self.blocks.append(('toc',))

    def center(self, text, size=12, bold=False, before=0, after=0):
        self.blocks.append(('center', text, size, bold, before, after))

    def raw_math(self, xml):
        """Append a hand-written <m:oMath> fragment (diagnostics only)."""
        self.blocks.append(('mathxml', xml))

    # -- media ----------------------------------------------------------
    def _media(self, path):
        key = os.path.abspath(path)
        if key in self._media_seen:
            return self._media_seen[key]
        name = 'image%d%s' % (len(self.media) + 1,
                              os.path.splitext(path)[1].lower())
        self.media.append((name, path))
        self._media_seen[key] = name
        return name

    def _rel_id_for(self, media_name):
        idx = [m[0] for m in self.media].index(media_name)
        return 'rIdImg%d' % (idx + 1)

    # -- rendering ------------------------------------------------------
    def _para(self, style=None, jc=None, before=None, after=None, line=None,
              ind=None):
        """Create a paragraph with pPr children in OOXML canonical order:
        pStyle, keepNext..., tabs, spacing, ind, jc, outlineLvl."""
        p = etree.Element(w('p'))
        ppr = etree.SubElement(p, w('pPr'))
        if style:
            ps = etree.SubElement(ppr, w('pStyle'))
            ps.set(w('val'), style)
        if before is not None or after is not None or line is not None:
            sp = etree.SubElement(ppr, w('spacing'))
            sp.set(w('before'), str(before if before is not None else 0))
            sp.set(w('after'), str(after if after is not None else 0))
            if line is not None:
                sp.set(w('line'), str(line))
                sp.set(w('lineRule'), 'auto')
        if ind:
            ie = etree.SubElement(ppr, w('ind'))
            for k, v in ind.items():
                ie.set(w(k), str(v))
        if jc:
            j = etree.SubElement(ppr, w('jc'))
            j.set(w('val'), jc)
        return p

    def _render(self):
        body = etree.Element(w('body'))
        img_id = [1]

        for blk in self.blocks:
            kind = blk[0]

            if kind == 'h':
                lvl = max(1, min(4, blk[1]))
                p = self._para(style='Heading%d' % lvl)
                p.append(_run(blk[2], bold=True, font_ea=EA_HEAD,
                              size=(16, 14, 12, 11)[lvl - 1]))
                body.append(p)

            elif kind == 'p':
                p = self._para(style='BodyCN')
                inline_runs(p, blk[1])
                body.append(p)

            elif kind == 'raw':
                p = self._para()
                inline_runs(p, blk[1])
                body.append(p)

            elif kind == 'bullet':
                p = etree.Element(w('p'))
                ppr = etree.SubElement(p, w('pPr'))
                ps = etree.SubElement(ppr, w('pStyle'))
                ps.set(w('val'), 'BodyCN')
                ind = etree.SubElement(ppr, w('ind'))
                ind.set(w('left'), '780')
                ind.set(w('hanging'), '360')
                ind.set(w('firstLineChars'), '0')
                ind.set(w('firstLine'), '0')
                inline_runs(p, '\u25cf  ' + blk[1])
                body.append(p)

            elif kind == 'eq':
                latex, number = blk[1], blk[2]
                p = etree.Element(w('p'))
                ppr = etree.SubElement(p, w('pPr'))
                ps = etree.SubElement(ppr, w('pStyle'))
                ps.set(w('val'), 'EqPara')
                if number:
                    tabs = etree.SubElement(ppr, w('tabs'))
                    t1 = etree.SubElement(tabs, w('tab'))
                    t1.set(w('val'), 'center'); t1.set(w('pos'), str(TAB_CENTER))
                    t2 = etree.SubElement(tabs, w('tab'))
                    t2.set(w('val'), 'right'); t2.set(w('pos'), str(TAB_RIGHT))
                    p.append(_tab())
                    p.append(T.latex_to_omml(latex))
                    p.append(_tab())
                    p.append(_run('(%s)' % number))
                else:
                    j = etree.SubElement(ppr, w('jc'))
                    j.set(w('val'), 'center')
                    p.append(T.latex_to_omml(latex))
                body.append(p)

            elif kind == 'fig':
                path, caption = blk[1], blk[2]
                width_in = blk[3] if len(blk) > 3 else None
                name = self._media(path)
                try:
                    from PIL import Image
                    iw, ih = Image.open(path).size
                except Exception:
                    iw, ih = 800, 400
                if width_in is None:
                    width_in = min(MAX_FIG_IN, iw / 220.0)
                    width_in = max(width_in, 1.2)
                height_in = width_in * ih / float(iw)
                if height_in > 8.2:
                    height_in = 8.2
                    width_in = height_in * iw / float(ih)
                cx = int(width_in * EMU_PER_IN)
                cy = int(height_in * EMU_PER_IN)

                p = self._para(jc='center', before=120, after=60, line=240)
                run = etree.SubElement(p, w('r'))
                drawing = etree.SubElement(run, w('drawing'))
                inl = etree.SubElement(drawing, '{%s}inline' % WP)
                inl.set('distT', '0'); inl.set('distB', '0')
                inl.set('distL', '0'); inl.set('distR', '0')
                ext = etree.SubElement(inl, '{%s}extent' % WP)
                ext.set('cx', str(cx)); ext.set('cy', str(cy))
                ef = etree.SubElement(inl, '{%s}effectExtent' % WP)
                for k in ('l', 't', 'r', 'b'):
                    ef.set(k, '0')
                dp = etree.SubElement(inl, '{%s}docPr' % WP)
                dp.set('id', str(img_id[0]))
                dp.set('name', 'Picture %d' % img_id[0])
                img_id[0] += 1
                gf = etree.SubElement(inl, '{%s}graphic' % A)
                gd = etree.SubElement(gf, '{%s}graphicData' % A)
                gd.set('uri', PIC)
                pic = etree.SubElement(gd, '{%s}pic' % PIC)
                nvp = etree.SubElement(pic, '{%s}nvPicPr' % PIC)
                cnv = etree.SubElement(nvp, '{%s}cNvPr' % PIC)
                cnv.set('id', '0'); cnv.set('name', name)
                etree.SubElement(nvp, '{%s}cNvPicPr' % PIC)
                bf = etree.SubElement(pic, '{%s}blipFill' % PIC)
                blip = etree.SubElement(bf, '{%s}blip' % A)
                blip.set('{%s}embed' % R, self._rel_id_for(name))
                stretch = etree.SubElement(bf, '{%s}stretch' % A)
                etree.SubElement(stretch, '{%s}fillRect' % A)
                sppr = etree.SubElement(pic, '{%s}spPr' % PIC)
                xfrm = etree.SubElement(sppr, '{%s}xfrm' % A)
                off = etree.SubElement(xfrm, '{%s}off' % A)
                off.set('x', '0'); off.set('y', '0')
                ext2 = etree.SubElement(xfrm, '{%s}ext' % A)
                ext2.set('cx', str(cx)); ext2.set('cy', str(cy))
                geom = etree.SubElement(sppr, '{%s}prstGeom' % A)
                geom.set('prst', 'rect')
                etree.SubElement(geom, '{%s}avLst' % A)
                body.append(p)

                if caption:
                    cp = self._para(style='Caption', jc='center')
                    inline_runs(cp, caption)
                    body.append(cp)

            elif kind == 'center':
                _, text, size, bold, before, after = blk
                p = self._para(jc='center', before=before, after=after,
                               line=300)
                p.append(_run(text, bold=bold, size=size,
                              font_ea=EA_HEAD if bold else EA_BODY))
                body.append(p)

            elif kind == 'mathxml':
                p = self._para(jc='center')
                wrapper = ('<m:oMath xmlns:m="%s" xmlns:w="%s">%s</m:oMath>'
                           % (M, W, blk[1]))
                p.append(etree.fromstring(wrapper))
                body.append(p)

            elif kind == 'pagebreak':
                p = etree.Element(w('p'))
                r = etree.SubElement(p, w('r'))
                br = etree.SubElement(r, w('br'))
                br.set(w('type'), 'page')
                body.append(p)

            elif kind == 'toc':
                p = etree.Element(w('p'))
                etree.SubElement(p, w('pPr'))
                r1 = etree.SubElement(p, w('r'))
                fc = etree.SubElement(r1, w('fldChar'))
                fc.set(w('fldCharType'), 'begin')
                fc.set(w('dirty'), 'true')
                r2 = etree.SubElement(p, w('r'))
                it = etree.SubElement(r2, w('instrText'))
                it.set('{%s}space' % XML, 'preserve')
                it.text = ' TOC \\o "1-3" \\h \\z \\u '
                r3 = etree.SubElement(p, w('r'))
                etree.SubElement(r3, w('fldChar')).set(w('fldCharType'),
                                                      'separate')
                r4 = etree.SubElement(p, w('r'))
                t4 = etree.SubElement(r4, w('t'))
                t4.text = '\uff08\u8bf7\u5728 Word \u4e2d\u53f3\u952e\u6b64\u5904\u5e76\u9009\u62e9\u201c\u66f4\u65b0\u57df\u201d\u4ee5\u751f\u6210\u76ee\u5f55\uff09'
                r5 = etree.SubElement(p, w('r'))
                etree.SubElement(r5, w('fldChar')).set(w('fldCharType'), 'end')
                body.append(p)

        # CT_SectPr requires the header/footer references (EG_HdrFtrReferences)
        # to precede footnotePr/pgSz/pgMar; putting footerReference last makes
        # Word reject the package as corrupt.
        sect = etree.SubElement(body, w('sectPr'))
        ftr = etree.SubElement(sect, w('footerReference'))
        ftr.set(w('type'), 'default')
        ftr.set('{%s}id' % R, 'rIdFooter1')
        pg = etree.SubElement(sect, w('pgSz'))
        pg.set(w('w'), str(PAGE_W)); pg.set(w('h'), '16838')
        mar = etree.SubElement(sect, w('pgMar'))
        mar.set(w('top'), '1247'); mar.set(w('right'), str(MARGIN))
        mar.set(w('bottom'), '1247'); mar.set(w('left'), str(MARGIN))
        mar.set(w('header'), '851'); mar.set(w('footer'), '851')
        mar.set(w('gutter'), '0')
        return body

    # -- package --------------------------------------------------------
    def save(self, outpath):
        body = self._render()
        doc = etree.Element(w('document'), nsmap=NSMAP)
        body_el = etree.SubElement(doc, w('body'))
        for child in body:
            body_el.append(child)
        xml_doc = etree.tostring(doc, xml_declaration=True, encoding='UTF-8',
                                 standalone=True)

        rels = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
                '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
                '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
                '<Relationship Id="rIdNumbering" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>',
                '<Relationship Id="rIdFooter1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>']
        for i, (name, _path) in enumerate(self.media):
            rels.append('<Relationship Id="rIdImg%d" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/%s"/>' % (i + 1, name))
        rels.append('</Relationships>')
        doc_rels = '\n'.join(rels)

        core = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
                '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
                'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" '
                'xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
                '<dc:title>%s</dc:title><dc:creator>%s</dc:creator>'
                '<cp:lastModifiedBy>docxkit</cp:lastModifiedBy>'
                '</cp:coreProperties>' % (_esc(self.title), _esc(self.creator)))
        app = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
               '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" '
               'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">'
               '<Application>docxkit</Application></Properties>')

        os.makedirs(os.path.dirname(os.path.abspath(outpath)) or '.', exist_ok=True)
        with zipfile.ZipFile(outpath, 'w', zipfile.ZIP_DEFLATED) as z:
            z.writestr('[Content_Types].xml', CONTENT_TYPES)
            z.writestr('_rels/.rels', RELS_ROOT)
            z.writestr('word/document.xml', xml_doc)
            z.writestr('word/_rels/document.xml.rels', doc_rels)
            z.writestr('word/styles.xml', STYLES.format(w=W, m=M))
            z.writestr('word/numbering.xml', NUMBERING.format(w=W))
            z.writestr('word/footer1.xml', FOOTER.format(w=W, r=R))
            z.writestr('docProps/core.xml', core)
            z.writestr('docProps/app.xml', app)
            for name, path in self.media:
                with open(path, 'rb') as fh:
                    z.writestr('word/media/%s' % name, fh.read())
        return outpath


def _esc(s):
    return (s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;'))
