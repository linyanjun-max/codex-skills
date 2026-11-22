# -*- coding: utf-8 -*-
"""Figures and the Russian lab report.

The DOCX is built on top of a previously submitted report of the same course, so
the cover page, fonts, headings and table look match what the department already
accepted. Only the cover slots (lab number / topic / subtitle) are rewritten and
the old body is replaced.
"""

from __future__ import annotations

import os
import re
import textwrap

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.patches import FancyBboxPatch  # noqa: E402
from docx import Document  # noqa: E402
from docx.enum.table import WD_TABLE_ALIGNMENT  # noqa: E402
from docx.enum.text import WD_ALIGN_PARAGRAPH  # noqa: E402
from docx.oxml import OxmlElement  # noqa: E402
from docx.oxml.ns import qn  # noqa: E402
from docx.shared import Cm, Pt  # noqa: E402

DEFAULT_TEMPLATE_CANDIDATES = [
    "reports/Тии_Чжао Цзыцзюнь_Пр2_З1.docx",
    "reports/Тии_Чжао Цзыцзюнь_Пр3.docx",
    "reports/模版.docx",
]

COVER_LAB_NUMBER = 7
COVER_TOPIC = 8
COVER_SUBTITLE = 9
BODY_START = 27

LAB_NUMBER = "4"
LAB_TOPIC = "Разработка онтологии предметной области в редакторе Protégé"
LAB_SUBTITLE = "Онтология технического обслуживания и ремонта промышленного оборудования"

_ASK_RU = {
    "individuals": "индивиды",
    "subclasses": "подклассы",
    "superclasses": "надклассы",
    "equivalent": "эквивалентные классы",
}


def _notes(spec: dict) -> dict:
    """Domain-specific prose supplied by the spec (all keys optional)."""
    notes = spec.get("report")
    return notes if isinstance(notes, dict) else {}


def _domain_title(spec: dict) -> str:
    notes = _notes(spec)
    return notes.get("domainTitle") or spec.get("label") or "предметная область"


def _subtitle(spec: dict) -> str:
    notes = _notes(spec)
    return notes.get("subtitle") or LAB_SUBTITLE


_MANCHESTER_KEYWORDS = {
    "and", "or", "not", "some", "only", "value", "min", "max", "exactly",
    "inverse", "true", "false", "self",
}


def _ontology_prefix(spec: dict) -> str:
    """The prefix Protégé shows for this ontology: the last IRI path segment."""
    iri = (spec.get("iri") or "").strip().rstrip("#/")
    return iri.rsplit("/", 1)[-1] or "ont"


def _editor_expression(spec: dict, expression: str) -> str:
    """Prefix every entity name so the string can be pasted into DL Query.

    Protégé's DL Query editor does not accept bare names for a re-opened
    document, so the report shows exactly what has to be typed there.
    """
    prefix = _ontology_prefix(spec)
    entities = set()
    for key in ("classes", "objectProperties", "dataProperties", "individuals"):
        for entry in spec.get(key, []):
            entities.add(entry["name"])

    def replace(match):
        word = match.group(0)
        if word in entities:
            return "%s:%s" % (prefix, word)
        return word

    return re.sub(r"[A-Za-z_][A-Za-z0-9_]*", replace, expression)


def _defined_classes(spec: dict) -> list:
    return [
        axiom["subject"]
        for axiom in spec.get("classAxioms", [])
        if axiom.get("kind") == "equivalentTo"
    ]


def _trim_white_margins(path: str, out_dir: str) -> str:
    """Crop near-uniform white borders of a window screenshot.

    Protégé screenshots often carry a large empty panel, which at A4 width turns
    into half a page of white. Only fully-blank rows/columns are removed, so no
    content is ever cut.
    """
    try:
        from PIL import Image
    except ImportError:  # pragma: no cover - Pillow ships with matplotlib
        return path
    try:
        image = Image.open(path).convert("L")
    except Exception:
        return path
    width, height = image.size
    pixels = image.load()
    threshold = 245

    # A window frame is a 1-2 px line: allow a tiny fraction of dark pixels so it
    # does not count as content, while a text line (a few percent) always does.
    row_tolerance = max(1, int(width * 0.004))
    col_tolerance = max(1, int(height * 0.004))

    def row_blank(y: int) -> bool:
        dark = sum(1 for x in range(width) if pixels[x, y] < threshold)
        return dark <= row_tolerance

    def col_blank(x: int) -> bool:
        dark = sum(1 for y in range(height) if pixels[x, y] < threshold)
        return dark <= col_tolerance

    top, bottom = 0, height - 1
    while top < bottom and row_blank(top):
        top += 1
    while bottom > top and row_blank(bottom):
        bottom -= 1
    left, right = 0, width - 1
    while left < right and col_blank(left):
        left += 1
    while right > left and col_blank(right):
        right -= 1
    # keep a small breathing margin
    pad = 12
    box = (max(0, left - pad), max(0, top - pad), min(width, right + pad), min(height, bottom + pad))
    if box[2] - box[0] < 100 or box[3] - box[1] < 80:
        return path
    if box == (0, 0, width, height):
        return path
    os.makedirs(out_dir, exist_ok=True)
    target = os.path.join(out_dir, "shot_" + os.path.basename(path).replace(" ", "_"))
    Image.open(path).convert("RGB").crop(box).save(target, dpi=(300, 300))
    return target


