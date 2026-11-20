# -*- coding: utf-8 -*-
"""Command line entry point. Every subcommand prints one JSON object to stdout,
so the DSH plugin can pass the result straight back to the agent.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import traceback

if __package__ in (None, ""):  # allow `python cli.py ...` from anywhere
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from engine import jvm, onto, reasoner, report, spec as spec_module  # noqa: WPS433
else:
    from . import jvm, onto, reasoner, report, spec as spec_module


def _emit(payload: dict, code: int = 0) -> int:
    sys.stdout.write(json.dumps(payload, indent=2, ensure_ascii=False, default=str))
    sys.stdout.write("\n")
    return code


def _fail(message: str, code: int = 1, **extra) -> int:
    payload = {"ok": False, "error": message}
    payload.update(extra)
    return _emit(payload, code)


def cmd_status(args) -> int:
    info = jvm.describe(args.protege)
    info["engine"] = os.path.dirname(os.path.abspath(__file__))
    return _emit({"ok": bool(info.get("ready")), **info}, 0 if info.get("ready") else 1)


def cmd_check(args) -> int:
    try:
        spec = spec_module.load(args.spec)
    except spec_module.SpecError as exc:
        return _fail(str(exc), spec=args.spec)
    payload = {"ok": True, "spec": os.path.abspath(args.spec), "iri": spec["iri"]}
    payload.update(spec_module.summarize(spec))
    return _emit(payload)


def _java(args):
    return jvm.java(getattr(args, "protege", None))


def cmd_build(args) -> int:
    spec = spec_module.load(args.spec)
    java = _java(args)
    built = onto.build(java, spec)
    saved = onto.save(java, built, args.out, turtle=False)
    payload = {
        "ok": True,
        "owl": saved["path"],
        "bytes": saved["bytes"],
        "axioms": saved["axioms"],
        "iri": built["namespace"].rstrip("#"),
    }
    payload.update(spec_module.summarize(spec))
    if args.turtle:
        turtle_path = os.path.splitext(args.out)[0] + ".ttl"
        onto.save(java, built, turtle_path, turtle=True)
        payload["turtle"] = turtle_path
    return _emit(payload)


def _load_ontology(java, args):
    """Load the ontology under analysis; the spec (if given) supplies the queries."""
    if args.owl:
        loaded = onto.load(java, args.owl)
        spec = spec_module.load(args.spec) if getattr(args, "spec", None) else None
        return loaded, spec
    spec = spec_module.load(args.spec)
    built = onto.build(java, spec)
    if args.out:
        onto.save(java, built, args.out)
        return onto.load(java, args.out), spec
    return built, spec


def cmd_reason(args) -> int:
    java = _java(args)
    loaded, spec = _load_ontology(java, args)
    queries = (spec or {}).get("queries", [])
    payload = reasoner.reason(java, loaded["ontology"], queries)
    payload["owl"] = os.path.abspath(args.owl or args.out or "") or None
    if spec:
        payload["spec"] = os.path.abspath(args.spec)
        counts = spec_module.summarize(spec)["counts"]
        payload["specCounts"] = counts
    if args.save_json:
        os.makedirs(os.path.dirname(os.path.abspath(args.save_json)) or ".", exist_ok=True)
        with open(args.save_json, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2, ensure_ascii=False, default=str)
        payload["savedJson"] = os.path.abspath(args.save_json)
    return _emit(payload, 0 if payload.get("consistent") else 1)


def cmd_report(args) -> int:
    spec = spec_module.load(args.spec)
    java = _java(args)
    built = onto.build(java, spec)
    owl_path = args.owl or os.path.splitext(args.out)[0] + ".owl"
    saved = onto.save(java, built, owl_path)
    ontology = onto.load(java, saved["path"])["ontology"]
    analysis = reasoner.reason(java, ontology, spec.get("queries", []))
    payload = report.build_report(
        java,
        spec,
        analysis,
        out_docx=args.out,
        figures_dir=args.figures or os.path.join(os.path.dirname(os.path.abspath(args.out)), "figures"),
        template=args.template,
        owl_path=saved["path"],
    )
    payload["ok"] = True
    payload["owl"] = saved["path"]
    payload["consistent"] = analysis.get("consistent")
    return _emit(payload)


def cmd_all(args) -> int:
    spec = spec_module.load(args.spec)
    java = _java(args)
    outdir = os.path.abspath(args.outdir)
    os.makedirs(outdir, exist_ok=True)
    owl_path = os.path.join(outdir, "ontology.owl")
    built = onto.build(java, spec)
    saved = onto.save(java, built, owl_path)
    ontology = onto.load(java, saved["path"])["ontology"]
    analysis = reasoner.reason(java, ontology, spec.get("queries", []))
    with open(os.path.join(outdir, "reasoning.json"), "w", encoding="utf-8") as handle:
        json.dump(analysis, handle, indent=2, ensure_ascii=False, default=str)
    payload = {
        "ok": analysis.get("consistent", False),
        "outdir": outdir,
        "owl": saved["path"],
        "reasoningJson": os.path.join(outdir, "reasoning.json"),
        "consistent": analysis.get("consistent"),
        "counts": spec_module.summarize(spec)["counts"],
        "queries": [
            {"name": q["name"], "count": q["count"], "entities": q["entities"]}
            for q in analysis.get("queries", [])
        ],
        "unsatisfiable": analysis.get("unsatisfiable"),
    }
    if not args.skip_report:
        report_payload = report.build_report(
            java,
            spec,
            analysis,
            out_docx=os.path.join(outdir, "report.docx"),
            figures_dir=os.path.join(outdir, "figures"),
            template=args.template,
            owl_path=saved["path"],
        )
        payload["report"] = report_payload
    return _emit(payload)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="onto-engine", description="Ontology build / reason / report engine")
    parser.add_argument("--protege", default=None, help="Protégé home directory (contains bundles/, plugins/, jre/)")
    subparsers = parser.add_subparsers(dest="command", required=True)

    status = subparsers.add_parser("status", help="Report Protégé / jpype / cache readiness")
    status.set_defaults(func=cmd_status)

    check = subparsers.add_parser("check", help="Validate a spec file without starting the JVM")
    check.add_argument("--spec", required=True)
    check.set_defaults(func=cmd_check)

    build = subparsers.add_parser("build", help="Build a .owl ontology from a spec")
    build.add_argument("--spec", required=True)
    build.add_argument("--out", required=True)
    build.add_argument("--turtle", action="store_true")
    build.set_defaults(func=cmd_build)

    reason = subparsers.add_parser("reason", help="Run HermiT and the DL queries")
    reason.add_argument("--spec")
    reason.add_argument("--owl")
    reason.add_argument("--out", help="Where to save the built ontology when --spec is used")
    reason.add_argument("--save-json", dest="save_json")
    reason.set_defaults(func=cmd_reason)

    build_report = subparsers.add_parser("report", help="Generate figures and the Russian DOCX report")
    build_report.add_argument("--spec", required=True)
    build_report.add_argument("--out", required=True)
    build_report.add_argument("--owl", default=None)
    build_report.add_argument("--figures", default=None)
    build_report.add_argument("--template", default=None)
    build_report.set_defaults(func=cmd_report)

    everything = subparsers.add_parser("all", help="build + reason + figures + report in one run")
    everything.add_argument("--spec", required=True)
    everything.add_argument("--outdir", required=True)
    everything.add_argument("--template", default=None)
    everything.add_argument("--skip-report", action="store_true")
    everything.set_defaults(func=cmd_all)

    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except spec_module.SpecError as exc:
        return _fail(str(exc))
    except jvm.JvmError as exc:
        return _fail(str(exc), hint="python engine/cli.py status")
    except Exception as exc:  # noqa: BLE001 - CLI boundary
        return _fail(str(exc), traceback=traceback.format_exc().splitlines()[-8:])


if __name__ == "__main__":
    sys.exit(main())
