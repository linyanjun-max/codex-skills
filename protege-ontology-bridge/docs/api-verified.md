# Verified API facts

Everything below was exercised on this machine, not copied from documentation. Target: **Protégé 5.6.9**,
bundled **Temurin JRE 11.0.25**, **OWL API 4.5.29**, **HermiT 1.4.3.456**, **jpype 1.7.1**, Windows 11.

## JPype

### `startJVM` signature (1.7.1)

```python
jpype.startJVM(jvmpath, *jvm_args, classpath=[...], convertStrings=False)
```

`jvmargs=` is **not** a keyword argument (it raises `TypeError: startJVM() got an unexpected keyword argument
'jvmargs'`). JVM options are positional arguments after the path:

```python
startJVM(
    r"E:\Protege-5.6.9-win\Protege-5.6.9\jre\bin\server\jvm.dll",
    "-Dlogback.configurationFile=" + quiet_xml,
    "-Dfile.encoding=UTF-8",
    classpath=classpath,
    convertStrings=False,
)
```

`convertStrings=False` keeps Java strings as `java.lang.String` objects; `str(obj)` converts when needed.

### One JVM per process

The second `startJVM` in the same process fails. The engine therefore runs one subcommand per process.

### Overload ambiguity

Calling an OWL API method whose overloads both accept reference types raises
`TypeError: Ambiguous overloads found`. Workaround: build an explicitly typed Java array.

```python
OWLClassExpression = JClass("org.semanticweb.owlapi.model.OWLClassExpression")
arr = JArray(OWLClassExpression)([cls_a, expr_b])
df.getOWLEquivalentClassesAxiom(arr)      # not (cls, expr) — that pair is ambiguous
```

## OWL API 4.5.29 (from `bundles/owlapi-osgidistribution.jar`)

### Entry points that work

```python
OWLManager = JClass("org.semanticweb.owlapi.apibinding.OWLManager")
IRI        = JClass("org.semanticweb.owlapi.model.IRI")
df         = OWLManager.getOWLDataFactory()
manager    = OWLManager.createOWLOntologyManager()
ontology   = manager.createOntology(IRI.create(ns.rstrip("#")))
```

### Saving / loading

```python
RDFXML = JClass("org.semanticweb.owlapi.formats.RDFXMLDocumentFormat")()
Turtle = JClass("org.semanticweb.owlapi.formats.TurtleDocumentFormat")()
manager.saveOntology(ontology, RDFXML, IRI.create(java.io.File(path).toURI().toString()))
manager.loadOntologyFromOntologyDocument(IRI.create(java.io.File(path).toURI().toString()))
```

`"file:///" + path` fails for non-ASCII paths (`URISyntaxException: Illegal character in path`).

### Complex class expressions and instances

```python
expr = df.getOWLObjectIntersectionOf([cls_equipment, df.getOWLObjectSomeValuesFrom(has_failure, cls_failure)])
reasoner.getInstances(expr, False).getFlattened()   # works; HermiT answers complex expressions
```

`getInstances(expr, direct)` is the actual DL-query operation; OWL API 4.5 has **no**
`org.semanticweb.owlapi.util.DLQueryEngine` (that class does not exist in 4.5 — `JClass` raises
`TypeError: Class … is not found`). Build the expression yourself and call the reasoner.

### Annotations

```python
literal = df.getOWLLiteral("текст", "ru")            # 2 × String → language-tagged literal
ann     = df.getOWLAnnotation(df.getRDFSComment(), literal)
axiom   = df.getOWLAnnotationAssertionAxiom(entity.getIRI(), ann)
```

## HermiT 1.4.3 (from `plugins/org.semanticweb.hermit-1.4.3.456.jar`)

```python
FactoryClass = JClass("org.semanticweb.HermiT.Reasoner$ReasonerFactory")   # inner class, $ syntax
reasoner = FactoryClass().createReasoner(ontology)
reasoner.isConsistent()
reasoner.getUnsatisfiableClasses().getEntitiesMinusBottom()
reasoner.getSubClasses(expr, True).getFlattened()
reasoner.getTypes(individual, False).getFlattened()
reasoner.dispose()
```

`org.semanticweb.HermiT.ProtegeReasonerFactory` also exists but is the Protégé-flavoured wrapper; the plain
`Reasoner$ReasonerFactory` needs no Protégé classes.

`precomputeInferences()` throws `InconsistentOntologyException` on an inconsistent ontology — wrap it, then
still read `isConsistent()`.

### The CLI entry point is unusable outside OSGi

`org.semanticweb.HermiT.cli.CommandLine` exists, but the plugin jar's `Bundle-ClassPath` provides
`gnu.getopt` only inside OSGi. Running it from a plain classpath fails:

```
java.lang.NoClassDefFoundError: gnu/getopt/Getopt
    at org.semanticweb.HermiT.cli.CommandLine.main(CommandLine.java:78)
```

Use JPype against the classes instead of the CLI.

## Classpath composition

`bundles/owlapi-osgidistribution.jar` embeds 33 dependencies under `lib/` and lists them in
`Bundle-ClassPath`; `plugins/org.semanticweb.hermit-*.jar` embeds `automaton-1.11-8.jar`,
`commons-logging`, and axiom jars at the **root**. A plain JVM classpath sees neither set, so both must be
extracted (see `engine/jvm.py`).

Without `automaton`, HermiT fails at startup with:

```
java.lang.NoClassDefFoundError: dk/brics/automaton/BasicAutomata
```

## Protégé installation facts

- `Protege.exe` is an exe4j launcher; `run.bat` shows the real invocation and uses `jre\bin\java`.
- The distribution contains **JRE only** — `javac`, `jar`, `jshell` are all absent.
- `jre\bin\server\jvm.dll` is what JPype needs as `jvmpath`.
- Plugin update checks contact `raw.githubusercontent.com` at startup, which is slow on restricted networks
  (~50 s) but harmless.
- Protégé's default new-ontology IRI derives from the OS user name, so an account like `lin'yan'jun` yields
  an IRI with a stray apostrophe — always set the IRI explicitly.

## Coordinates worth remembering

| item | value |
| --- | --- |
| OWL API version | 4.5.29 |
| HermiT version | 1.4.3.456 |
| HermiT factory class | `org.semanticweb.HermiT.Reasoner$ReasonerFactory` |
| JVM | Temurin 11.0.25 (bundled) |
| verified jpype | 1.7.1 (cp312 wheel) |