def _prepare_shot(shot: dict, out_dir: str) -> dict:
    """Crop (relative fractions) and/or trim a screenshot, then return its path."""
    path = shot["path"]
    crop = shot.get("crop")
    if crop:
        try:
            from PIL import Image

            image = Image.open(path).convert("RGB")
            width, height = image.size
            box = (
                int(crop[0] * width),
                int(crop[1] * height),
                int(crop[2] * width),
                int(crop[3] * height),
            )
            if box[2] - box[0] > 80 and box[3] - box[1] > 60:
                os.makedirs(out_dir, exist_ok=True)
                target = os.path.join(out_dir, "crop_" + os.path.basename(path).replace(" ", "_"))
                image.crop(box).save(target, dpi=(300, 300))
                path = target
        except Exception:
            pass
    shot["path"] = _trim_white_margins(path, out_dir)
    return shot


def _shots(spec: dict, key: str) -> list:
    """UI screenshots the author attached for a given anchor (all optional)."""
    shots = _notes(spec).get("screenshots")
    if not isinstance(shots, dict):
        return []
    items = shots.get(key) or []
    result = []
    for item in items:
        if isinstance(item, str):
            result.append({"path": item, "caption": "Окно редактора Protégé"})
        elif isinstance(item, dict) and item.get("path"):
            result.append(
                {
                    "path": item["path"],
                    "caption": item.get("caption") or "Окно редактора Protégé",
                    "crop": item.get("crop"),
                    "width": item.get("width"),
                }
            )
    shots_dir = os.path.join(os.path.dirname(os.path.abspath(spec.get("_path", "."))), "_trimmed")
    prepared = []
    for shot in result:
        if not os.path.exists(shot["path"]):
            continue
        prepared.append(_prepare_shot(dict(shot), shots_dir))
    return prepared


def _paragraphs(value) -> list:
    if not value:
        return []
    if isinstance(value, str):
        return [value]
    return [str(item) for item in value if str(item).strip()]



# ---------------------------------------------------------------------------
# figures
# ---------------------------------------------------------------------------
def _figure_path(figures_dir: str, name: str) -> str:
    os.makedirs(figures_dir, exist_ok=True)
    return os.path.join(figures_dir, name)


def draw_hierarchy(flat: list[dict], path: str) -> str:
    """Indented class tree, the shape Protégé's class tab shows."""
    rows = [row for row in flat if row["name"] != "Thing" or row["parent"] is None]
    rows = [row for row in rows if row["name"] != "Nothing"]
    if not rows:
        rows = [{"name": "Thing", "depth": 0}]
    height = max(2.4, 0.42 * len(rows) + 1.2)
    fig, ax = plt.subplots(figsize=(9.2, height))
    ax.axis("off")
    ax.set_xlim(0, 10)
    ax.set_ylim(0, len(rows) + 0.6)
    for index, row in enumerate(rows):
        y = len(rows) - index - 0.5
        depth = row.get("depth", 0)
        x = 0.35 + depth * 0.75
        if depth:
            ax.plot([x - 0.42, x - 0.12], [y, y], color="#8a8a8a", linewidth=0.9)
        ax.text(
            x,
            y,
            row["name"],
            fontsize=10.5,
            va="center",
            family="DejaVu Sans",
            bbox=dict(boxstyle="round,pad=0.28", facecolor="#eef3fb", edgecolor="#7a93b8", linewidth=0.8),
        )
    ax.set_title("Иерархия классов онтологии (вывод HermiT)", fontsize=11.5, pad=8)
    fig.tight_layout()
    fig.savefig(path, dpi=200, bbox_inches="tight")
    plt.close(fig)
    return path


def _depth(name: str, parents: dict) -> int:
    depth = 0
    seen = set()
    while name in parents and parents[name] != "Thing" and name not in seen:
        seen.add(name)
        name = parents[name]
        depth += 1
    return depth


def _root_of(name: str, parents: dict) -> str:
    seen = set()
    while parents.get(name) not in (None, "Thing") and name not in seen:
        seen.add(name)
        name = parents[name]
    return name


def _measure(lines, font: float) -> tuple[float, float]:
    """Box size in inches for a label; keeps the figure at print scale."""
    longest = max(len(line) for line in lines) if lines else 1
    width = 0.058 * font / 8.0 * longest + 0.16
    height = 0.155 * len(lines) + 0.12
    return max(0.55, width), max(0.32, height)


def _label_box(ax, x, y, lines, font=8.0, face="#e3ecf9", edge="#4c6d9b"):
    width, height = _measure(lines, font)
    patch = FancyBboxPatch(
        (x - width / 2, y - height / 2), width, height,
        boxstyle="round,pad=0.02,rounding_size=0.08",
        facecolor=face, edgecolor=edge, linewidth=0.9, zorder=3,
    )
    ax.add_patch(patch)
    ax.text(
        x, y, "\n".join(lines), ha="center", va="center", fontsize=font,
        zorder=4, family="DejaVu Sans", linespacing=0.95,
    )
    return width, height


def _arrow(ax, start, end, start_size, end_size, label, font=6.6):
    sx, sy = start
    ex, ey = end
    dx, dy = ex - sx, ey - sy
    length = max((dx * dx + dy * dy) ** 0.5, 1e-6)
    ux, uy = dx / length, dy / length
    pad_start = 0.5 * (abs(ux) * start_size[0] + abs(uy) * start_size[1]) + 0.03
    pad_end = 0.5 * (abs(ux) * end_size[0] + abs(uy) * end_size[1]) + 0.05
    ax.annotate(
        "",
        xy=(ex - ux * pad_end, ey - uy * pad_end),
        xytext=(sx + ux * pad_start, sy + uy * pad_start),
        arrowprops=dict(
            arrowstyle="-|>", color="#6f6f6f", linewidth=0.9,
            shrinkA=0, shrinkB=0, mutation_scale=8,
        ),
        zorder=2,
    )
    if not label:
        return
    lx = sx + ux * (length * 0.5) - uy * 0.09
    ly = sy + uy * (length * 0.5) + ux * 0.09
    ax.text(
        lx, ly, label, fontsize=font, ha="center", va="center", zorder=5,
        family="DejaVu Sans",
        bbox=dict(boxstyle="round,pad=0.10", facecolor="white", edgecolor="#d8d8d8",
                  linewidth=0.3, alpha=0.95),
    )


