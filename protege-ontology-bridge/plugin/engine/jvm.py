# -*- coding: utf-8 -*-
"""JVM bootstrap for the Protégé-bundled OWL API + HermiT.

There is no javac on typical Windows installs of Protégé (it ships a JRE, not a
JDK), so we do not compile anything: JPype starts Protégé's own JVM and we call
the OWL API and HermiT classes directly.

Two non-obvious facts make this work:

1. Protégé ships OWL API as an OSGi bundle whose dependencies (caffeine, rdf4j,
   jackson, ...) live in embedded ``lib/*.jar`` entries. A plain JVM classpath
   cannot see inside those, so every embedded jar is extracted to a cache
   directory first.
2. Java's ``URI`` parser rejects non-ASCII characters, so every ontology path is
   converted with ``java.io.File.toURI()`` instead of string concatenation.
   The cache itself lives under ``%LOCALAPPDATA%`` (an ASCII path) so neither the
   classpath nor logback's config file can be mangled by Cyrillic user paths.
"""

from __future__ import annotations

import json
import os
import zipfile

CACHE_ROOT = os.path.join(
    os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"),
    "onto-engine",
    "cache",
)
MAIN_DIR = os.path.join(CACHE_ROOT, "main")

# Protégé's launcher writes DEBUG chatter through logback; a quiet config keeps
# CLI stdout/stderr readable.
QUIET_LOGBACK = """<configuration>
  <appender name="STDERR" class="ch.qos.logback.core.ConsoleAppender">
    <target>System.err</target>
    <encoder><pattern>%-5level %logger{0} - %msg%n</pattern></encoder>
  </appender>
  <root level="ERROR"><appender-ref ref="STDERR"/></root>
</configuration>
"""

# Jars that only matter for the GUI or for a second logging backend.
SKIP_JARS = {"logback-classic.jar", "logback-core.jar"}


class JvmError(RuntimeError):
    pass


def _candidate_roots():
    env = os.environ.get("PROTEGE_HOME") or os.environ.get("PROTEGE_ROOT")
    if env:
        yield env
    local = os.environ.get("LOCALAPPDATA") or ""
    appdata = os.environ.get("APPDATA") or ""
    program_files = os.environ.get("ProgramFiles") or "C:\\Program Files"
    program_files_x86 = os.environ.get("ProgramFiles(x86)") or "C:\\Program Files (x86)"
    for drive in ("C:", "D:", "E:", "F:"):
        yield os.path.join(drive, "\\", "Protege")
        yield os.path.join(drive, "\\", "Protege-5.6.9-win")
        yield os.path.join(drive, "\\", "Program Files", "Protege")
    yield os.path.join(program_files, "Protege")
    yield os.path.join(program_files_x86, "Protege")
    yield os.path.join(local, "Protege")
    yield os.path.join(local, "Programs", "Protege")
    yield os.path.join(appdata, "Protege")


def _is_protege_home(path: str) -> bool:
    return (
        os.path.isdir(os.path.join(path, "bundles"))
        and os.path.isdir(os.path.join(path, "plugins"))
        and os.path.exists(os.path.join(path, "jre", "bin", "server", "jvm.dll"))
    )


def find_protege(root_hint: str | None = None) -> str | None:
    """Locate a Protégé installation directory (the one containing bundles/)."""
    seen = set()
    candidates = []
    if root_hint:
        candidates.append(root_hint)
    candidates.extend(_candidate_roots())
    for candidate in candidates:
        if not candidate:
            continue
        for base in (candidate, os.path.join(candidate, "Protege-5.6.9")):
            base = os.path.normpath(base)
            if base in seen:
                continue
            seen.add(base)
            if _is_protege_home(base):
                return base
    # One level deeper: <drive>:\Protege-5.6.9-win\Protege-5.6.9
    for candidate in list(seen):
        if not os.path.isdir(candidate):
            continue
        try:
            entries = sorted(os.listdir(candidate))
        except OSError:
            continue
        for entry in entries:
            deep = os.path.join(candidate, entry)
            if os.path.isdir(deep) and deep not in seen and _is_protege_home(deep):
                return deep
    return None


