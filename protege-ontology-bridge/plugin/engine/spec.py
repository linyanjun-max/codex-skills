# -*- coding: utf-8 -*-
"""Declarative ontology specification: load, validate, and summarize.

The spec is the editable source of truth (a JSON file). Everything downstream --
the .owl file, the reasoner run, the report tables -- is derived from it, so a
typo is caught here, before a JVM is started or a document is written.
"""

from __future__ import annotations

import json
import os

DEFAULT_IRI = "http://www.semanticweb.org/spbpu/tii/lab4/ontology"
XSD_TYPES = {
    "string",
    "integer",
    "int",
    "float",
    "double",
    "decimal",
    "boolean",
    "date",
    "dateTime",
    "anyURI",
}

OBJECT_CHARACTERISTICS = {
    "functional": "Functional",
    "inverseFunctional": "InverseFunctional",
    "transitive": "Transitive",
    "symmetric": "Symmetric",
    "asymmetric": "Asymmetric",
    "reflexive": "Reflexive",
    "irreflexive": "Irreflexive",
}


class SpecError(ValueError):
    pass


def _as_list(value) -> list:
    if value is None:
        return []
    if isinstance(value, list):
        return value
    return [value]


def load(path: str) -> dict:
    """Read and validate a spec file; raises SpecError with every problem found."""
    if not os.path.exists(path):
        raise SpecError("spec file not found: " + path)
    with open(path, "r", encoding="utf-8") as handle:
        try:
            raw = json.load(handle)
        except json.JSONDecodeError as exc:
            raise SpecError("spec is not valid JSON: %s" % exc) from exc
    spec, errors = normalize(raw)
    if errors:
        raise SpecError("invalid spec:\n - " + "\n - ".join(errors))
    spec["_path"] = os.path.abspath(path)
    return spec