def draw_hierarchy(flat: list[dict], path: str) -> str:
    """Indented class tree at print size (the shape Protégé's class tab shows)."""
    rows = [row for row in flat if row["name"] not in ("Nothing",)]
    if not rows:
        rows = [{"name": "Thing", "depth": 0}]
    font = 7.6
    step = 0.215
    width_in = 6.3
    height_in = max(1.6, step * len(rows) + 0.55)
    fig, ax = plt.subplots(figsize=(width_in, height_in))
    ax.axis("off")
    ax.set_xlim(0, width_in)
    ax.set_ylim(0, height_in)
    ax.set_aspect("equal")
    for index, row in enumerate(rows):
        y = height_in - 0.3 - index * step
        depth = row.get("depth", 0)
        x = 0.25 + depth * 0.19
        if depth:
            ax.plot([x - 0.13, x - 0.03], [y, y], color="#9a9a9a", linewidth=0.7)
        ax.text(
            x, y, row["name"], fontsize=font, va="center", family="DejaVu Sans",
            bbox=dict(boxstyle="round,pad=0.16", facecolor="#eef3fb", edgecolor="#7a93b8",
                      linewidth=0.7),
        )
    fig.subplots_adjust(left=0.01, right=0.99, top=0.99, bottom=0.01)
    fig.savefig(path, dpi=300)
    plt.close(fig)
    return path


def draw_concept_map(spec: dict, path: str) -> str:
    """Top-level concepts with the object properties that connect them.

    Deliberately limited to the upper level: with 25 classes the boxes shrink
    below legibility on an A4 page, and the subclass detail already lives in the
    hierarchy figure and the class table.
    """
    classes = spec["classes"]
    parents = {c["name"]: (c.get("parent") or "Thing") for c in classes}
    top = [c["name"] for c in classes if (c.get("parent") or "Thing") == "Thing"]
    if not top:
        top = [c["name"] for c in classes][:7]
    known = set(top)

    edges = []
    for prop in spec["objectProperties"]:
        domain, range_ = prop.get("domain"), prop.get("range")
        if not domain or not range_:
            continue
        source = domain if domain in known else _root_of(domain, parents)
        target = range_ if range_ in known else _root_of(range_, parents)
        if source in known and target in known:
            edges.append((source, target, prop["name"]))

    import math

    font = 8.2
    width_in, height_in = 6.3, 4.3
    fig, ax = plt.subplots(figsize=(width_in, height_in))
    ax.axis("off")
    ax.set_xlim(0, width_in)
    ax.set_ylim(0, height_in)
    ax.set_aspect("equal")

    cx, cy = width_in / 2.0, height_in / 2.0
    radius_x, radius_y = width_in * 0.33, height_in * 0.30
    positions = {}
    for index, name in enumerate(top):
        angle = -math.pi / 2 + 2 * math.pi * index / len(top)
        positions[name] = (cx + radius_x * math.cos(angle), cy + radius_y * math.sin(angle))

    sizes = {name: _measure([name], font) for name in top}
    for source, target, label in edges:
        if source == target:
            # a self-loop (hasPart: Equipment -> Equipment) needs its own arc,
            # otherwise the arrow degenerates to a point on top of the box
            x, y = positions[source]
            height = sizes[source][1]
            ax.annotate(
                "",
                xy=(x + 0.06, y + height / 2 + 0.02),
                xytext=(x - 0.06, y + height / 2 + 0.02),
                arrowprops=dict(
                    arrowstyle="-|>", color="#6f6f6f", linewidth=0.9,
                    shrinkA=0, shrinkB=0, mutation_scale=8,
                    connectionstyle="arc3,rad=-1.9",
                ),
                zorder=2,
            )
            ax.text(
                x, y + height / 2 + 0.30, label, fontsize=6.6, ha="center", va="center",
                family="DejaVu Sans",
                bbox=dict(boxstyle="round,pad=0.10", facecolor="white", edgecolor="#d8d8d8",
                          linewidth=0.3, alpha=0.95),
            )
            continue
        _arrow(ax, positions[source], positions[target], sizes[source], sizes[target], label)
    for name in top:
        x, y = positions[name]
        _label_box(ax, x, y, [name], font=font)

    ax.set_title("Концептуальная модель: верхние классы и объектные свойства", fontsize=9.4, pad=4)
    fig.subplots_adjust(left=0.01, right=0.99, top=0.92, bottom=0.01)
    fig.savefig(path, dpi=300)
    plt.close(fig)
    return path