def protege_info(home: str) -> dict:
    info = {
        "home": home,
        "jvmDll": os.path.join(home, "jre", "bin", "server", "jvm.dll"),
        "hermitJar": None,
        "owlapiJar": os.path.join(home, "bundles", "owlapi-osgidistribution.jar"),
        "hermitVersion": None,
    }
    plugins = os.path.join(home, "plugins")
    if os.path.isdir(plugins):
        for name in sorted(os.listdir(plugins)):
            if name.startswith("org.semanticweb.hermit-") and name.endswith(".jar"):
                info["hermitJar"] = os.path.join(plugins, name)
                info["hermitVersion"] = name[len("org.semanticweb.hermit-"): -len(".jar")]
                break
    if not info["hermitJar"]:
        for name in sorted(os.listdir(plugins)) if os.path.isdir(plugins) else []:
            if "hermit" in name.lower() and name.endswith(".jar"):
                info["hermitJar"] = os.path.join(plugins, name)
                break
    return info


def ensure_cache() -> str:
    os.makedirs(MAIN_DIR, exist_ok=True)
    return CACHE_ROOT


def _extract_embedded(jar_path: str) -> list[str]:
    """Extract nested ``*.jar`` entries; return paths to the extracted jars."""
    added = []
    tag = os.path.splitext(os.path.basename(jar_path))[0]
    dest_dir = os.path.join(MAIN_DIR, tag)
    try:
        with zipfile.ZipFile(jar_path) as archive:
            # Bundle-ClassPath entries may sit at the root (automaton-1.11-8.jar)
            # or under lib/ (OWL API dependencies); both are invisible to a plain
            # classpath, so collect either form.
            nested = [
                n
                for n in archive.namelist()
                if n.lower().endswith(".jar") and not n.endswith("/")
            ]
            if not nested:
                return added
            for entry in nested:
                dest = os.path.join(dest_dir, entry.replace("/", "__"))
                try:
                    fresh = os.path.getsize(dest) != archive.getinfo(entry).file_size
                except OSError:
                    fresh = True
                if fresh:
                    os.makedirs(dest_dir, exist_ok=True)
                    with archive.open(entry) as src, open(dest, "wb") as dst:
                        dst.write(src.read())
                added.append(dest)
    except zipfile.BadZipFile:
        pass
    return added


def build_classpath(home: str) -> list[str]:
    """All Protégé jars plus every embedded jar, so OWL API resolves offline."""
    ensure_cache()
    classpath = []
    for folder in (os.path.join(home, "bundles"), os.path.join(home, "plugins")):
        if not os.path.isdir(folder):
            continue
        for name in sorted(os.listdir(folder)):
            if not name.lower().endswith(".jar") or name in SKIP_JARS:
                continue
            path = os.path.join(folder, name)
            classpath.append(path)
            classpath.extend(_extract_embedded(path))
    return classpath


def quiet_logback_path() -> str:
    ensure_cache()
    path = os.path.join(CACHE_ROOT, "logback-quiet.xml")
    if not os.path.exists(path):
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(QUIET_LOGBACK)
    return path