def normalize(raw: dict) -> tuple[dict, list[str]]:
    errors: list[str] = []
    warnings: list[str] = []

    if not isinstance(raw, dict):
        return {}, ["spec root must be a JSON object"]

    iri = (raw.get("iri") or DEFAULT_IRI).strip()
    if not iri.startswith("http"):
        errors.append("iri must be an http(s) IRI, got %r" % iri)

    raw_classes = _as_list(raw.get("classes"))
    class_names: list[str] = []
    for entry in raw_classes:
        if isinstance(entry, str):
            entry = {"name": entry}
        name = (entry.get("name") or "").strip()
        if not name:
            errors.append("a class entry has no name")
            continue
        class_names.append(name)
    duplicates = {n for n in class_names if class_names.count(n) > 1}
    if duplicates:
        errors.append("duplicate class names: " + ", ".join(sorted(duplicates)))

    class_set = set(class_names)
    parents = {}
    for entry in raw_classes:
        if isinstance(entry, str):
            entry = {"name": entry}
        name = entry.get("name", "").strip()
        parent = (entry.get("parent") or "Thing").strip()
        parents[name] = parent
        for extra in _as_list(entry.get("parents")):
            if extra and extra not in class_set and extra != "Thing":
                errors.append("class %s: parent %s is not declared" % (name, extra))
        if parent not in class_set and parent != "Thing":
            errors.append("class %s: parent %s is not declared" % (name, parent))

    # cycle detection over the single-parent tree
    for name in class_names:
        seen = set()
        cursor = name
        while cursor in class_set:
            if cursor in seen:
                errors.append("class hierarchy has a cycle through %s" % name)
                break
            seen.add(cursor)
            cursor = parents.get(cursor, "Thing")

    object_properties: list[dict] = []
    for entry in _as_list(raw.get("objectProperties")):
        if isinstance(entry, str):
            entry = {"name": entry}
        name = (entry.get("name") or "").strip()
        if not name:
            errors.append("an object property entry has no name")
            continue
        domain = (entry.get("domain") or "").strip()
        range_ = (entry.get("range") or "").strip()
        if domain and domain not in class_set:
            errors.append("object property %s: domain %s is not a declared class" % (name, domain))
        if range_ and range_ not in class_set:
            errors.append("object property %s: range %s is not a declared class" % (name, range_))
        characteristics = []
        for characteristic in _as_list(entry.get("characteristics")):
            key = str(characteristic).strip()
            if key and key not in OBJECT_CHARACTERISTICS:
                errors.append(
                    "object property %s: unknown characteristic %r (allowed: %s)"
                    % (name, key, ", ".join(sorted(OBJECT_CHARACTERISTICS)))
                )
            elif key:
                characteristics.append(key)
        object_properties.append(
            {
                "name": name,
                "domain": domain or None,
                "range": range_ or None,
                "inverse": (entry.get("inverse") or "").strip() or None,
                "characteristics": characteristics,
                "comment": entry.get("comment") or None,
                "label": entry.get("label") or name,
            }
        )

    data_properties: list[dict] = []
    for entry in _as_list(raw.get("dataProperties")):
        if isinstance(entry, str):
            entry = {"name": entry}
        name = (entry.get("name") or "").strip()
        if not name:
            errors.append("a data property entry has no name")
            continue
        domain = (entry.get("domain") or "").strip()
        range_ = (entry.get("range") or "string").strip()
        if domain and domain not in class_set:
            errors.append("data property %s: domain %s is not a declared class" % (name, domain))
        if range_ not in XSD_TYPES:
            errors.append(
                "data property %s: range %r is not one of %s"
                % (name, range_, ", ".join(sorted(XSD_TYPES)))
            )
        data_properties.append(
            {
                "name": name,
                "domain": domain or None,
                "range": range_,
                "functional": bool(entry.get("functional", True)),
                "comment": entry.get("comment") or None,
                "label": entry.get("label") or name,
            }
        )

    individuals: list[dict] = []
    object_names = {p["name"] for p in object_properties}
    # An inverse property is not declared by hand, but assertions may use it
    # (measurementOf instead of hasMeasurement, resolves instead of resolvedBy).
    inverse_names = {p["inverse"] for p in object_properties if p.get("inverse")}
    object_names |= inverse_names
    data_names = {p["name"] for p in data_properties}
    individual_names: list[str] = []
    for entry in _as_list(raw.get("individuals")):
        name = (entry.get("name") or "").strip()
        if not name:
            errors.append("an individual entry has no name")
            continue
        individual_names.append(name)
        types = [t for t in _as_list(entry.get("types")) if t]
        if not types:
            errors.append("individual %s has no types" % name)
        for type_name in types:
            if type_name not in class_set:
                errors.append("individual %s: type %s is not a declared class" % (name, type_name))
        assertions = []
        for assertion in _as_list(entry.get("objectAssertions")):
            prop = (assertion.get("property") or "").strip()
            target = (assertion.get("target") or "").strip()
            if prop not in object_names:
                errors.append("individual %s: object assertion uses unknown property %r" % (name, prop))
            if not target:
                errors.append("individual %s: object assertion on %s has no target" % (name, prop))
            assertions.append({"property": prop, "target": target})
        data_assertions = []
        for assertion in _as_list(entry.get("dataAssertions")):
            prop = (assertion.get("property") or "").strip()
            if prop not in data_names:
                errors.append("individual %s: data assertion uses unknown property %r" % (name, prop))
            declared = next((p["range"] for p in data_properties if p["name"] == prop), None)
            mentioned = assertion.get("datatype")
            if declared and mentioned and mentioned != declared:
                warnings.append(
                    "individual %s: assertion on %s says xsd:%s but the property range is xsd:%s; "
                    "the range wins" % (name, prop, mentioned, declared)
                )
            data_assertions.append(
                {
                    "property": prop,
                    "value": assertion.get("value"),
                    "datatype": declared or mentioned or "string",
                }
            )
        individuals.append(
            {
                "name": name,
                "types": types,
                "objectAssertions": assertions,
                "dataAssertions": data_assertions,
                "label": entry.get("label") or name,
                "comment": entry.get("comment") or None,
            }
        )

    # object-assertion targets must exist
    individual_set = set(individual_names)
    for individual in individuals:
        for assertion in individual["objectAssertions"]:
            if assertion["target"] not in individual_set:
                errors.append(
                    "individual %s: assertion target %r is not a declared individual"
                    % (individual["name"], assertion["target"])
                )

    axioms = []
    for entry in _as_list(raw.get("classAxioms")):
        subject = (entry.get("subject") or "").strip()
        kind = (entry.get("kind") or "subClassOf").strip()
        expression = (entry.get("expression") or "").strip()
        if subject not in class_set:
            errors.append("class axiom: subject %r is not a declared class" % subject)
        if kind not in ("subClassOf", "equivalentTo"):
            errors.append("class axiom on %s: kind %r is neither subClassOf nor equivalentTo" % (subject, kind))
        if not expression:
            errors.append("class axiom on %s has an empty expression" % subject)
        axioms.append(
            {
                "subject": subject,
                "kind": kind,
                "expression": expression,
                "comment": entry.get("comment") or None,
            }
        )

    disjoint_groups = []
    for group in _as_list(raw.get("disjointGroups")):
        names = [str(n).strip() for n in _as_list(group) if str(n).strip()]
        for name in names:
            if name not in class_set:
                errors.append("disjoint group member %r is not a declared class" % name)
        if len(names) >= 2:
            disjoint_groups.append(names)

    queries = []
    for entry in _as_list(raw.get("queries")):
        expression = (entry.get("expression") or "").strip()
        ask = (entry.get("ask") or "individuals").strip()
        if not expression:
            errors.append("a DL query has an empty expression")
        if ask not in ("individuals", "subclasses", "superclasses", "equivalent"):
            errors.append("DL query %r: ask must be individuals|subclasses|superclasses|equivalent" % expression)
        queries.append(
            {
                "name": (entry.get("name") or expression[:40]).strip(),
                "expression": expression,
                "ask": ask,
                "comment": entry.get("comment") or None,
            }
        )

    source_counts = {"classes": len(class_names)}
    if source_counts["classes"] < 10:
        warnings.append(
            "the assignment asks for 10-15 classes; the spec declares %d" % source_counts["classes"]
        )
    if len(object_properties) < 5:
        warnings.append("the assignment asks for 5-7 object properties; the spec declares %d" % len(object_properties))
    if not 3 <= len(data_properties) <= 5:
        warnings.append("the assignment asks for 3-5 data properties; the spec declares %d" % len(data_properties))
    if not 8 <= len(individuals) <= 12:
        warnings.append("the assignment asks for 8-12 individuals; the spec declares %d" % len(individuals))
    if len(queries) < 3:
        warnings.append("the assignment asks for at least 3 DL queries; the spec declares %d" % len(queries))
    if not axioms:
        warnings.append("no class-level restriction axioms; the assignment asks for several 'some/only' axioms")

    spec = {
        "iri": iri,
        "label": raw.get("label") or "Ontology",
        "comment": raw.get("comment") or None,
        "language": raw.get("language") or "ru",
        "classes": [
            {
                "name": entry.get("name") if isinstance(entry, dict) else entry,
                "parent": (entry.get("parent") if isinstance(entry, dict) else None) or "Thing",
                "label": (entry.get("label") if isinstance(entry, dict) else None)
                or (entry.get("name") if isinstance(entry, dict) else entry),
                "comment": entry.get("comment") if isinstance(entry, dict) else None,
            }
            for entry in raw_classes
        ],
        "objectProperties": object_properties,
        "dataProperties": data_properties,
        "individuals": individuals,
        "classAxioms": axioms,
        "disjointGroups": disjoint_groups,
        "queries": queries,
        "warnings": warnings,
    }
    spec["counts"] = summarize(spec)["counts"]
    return spec, errors