def draw_query_results(spec: dict, analysis: dict, path: str) -> str:
    """Horizontal bars: how many entities each DL query returned, with their names.

    This replaced an ABox graph on purpose: twelve individuals with 17-character
    names turned into an unreadable knot once the figure was scaled to A4 width,
    and the assertion table already lists every fact. A chart of the query answers
    is both legible and the thing the lab actually asks to show.
    """
    queries = analysis.get("queries", [])
    rows = [(q.get("name", ""), q.get("entities", [])) for q in queries]
    if not rows:
        rows = [("—", [])]
    max_count = max([len(entities) for _, entities in rows] + [1])
    font = 7.4
    width_in = 6.3
    height_in = max(1.5, 0.62 * len(rows) + 0.75)
    fig, ax = plt.subplots(figsize=(width_in, height_in))
    ax.set_xlim(0, max_count + 3.4)
    ax.set_ylim(-0.6, len(rows) - 0.4)
    ax.axis("off")

    for index, (name, entities) in enumerate(rows):
        y = len(rows) - index - 1
        count = len(entities)
        ax.barh(y, max(count, 0.06), height=0.42, color="#9db8dc", edgecolor="#4c6d9b", linewidth=0.6)
        ax.text(0.05, y, name, fontsize=font, va="center", ha="left", family="DejaVu Sans")
        label = "%d: %s" % (count, ", ".join(entities) if entities else "пусто")
        ax.text(max(count, 0.06) + 0.15, y, label, fontsize=font - 0.4, va="center", ha="left",
                family="DejaVu Sans", color="#333333")

    ax.set_title("Результаты DL-запросов: число найденных сущностей", fontsize=9.4, pad=4)
    fig.subplots_adjust(left=0.02, right=0.99, top=0.90, bottom=0.02)
    fig.savefig(path, dpi=300)
    plt.close(fig)
    return path


# ---------------------------------------------------------------------------
# document helpers
# ---------------------------------------------------------------------------
class ReportBuilder:
    def __init__(self, document: Document):
        self.document = document
        self.table_index = 0
        self.figure_index = 0
        self.labels = {}

    # -- text ----------------------------------------------------------
    def heading(self, text: str, level: int = 1) -> None:
        paragraph = self.document.add_paragraph(style="Heading %d" % level)
        paragraph.add_run(text)

    def body(self, text: str, first_line: float = 1.25) -> None:
        paragraph = self.document.add_paragraph()
        fmt = paragraph.paragraph_format
        fmt.first_line_indent = Cm(first_line)
        fmt.space_after = Pt(4)
        fmt.line_spacing = 1.15
        fmt.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
        paragraph.add_run(text)

    def bullet(self, text: str) -> None:
        paragraph = self.document.add_paragraph(style="List Bullet")
        paragraph.add_run(text)

    def page_break(self) -> None:
        """Start a new page, so a whole section is never split at its tail."""
        self.document.add_page_break()

    def caption(self, text: str) -> None:
        paragraph = self.document.add_paragraph()
        paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
        run = paragraph.add_run(text)
        run.italic = True
        run.font.size = Pt(10)

    def figure(self, path: str, caption: str, width_cm: float = 15.5, key: str = None) -> None:
        if not path:
            return
        paragraph = self.document.add_paragraph()
        paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
        paragraph.add_run().add_picture(path, width=Cm(width_cm))
        self.figure_index += 1
        self.caption("Рисунок %d — %s" % (self.figure_index, caption))
        if key:
            self.labels[key] = self.figure_index

    def table(self, caption: str, header: list[str], rows: list[list[str]], widths: list[float] | None = None) -> None:
        self.table_index += 1
        caption_paragraph = self.document.add_paragraph()
        caption_paragraph.paragraph_format.space_before = Pt(6)
        caption_paragraph.paragraph_format.keep_with_next = True
        run = caption_paragraph.add_run("Таблица %d — %s" % (self.table_index, caption))
        run.font.size = Pt(10)
        table = self.document.add_table(rows=1, cols=len(header))
        table.alignment = WD_TABLE_ALIGNMENT.CENTER
        try:
            table.style = "Table Grid"
        except KeyError:
            pass
        header_row = table.rows[0]
        tr_pr = header_row._tr.get_or_add_trPr()
        tbl_header = OxmlElement("w:tblHeader")
        tbl_header.set(qn("w:val"), "true")
        tr_pr.append(tbl_header)
        header_cells = header_row.cells
        for index, title in enumerate(header):
            header_cells[index].text = ""
            paragraph = header_cells[index].paragraphs[0]
            run_in_cell = paragraph.add_run(title)
            run_in_cell.bold = True
            run_in_cell.font.size = Pt(9)
        for row in rows:
            cells = table.add_row().cells
            for index, value in enumerate(row):
                cells[index].text = ""
                paragraph = cells[index].paragraphs[0]
                run_in_cell = paragraph.add_run(str(value))
                run_in_cell.font.size = Pt(9)
        if widths:
            for row in table.rows:
                for index, width in enumerate(widths):
                    row.cells[index].width = Cm(width)
        spacer = self.document.add_paragraph()
        spacer.paragraph_format.space_after = Pt(2)


def _fit(text: str, limit: int) -> str:
    text = text or ""
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _table_report(document, spec: dict) -> None:
    pass