class Java:
    """Lazily started JVM facade exposing the OWL API / HermiT classes we use."""

    _started = False
    _classes: dict[str, object] = {}

    def __init__(self, home: str | None = None, verbose: bool = False):
        self.verbose = verbose
        self.home = home or find_protege()
        if not self.home:
            raise JvmError(
                "Protégé installation not found. Set PROTEGE_HOME or pass root=<path to the "
                "folder that contains bundles/, plugins/, jre/>."
            )
        self.info = protege_info(self.home)
        if not self.info["jvmDll"] or not os.path.exists(self.info["jvmDll"]):
            raise JvmError("Protégé JVM not found: " + str(self.info["jvmDll"]))
        if not os.path.exists(self.info["owlapiJar"]):
            raise JvmError("OWL API bundle not found: " + self.info["owlapiJar"])
        self._start()

    # -- lifecycle ---------------------------------------------------------
    def _start(self) -> None:
        if Java._started:
            return
        try:
            import jpype  # noqa: WPS433  (optional dependency, checked at runtime)
        except ImportError as exc:  # pragma: no cover - environment guard
            raise JvmError(
                "jpype1 is required to drive HermiT: python -m pip install jpype1"
            ) from exc

        classpath = build_classpath(self.home)
        logback = quiet_logback_path()
        jpype.startJVM(
            self.info["jvmDll"],
            "-Dlogback.configurationFile=" + logback,
            "-Dfile.encoding=UTF-8",
            classpath=classpath,
            convertStrings=False,
        )
        Java._started = True

    def cls(self, name: str):
        from jpype import JClass

        if name not in Java._classes:
            Java._classes[name] = JClass(name)
        return Java._classes[name]

    def array(self, type_name: str, values):
        from jpype import JArray

        return JArray(self.cls(type_name))(values)

    # -- OWL API entry points ---------------------------------------------
    @property
    def OWLManager(self):
        return self.cls("org.semanticweb.owlapi.apibinding.OWLManager")

    @property
    def IRI(self):
        return self.cls("org.semanticweb.owlapi.model.IRI")

    @property
    def df(self):
        return self.OWLManager.getOWLDataFactory()

    def manager(self):
        return self.OWLManager.createOWLOntologyManager()

    def iri(self, text: str):
        return self.IRI.create(text)

    def file_iri(self, path: str):
        """IRI for a local path; java.io.File.toURI percent-encodes non-ASCII."""
        return self.IRI.create(self.cls("java.io.File")(path).toURI().toString())

    def reasoner_factory(self):
        return self.cls("org.semanticweb.HermiT.Reasoner$ReasonerFactory")()

    def rdfxml_format(self):
        return self.cls("org.semanticweb.owlapi.formats.RDFXMLDocumentFormat")()

    def turtle_format(self):
        return self.cls("org.semanticweb.owlapi.formats.TurtleDocumentFormat")()

    def xsd(self, datatype: str):
        return self.cls("org.semanticweb.owlapi.model.OWL2Datatype").valueOf(datatype)


_CACHE: dict[str, Java] = {}


def java(home: str | None = None, verbose: bool = False) -> Java:
    """Process-wide singleton: a JVM can only start once per process."""
    key = home or "auto"
    if key not in _CACHE:
        _CACHE[key] = Java(home, verbose=verbose)
    return _CACHE[key]


def describe(home: str | None = None) -> dict:
    """Installation report usable without starting the JVM."""
    found = find_protege(home)
    try:
        import jpype  # noqa: F401

        jpype_version = getattr(__import__("jpype"), "__version__", "?")
    except ImportError:
        jpype_version = None
    report = {
        "protegeHome": found,
        "jpypeVersion": jpype_version,
        "cacheRoot": CACHE_ROOT,
        "ready": bool(found and jpype_version),
    }
    if found:
        info = protege_info(found)
        report.update(
            {
                "hermitJar": info["hermitJar"],
                "hermitVersion": info["hermitVersion"],
                "owlapiJar": os.path.exists(info["owlapiJar"]),
                "jvm": os.path.exists(info["jvmDll"]),
            }
        )
    if not found:
        report["hint"] = "Set PROTEGE_HOME to the folder that contains bundles/, plugins/ and jre/."
    elif not jpype_version:
        report["hint"] = "Run: python -m pip install jpype1"
    return report


if __name__ == "__main__":
    print(json.dumps(describe(), indent=2, ensure_ascii=False))