def summarize(spec: dict) -> dict:
    restriction_axioms = sum(1 for a in spec.get("classAxioms", []) if " some " in " %s " % a["expression"] or " only " in " %s " % a["expression"])
    return {
        "counts": {
            "classes": len(spec.get("classes", [])),
            "objectProperties": len(spec.get("objectProperties", [])),
            "dataProperties": len(spec.get("dataProperties", [])),
            "individuals": len(spec.get("individuals", [])),
            "classAxioms": len(spec.get("classAxioms", [])),
            "restrictionAxioms": restriction_axioms,
            "disjointGroups": len(spec.get("disjointGroups", [])),
            "queries": len(spec.get("queries", [])),
            "axiomsTotal": (
                len(spec.get("classes", []))
                + len(spec.get("objectProperties", []))
                + len(spec.get("dataProperties", []))
                + len(spec.get("classAxioms", []))
                + len(spec.get("individuals", []))
            ),
        },
        "warnings": spec.get("warnings", []),
    }


def entities(spec: dict) -> dict:
    """Entity vocabulary for Manchester parsing, including inverse property names."""
    object_properties = [p["name"] for p in spec.get("objectProperties", [])]
    for prop in spec.get("objectProperties", []):
        inverse = prop.get("inverse")
        if inverse and inverse not in object_properties:
            object_properties.append(inverse)
    return {
        "classes": [c["name"] for c in spec.get("classes", [])],
        "objectProperties": object_properties,
        "dataProperties": [p["name"] for p in spec.get("dataProperties", [])],
        "individuals": [i["name"] for i in spec.get("individuals", [])],
    }