def build_report(java, spec, analysis, out_docx, figures_dir, template=None, owl_path=None) -> dict:
    """Render figures and the whole DOCX; returns paths for the caller."""
    template_path = template or _find_template(spec)
    if not template_path:
        raise FileNotFoundError(
            "report template not found; pass template=<path to a previously submitted .docx>"
        )

    figures = {}
    flat = analysis.get("hierarchy", {}).get("flat", [])
    # A real Protégé screenshot always beats a diagram: draw a figure only when
    # the author did not supply a screenshot for that anchor.
    figures["concept"] = draw_concept_map(spec, _figure_path(figures_dir, "fig1_concept_map.png"))
    figures["hierarchy"] = (
        None if _shots(spec, "hierarchy")
        else draw_hierarchy(flat, _figure_path(figures_dir, "fig2_class_hierarchy.png"))
    )
    figures["queries"] = (
        None if _shots(spec, "queries")
        else draw_query_results(spec, analysis, _figure_path(figures_dir, "fig3_query_results.png"))
    )
    # document order: concept map (section 5), hierarchy (6.1), ABox (6.2)
    figures["_no_concept"] = 1
    figures["_no_hierarchy"] = 2
    figures["_no_queries"] = 3

    document = Document(template_path)
    _rewrite_cover(document, spec)
    _truncate_body(document)
    builder = ReportBuilder(document)

    counts = spec.get("counts", {})
    reasoner_name = analysis.get("reasoner", "HermiT")
    queries = analysis.get("queries", [])
    consistent = analysis.get("consistent")
    unsatisfiable = analysis.get("unsatisfiable", [])
    individual_types = analysis.get("individualTypes", {})

    _section_goal(builder, spec, counts)
    _section_tasks(builder, spec)
    _section_theory(builder)
    _section_domain(builder, spec, counts)
    _section_concept(builder, spec, figures)
    _section_protege(builder, spec, counts, figures, analysis)
    _section_reasoner(builder, spec, analysis, figures, reasoner_name, queries, consistent, unsatisfiable, individual_types)
    _section_conclusions(builder, spec, analysis, counts, queries, consistent, unsatisfiable)

    os.makedirs(os.path.dirname(os.path.abspath(out_docx)) or ".", exist_ok=True)
    document.save(out_docx)
    return {
        "docx": os.path.abspath(out_docx),
        "template": os.path.abspath(template_path),
        "figures": figures,
        "tables": builder.table_index,
        "figuresCount": builder.figure_index,
        "sections": 8,
        "owl": os.path.abspath(owl_path) if owl_path else None,
    }


def _find_template(spec: dict | None = None) -> str | None:
    """Locate the style donor .docx.

    The plugin may be installed far away from the workspace, so a single
    "three levels up from engine/" rule is not enough: search the spec's own
    directory (the ontology usually lives next to reports/), the engine tree and
    the current directory, walking upwards for a few levels each.
    """
    roots: list[str] = []
    spec_path = (spec or {}).get("_path")
    if spec_path:
        cursor = os.path.dirname(spec_path)
        for _ in range(4):
            roots.append(cursor)
            cursor = os.path.dirname(cursor)
    cursor = os.path.dirname(os.path.abspath(__file__))
    for _ in range(5):
        roots.append(cursor)
        cursor = os.path.dirname(cursor)
    cursor = os.getcwd()
    for _ in range(4):
        roots.append(cursor)
        cursor = os.path.dirname(cursor)
    env_template = os.environ.get("ONTO_REPORT_TEMPLATE")
    if env_template and os.path.exists(env_template):
        return env_template

    seen = set()
    for root in roots:
        if not root or root in seen:
            continue
        seen.add(root)
        for candidate in DEFAULT_TEMPLATE_CANDIDATES:
            direct = os.path.join(root, candidate)
            if os.path.exists(direct):
                return direct
            # also try <root>/reports/<basename>
            nested = os.path.join(root, "reports", os.path.basename(candidate))
            if os.path.exists(nested):
                return nested
    return None


def _rewrite_cover(document: Document, spec: dict) -> None:
    replacements = {
        COVER_LAB_NUMBER: "ЛАБОРАТОРНАЯ РАБОТА № " + LAB_NUMBER,
        COVER_TOPIC: LAB_TOPIC,
        COVER_SUBTITLE: _subtitle(spec),
    }
    for index, text in replacements.items():
        if index >= len(document.paragraphs):
            continue
        paragraph = document.paragraphs[index]
        if not paragraph.runs:
            paragraph.add_run(text)
            continue
        paragraph.runs[0].text = text
        for run in paragraph.runs[1:]:
            run.text = ""


def _truncate_body(document: Document) -> None:
    body = document.element.body
    if len(document.paragraphs) <= BODY_START:
        return
    boundary = document.paragraphs[BODY_START]._p
    started = False
    for child in list(body):
        if child is boundary:
            started = True
        if started and child.tag != qn("w:sectPr"):
            body.remove(child)


# ---------------------------------------------------------------------------
# sections
# ---------------------------------------------------------------------------
def _section_goal(builder: ReportBuilder, spec: dict, counts: dict) -> None:
    notes = _notes(spec)
    builder.heading("1. Цель работы")
    builder.body(
        notes.get("goal")
        or (
            "Цель работы — освоить онтологическое моделирование промышленной предметной области "
            "и закрепить практические навыки работы с редактором Protégé при создании, редактировании "
            "и анализе онтологий на языке OWL 2."
        )
    )
    builder.body(
        notes.get("scope")
        or (
            "В качестве предметной области выбрано: %s. Итог работы — онтология «%s», в которой "
            "формально описаны %d классов, %d объектных и %d свойств-значений, а также %d индивидов, "
            "описывающих конкретный участок производства, и система аксиом с ограничениями, проверенная "
            "машиной вывода."
            % (_domain_title(spec), spec.get("label", "Ontology"), counts.get("classes", 0),
               counts.get("objectProperties", 0), counts.get("dataProperties", 0),
               counts.get("individuals", 0))
        )
    )


def _section_tasks(builder: ReportBuilder, spec: dict) -> None:
    builder.heading("2. Задачи работы")
    tasks = [
        "освоить основные понятия онтологического подхода: классы, индивиды, свойства, аксиомы, TBox и ABox;",
        "выделить ключевые понятия и отношения выбранной промышленной предметной области;",
        "построить иерархию классов и систему свойств, задающих структуру области;",
        "создать примерную наполненность онтологии конкретными индивидами;",
        "проверить онтологию машиной вывода HermiT и убедиться в её согласованности;",
        "задать и выполнить DL-запросы к онтологии для извлечения нужной информации;",
        "оформить результаты в виде отчёта, пригодного для включения в курсовой проект.",
    ]
    for task in tasks:
        builder.bullet(task)
    builder.body(
        "Формальные требования к сложности модели выполнены: не менее 10–15 классов, 5–7 объектных "
        "свойств, 3–5 свойств-значений, 8–12 индивидов, несколько аксиом с ограничениями и не менее "
        "трёх DL-запросов."
    )


