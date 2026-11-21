# Architecture

## Shape of the system

```
DSH host
  └─ plugin row "protege-ontology-bridge"  (cordis patch insert)
       └─ lib/index.js                     zero-dependency ESM, registers 7 tools
            └─ spawn: python -X utf8 engine/cli.py <subcommand> --flags…
                 └─ engine/                Python 3, one JSON object per run
                      spec.py              spec load / validate / counts
                      onto.py              spec → OWL axioms (via JPype → OWL API)
                      manchester.py        Manchester expression → OWLClassExpression
                      reasoner.py          HermiT: consistency, hierarchy, types, queries
                      report.py            matplotlib figures + python-docx report
                      jvm.py               JVM bootstrap, nested-jar cache, quiet logging
```

`lib/index.js` never touches an ontology itself: it resolves a Python interpreter, spawns `cli.py`, and
returns the parsed JSON. That keeps the plugin portable across DSH versions and lets the whole engine be
used from a plain terminal.

## Why JPype and not a compiled Java helper

Protégé ships a **JRE, not a JDK** — there is no `javac`, so nothing can be compiled on the target machine.
JPype can start an embedded JVM in-process and call the OWL API and HermiT classes reflectively, which is
enough for the whole pipeline.

Consequences worth remembering:

- the JVM can be started **once per process**, so each CLI subcommand is a separate process (~4–6 s cold
  start, mostly JVM + OWL API class loading);
- exceptions arrive as `jpype` `JavaException`-style errors, so the CLI wraps everything and always prints
  JSON (never a bare traceback) — the plugin surfaces `error` + a short traceback tail;
- logback is configured through a quiet XML file, otherwise Protégé's JUL/logback chatter floods stderr.

## The nested-jar problem

Protégé publishes OWL API as an OSGi bundle whose dependencies live *inside* the jar:

```
bundles/owlapi-osgidistribution.jar
  META-INF/MANIFEST.MF      Bundle-ClassPath: .,lib/jackson-core-2.16.1.jar,…
  lib/caffeine-2.9.3.jar    ← runtime classpath cannot see these
  lib/rdf4j-*.jar
  …                        (33 embedded jars)
plugins/org.semanticweb.hermit-1.4.3.456.jar
  automaton-1.11-8.jar      ← HermiT's automaton dependency, at the jar root
```

`jvm.py` therefore walks `bundles/*.jar` and `plugins/*.jar`, extracts every entry ending in `.jar`
(whether under `lib/` or at the root), and adds the extracted files to the classpath. Extraction is cached
under `%LOCALAPPDATA%\onto-engine\cache\main\<jar-name>\` and re-run only when the entry size changes.

That cache lives on an **ASCII path on purpose** (see next section).

## Non-ASCII paths

`java.net.URI` rejects non-ASCII characters, so `"file:///" + path` throws
`URISyntaxException: Illegal character in path` for a workspace like `D:\桌面\технология…`. Every file IRI
is therefore built as `IRI.create(java.io.File(path).toURI().toString())`, which percent-encodes correctly.

The cache directory is placed in `%LOCALAPPDATA%` for the same family of reasons: a Cyrillic `-D` property
value (logback config path) can arrive mangled, and a mangled config silently degrades to default logging.

## Literal typing

`_literal_for()` in `onto.py` builds a literal from the **data property's declared range**, not from the
value's Python type:

| range | lexical form | OWL literal |
| --- | --- | --- |
| `xsd:string` | `str(value)` | plain literal |
| `xsd:integer` / `xsd:int` | `str(int(float(value)))` | typed by range |
| `xsd:float` / `xsd:double` / `xsd:decimal` | `repr(float(value))` | typed by range |
| `xsd:boolean` | `"true"` / `"false"` | typed by range |
| `xsd:date` / `xsd:dateTime` / `xsd:anyURI` | `str(value)` | typed by range |

This is not cosmetic. `xsd:double` and `xsd:float` have different value spaces: an `xsd:double` literal on a
property whose range is `xsd:float` violates the range, and with `Functional` HermiT reports the ontology
**inconsistent**. The first iteration of the engine hit exactly this with `96.5`.

## Reasoning layer

`reasoner.py` wraps four HermiT operations:

| need | OWL API call |
| --- | --- |
| consistency | `reasoner.isConsistent()` |
| unsatisfiable classes | `reasoner.getUnsatisfiableClasses().getEntitiesMinusBottom()` |
| inferred hierarchy | `getSubClasses(expr, direct=true)` walked from `owl:Thing` |
| individual types | `getTypes(individual, direct=false)` |
| DL query answer | `getInstances` / `getSubClasses` / `getSuperClasses` / `getEquivalentClasses` on a parsed class expression |

`precomputeInferences()` is called inside a `try`: on an inconsistent ontology it throws, and the useful
answer (`isConsistent() == false`) must still be reported instead of a crash.

## Manchester expressions

`manchester.py` is a small recursive-descent parser:

```
or      := and ( 'or' and )*
and     := unary ( 'and' unary )*
unary   := 'not' unary | primary
primary := '(' or ')' | objectProp ('some'|'only') unary | objectProp 'value' individual
           | dataProp 'value' literal | className
```

Names are resolved against the ontology's declared vocabulary, so a typo raises
`unknown name 'X'` instead of silently inventing a fresh class — a fresh class would make a DL query return
an empty set and look "correct".

## Report layer

`report.py` clones a previously submitted `.docx` as the style donor; every domain-specific
sentence (cover subtitle, domain paragraphs, individuals/query notes, conclusions) comes from
`spec["report"]` when present and falls back to spec-derived text otherwise (cover page, headings, table grid,
body font), rewrites three cover paragraphs, drops the old body, then appends eight sections. Three figures
are drawn with matplotlib at **print size** (`figsize` in inches ≈ the width Word will use), because a
figure rendered at 22 inches and scaled down to 15.5 cm turns 9 pt labels into ~2 pt.

Layouts are deterministic rather than spring-based:

- **hierarchy** — indented tree straight from `reasoning.hierarchy.flat`;
- **concept map** — top-level classes on an ellipse, object-property edges with labels; self-loops
  (`hasPart: Equipment → Equipment`) get their own arc;
- **query results** — horizontal bars with entity names, replacing an ABox graph that was unreadable at
  A4 width with twelve 17-character individual names.

## Sandbox and paths

The plugin spawns Python with `cwd = engine/` and no environment overrides (except `-X utf8`, which keeps
stdout UTF-8 regardless of the console code page). All absolute paths come from the tool arguments, so the
engine obeys whatever the session's file policy allows; it does not resolve DSH sandbox policy itself.