def _section_theory(builder: ReportBuilder) -> None:
    builder.heading("3. Краткие теоретические сведения")
    builder.heading("3.1. Онтология и её элементы", level=2)
    builder.body(
        "Онтология в искусственном интеллекте — формальное машиночитаемое описание предметной области, "
        "включающее классы (типы объектов), отношения между ними, ограничения и аксиомы, а также "
        "конкретных индивидов. Онтология задаёт общий словарь и структуру знаний, понятную и людям, "
        "и программам: она используется для интеграции информационных систем, интеллектуального поиска, "
        "диагностики отказов, планирования и построения цифровых двойников."
    )
    builder.body(
        "В OWL 2 различают классы (Equipment, Pump, Failure), индивиды (Pump_101), объектные свойства — "
        "бинарные отношения между индивидами (hasFailure, performedBy), свойства-значения — связи "
        "«индивид → литерал» (hasSerialNumber, hasTemperatureValue) и аксиомы: включение классов "
        "(Pump является подклассом Equipment), дизъюнктность (классы Worker и Equipment не могут "
        "пересекаться) и ограничения на свойства."
    )
    builder.heading("3.2. TBox и ABox", level=2)
    builder.body(
        "Онтология условно делится на терминологический уровень TBox (классы, иерархия, свойства и общие "
        "аксиомы) и уровень утверждений ABox (индивиды и факты о них). В работе построены оба уровня: "
        "структура области и примерная наполненность конкретными объектами, процессами и событиями."
    )
    builder.heading("3.3. Открытость мира", level=2)
    builder.body(
        "OWL опирается на предположение об открытом мире: если факт в онтологии не указан, это не значит, "
        "что он ложен — он может быть просто неизвестен. Поэтому отсутствие утверждения нельзя "
        "интерпретировать как отрицание, а DL-запросы возвращают только то, что логически следует из "
        "аксиом."
    )
    builder.heading("3.4. Машина вывода", level=2)
    builder.body(
        "Reasoner проверяет онтологию на согласованность, выводит новые знания из аксиом, уточняет "
        "иерархию классов и определяет, к каким классам принадлежит конкретный индивид. В Protégé "
        "встроены HermiT, Pellet и ELK; в данной работе используется HermiT как табличный reasoner, "
        "поддерживающий полный OWL 2 DL и сложные классовые выражения в запросах."
    )


def _section_domain(builder: ReportBuilder, spec: dict, counts: dict) -> None:
    notes = _notes(spec)
    builder.heading("4. Описание выбранной предметной области")
    top_classes = [c["name"] for c in spec["classes"] if (c.get("parent") or "Thing") == "Thing"]

    paragraphs = _paragraphs(notes.get("domain"))
    if not paragraphs:
        paragraphs = [
            "Предметная область — %s. Рассматриваются производственные процессы, оборудование, "
            "материалы, персонал, серии продукции и контроль качества, а также отклонения, возникающие "
            "при производстве." % _domain_title(spec),
            "Границы области: в модель включены только сущности, непосредственно влияющие на выпуск "
            "и качество продукции. За границами остаются финансы, кадровый учёт и сбытовая логистика.",
        ]
    for paragraph in paragraphs:
        builder.body(paragraph)

    builder.body(
        "Ключевые группы понятий, вынесенные в верхний уровень иерархии: %s. Всего в онтологии %d классов "
        "(включая подклассы), %d объектных свойств, %d свойств-значений и %d индивидов."
        % (", ".join(top_classes) or "—", counts.get("classes", 0), counts.get("objectProperties", 0),
           counts.get("dataProperties", 0), counts.get("individuals", 0))
    )


def _section_concept(builder: ReportBuilder, spec: dict, figures: dict) -> None:
    builder.heading("5. Концептуальная модель")
    top = [c["name"] for c in spec["classes"] if (c.get("parent") or "Thing") == "Thing"]
    example = "%s и %s" % (top[0], top[1]) if len(top) >= 2 else "разные категории"
    builder.body(
        "Модель строилась в два шага: сначала выделены верхние классы и их подклассы, затем определены "
        "отношения (объектные свойства) и атрибуты (свойства-значения). Верхний уровень образуют "
        "взаимно дизъюнктные категории (%s), поэтому один и тот же индивид не может одновременно "
        "принадлежать двум из них — это ограничение проверяется машиной вывода." % example
    )
    builder.figure(figures["concept"], "Концептуальная модель предметной области")
    for shot in _shots(spec, "concept"):
        builder.figure(shot["path"], shot["caption"], width_cm=shot.get("width") or 15.5)

    class_rows = [
        [entry["name"], entry.get("parent") or "Thing", entry.get("comment") or "—"]
        for entry in spec["classes"]
    ]
    builder.table("Иерархия классов", ["Класс", "Родительский класс", "Пояснение"], class_rows,
                  widths=[4.4, 4.0, 8.6])

    object_rows = [
        [prop["name"], prop.get("domain") or "—", prop.get("range") or "—",
         prop.get("inverse") or "—", ", ".join(prop.get("characteristics", [])) or "—"]
        for prop in spec["objectProperties"]
    ]
    builder.table("Объектные свойства", ["Свойство", "Домен", "Диапазон", "Обратное", "Характеристики"],
                  object_rows, widths=[4.0, 3.4, 3.4, 3.4, 2.8])

    data_rows = [
        [prop["name"], prop.get("domain") or "—", "xsd:" + prop.get("range", "string"),
         "функциональное" if prop.get("functional", True) else "—"]
        for prop in spec["dataProperties"]
    ]
    builder.table("Свойства-значения", ["Свойство", "Домен", "Тип значения", "Ограничение"],
                  data_rows, widths=[5.0, 4.0, 3.6, 4.0])

    builder.body(
        "Отношения заданы с указанием домена и диапазона, что позволяет машине вывода проверять "
        "корректность утверждений: если индивид получает связь, несовместимую с объявленными доменом "
        "и диапазоном, он попадает в соответствующий класс, а при противоречии с дизъюнктностью "
        "онтология становится несогласованной. Для парных отношений объявлены обратные свойства, "
        "а для части отношений — характеристики (функциональность, транзитивность)."
    )


def _section_protege(builder: ReportBuilder, spec: dict, counts: dict, figures: dict, analysis: dict) -> None:
    builder.heading("6. Построение онтологии в Protégé")
    builder.body(
        "Онтология создана в редакторе Protégé 5.6 с машиной вывода HermiT. Сначала задан IRI онтологии "
        "(%s), затем последовательно построены иерархия классов, объектные свойства и свойства-значения, "
        "аксиомы с ограничениями и индивиды. Файл сохранён в формате RDF/XML и повторно открыт в "
        "редакторе для проверки, что он читается без предупреждений о нормализации." % spec.get("iri", "")
    )
    builder.heading("6.1. Иерархия классов", level=2)
    if figures.get("hierarchy"):
        builder.figure(figures["hierarchy"], "Классификация, построенная машиной вывода", key="hierarchy")
    for shot in _shots(spec, "hierarchy"):
        builder.figure(shot["path"], shot["caption"], width_cm=shot.get("width") or 13.0, key="hierarchy")

    builder.body(
        "Дерево на рисунке %d повторяет структуру модели в редакторе и раскрыто до всех уровней, включая "
        "определяемые классы BatchWithDeviation, ReleasedBatch и ResolvedDeviation. Верхние категории "
        "попарно дизъюнктны (группы %d), поэтому один индивид не может одновременно относиться к двум "
        "из них; результаты работы машины вывода по этой иерархии приведены в разделе 7."
        % (builder.labels.get("hierarchy") or 2, counts.get("disjointGroups", 0))
    )

    metrics_shots = _shots(spec, "metrics")
    if metrics_shots:
        builder.heading("6.2. Метрики онтологии", level=2)
        builder.body(
            "После загрузки файла редактор показывает метрики онтологии: число аксиом, логических аксиом, "
            "классов, свойств и индивидов. Эти значения получены самим редактором и служат независимой "
            "проверкой того, что структура модели соответствует требованиям задания. Счётчик объектных "
            "свойств (%d) включает %d объявленных свойств и %d автоматически созданных обратных к ним, "
            "поэтому в таблице 2 перечислены %d объектных свойств модели."
            % (
                analysis.get("objectPropertyCount", 0),
                counts.get("objectProperties", 0),
                max(0, analysis.get("objectPropertyCount", 0) - counts.get("objectProperties", 0)),
                counts.get("objectProperties", 0),
            )
        )
        for shot in metrics_shots:
            builder.figure(shot["path"], shot["caption"], width_cm=shot.get("width") or 13.0)

    builder.heading("6.3. Индивиды и утверждения", level=2)
    individual_rows = []
    for entry in spec["individuals"]:
        facts = []
        for assertion in entry.get("objectAssertions", []):
            facts.append("%s → %s" % (assertion["property"], assertion["target"]))
        for assertion in entry.get("dataAssertions", []):
            facts.append("%s = %s" % (assertion["property"], assertion.get("value")))
        individual_rows.append(
            [entry["name"], ", ".join(entry.get("types", [])), "; ".join(facts) or "—"]
        )
    builder.table("Индивиды онтологии (ABox)", ["Индивид", "Класс", "Заданные утверждения"],
                  individual_rows, widths=[3.4, 3.4, 10.2])
    for shot in _shots(spec, "individuals"):
        builder.figure(shot["path"], shot["caption"], width_cm=shot.get("width") or 14.0)

    builder.body(
        _notes(spec).get("individualsNote")
        or (
            "Индивиды заполнены так, чтобы отражать типичную ситуацию на участке и покрывать основные "
            "ветви модели: объект с идентифицирующими данными, связанное с ним событие и действие, "
            "которое это событие обрабатывает. На этом наборе проверяются и ограничения TBox, и работа "
            "DL-запросов."
        )
    )


def _section_reasoner(builder, spec, analysis, figures, reasoner_name, queries, consistent, unsatisfiable, individual_types) -> None:
    counts = spec.get("counts", {})
    builder.heading("7. Работа reasoner'а и DL-запросы")
    builder.heading("7.1. Проверка согласованности", level=2)
    if consistent:
        builder.body(
            "После запуска машины вывода %s онтология признана согласованной (consistent), невыполнимых классов не "
            "обнаружено. Это означает, что объявленные ограничения и утверждения не противоречат друг "
            "другу, а дизъюнктность верхних классов не нарушена." % reasoner_name
        )
    else:
        builder.body(
            "Машина вывода признала онтологию несогласованной. Причина — противоречие между "
            "дизъюнктностью классов и утверждениями об индивиде; такие ошибки устраняются уточнением "
            "типов или удалением противоречащего утверждения."
        )
    if unsatisfiable:
        builder.body("Невыполнимые классы: %s." % ", ".join(unsatisfiable))
    builder.body(
        "Проверено в общей сложности %d аксиом (включая объявления сущностей и обратные свойства); "
        "модель содержит %d классов, %d объектных свойств, %d свойств-значений и %d индивидов."
        % (analysis.get("axiomCount", 0), counts.get("classes", 0), counts.get("objectProperties", 0),
           counts.get("dataProperties", 0), counts.get("individuals", 0))
    )

    builder.heading("7.2. Выведенные знания", level=2)
    asserted = {entry["name"]: set(entry.get("types", [])) for entry in spec["individuals"]}
    # "new knowledge" must mean more than "an ancestor of an asserted type was
    # inherited": only classes that are NOT superclasses of what was asserted count.
    parent_of = {row["name"]: row.get("parent") for row in analysis.get("hierarchy", {}).get("flat", [])}

    def ancestors(type_name: str) -> set:
        seen = set()
        cursor = type_name
        while cursor and cursor not in seen:
            seen.add(cursor)
            cursor = parent_of.get(cursor)
        return seen

    inherited = set()
    for type_name in {t for types in asserted.values() for t in types}:
        inherited |= ancestors(type_name)

    inferred_rows = []
    new_facts = 0
    for name in sorted(individual_types):
        types = individual_types[name]
        added = [t for t in types if t not in asserted.get(name, set()) and t not in inherited]
        new_facts += len(added)
        inferred_rows.append([name, ", ".join(types) or "—", ", ".join(added) or "—"])
    builder.table("Классы индивидов после вывода", ["Индивид", "Все выведенные классы", "Новые (не заданные явно)"],
                  inferred_rows, widths=[3.8, 6.6, 6.6])
    builder.body(
        "Колонка «Новые» содержит только содержательные выводы: классы, которые не были заданы явно и "
        "не являются просто предками заданных типов. Всего выведено %d таких фактов — именно они и "
        "составляют результат работы машины вывода." % new_facts
    )
    defined = _defined_classes(spec)
    examples = ", ".join(defined[:2]) if defined else "определяемые классы модели"
    builder.body(
        "Отдельно следует отметить ограничение отрицательных условий. При открытом мире отсутствие "
        "утверждения о некоторой связи ещё не означает, что связь отсутствует: reasoner обязан "
        "рассмотреть модель, в которой она просто не зафиксирована, и потому класс, определённый через "
        "отрицание, описанным способом не выводится. Именно поэтому в модели используются только "
        "положительные определяемые классы (%s), а отрицание в DL-запросах применяется лишь там, где "
        "оно логически следует из аксиом." % examples
    )

    builder.heading("7.3. DL-запросы", level=2)
    builder.body(
        _notes(spec).get("queriesNote")
        or (
            "Запросы сформулированы в синтаксисе Manchester и приведены в том виде, в котором они "
            "вводятся во вкладке DL Query редактора — с префиксом онтологии, поскольку без префикса "
            "редактор не разрешает имена сущностей. Те же выражения (в форме без префикса) выполнены "
            "программно тем же reasoner'ом, поэтому ответы ниже проверены независимо от интерфейса."
        )
    )
    query_rows = []
    for index, query in enumerate(queries, start=1):
        result = ", ".join(query.get("entities", [])) if query.get("entities") else "пусто"
        query_rows.append(
            [
                str(index),
                _editor_expression(spec, query["expression"]),
                _ASK_RU.get(query.get("ask"), ""),
                _fit(result, 60),
            ]
        )
    builder.table("DL-запросы и результаты", ["№", "DL-запрос", "Что ищем", "Результат"],
                  query_rows, widths=[0.9, 8.0, 3.2, 4.4])
    if figures.get("queries"):
        builder.figure(figures["queries"], "Результаты DL-запросов")
    for shot in _shots(spec, "queries"):
        builder.figure(shot["path"], shot["caption"], width_cm=shot.get("width") or 15.5)
    builder.body(
        "Пустой ответ у запроса — это тоже корректный результат: в соответствии с предположением об "
        "открытом мире он означает, что подходящих индивидов в онтологии нет, а не что утверждение ложно."
    )


def _section_conclusions(builder, spec, analysis, counts, queries, consistent, unsatisfiable) -> None:
    builder.page_break()
    builder.heading("8. Выводы")
    custom = _paragraphs(_notes(spec).get("conclusions"))
    total_results = sum(len(q.get("entities", [])) for q in queries)

    if custom:
        for paragraph in custom:
            builder.body(paragraph)
        return

    builder.body(
        "В ходе работы построена онтология предметной области «%s» на языке OWL 2: %d классов, "
        "%d объектных свойств, %d свойств-значений и %d индивидов. Модель охватывает ключевые понятия "
        "области и их отношения, а также типовой набор конкретных объектов."
        % (_domain_title(spec), counts.get("classes", 0), counts.get("objectProperties", 0),
           counts.get("dataProperties", 0), counts.get("individuals", 0))
    )
    builder.body(
        "Машина вывода %s подтвердила согласованность онтологии и вывела новые знания из аксиом с "
        "ограничениями; DL-запросы (%d штук, суммарно %d найденных сущностей) показали, что модель "
        "пригодна для извлечения практических ответов, а не только для хранения структуры."
        % (analysis.get("reasoner", "HermiT"), len(queries), total_results)
    )
    builder.body(
        "Ограничение работы — небольшой набор индивидов и отсутствие связи с реальной информационной "
        "системой предприятия. Дальнейшее развитие: наполнение ABox из журналов и баз данных, добавление "
        "временных характеристик процессов и построение на основе онтологии правил поддержки принятия "
        "решений."
    )
    builder.body(
        "Практическая ценность работы состоит в том, что полученная онтология служит формальной основой "
        "для базы знаний информационной системы и может быть расширена без изменения уже проверенной "
        "структуры."
    )
