# -*- coding: utf-8 -*-
"""HermiT operations: consistency, hierarchy, inferred types, DL queries.

Everything the lab asks a reasoner to prove is produced here as plain JSON:
whether the ontology is consistent, which classes are unsatisfiable, the inferred
class hierarchy, which classes each individual ends up in (including ones nobody
asserted), and the answers to the Manchester-syntax DL queries.
"""

from __future__ import annotations

import time

from . import manchester, onto


class ReasonerError(RuntimeError):
    pass


def _name(entity) -> str:
    return str(entity.getIRI().getFragment()) or str(entity.getIRI())


def _flatten(node_set) -> list:
    try:
        return list(node_set.getFlattened())
    except Exception:  # pragma: no cover - empty node
        return []


def open_reasoner(java, ontology):
    try:
        factory = java.reasoner_factory()
        reasoner = factory.createReasoner(ontology)
        try:
            reasoner.precomputeInferences()
        except Exception:
            # An inconsistent ontology makes precomputation throw; isConsistent()
            # still answers, and that answer is the useful result.
            pass
        return reasoner
    except Exception as exc:  # pragma: no cover - reasoner startup failure
        raise ReasonerError("HermiT could not be started: %s" % exc) from exc


def consistency(java, reasoner) -> dict:
    consistent = bool(reasoner.isConsistent())
    result = {"consistent": consistent, "unsatisfiable": []}
    if not consistent:
        return result
    try:
        node = reasoner.getUnsatisfiableClasses()
        unsatisfiable = [_name(entity) for entity in node.getEntitiesMinusBottom()]
        result["unsatisfiable"] = sorted(unsatisfiable)
    except Exception:  # pragma: no cover
        pass
    return result


def hierarchy(java, reasoner, depth_limit: int = 12) -> dict:
    """Inferred class hierarchy as a nested tree rooted at owl:Thing."""
    df = java.df
    thing = df.getOWLThing()

    def walk(expression, depth, seen):
        label = _name(expression) if hasattr(expression, "getIRI") else "Thing"
        node = {"name": label, "children": []}
        if depth >= depth_limit:
            return node
        try:
            children = _flatten(reasoner.getSubClasses(expression, True))
        except Exception:  # pragma: no cover
            children = []
        names = sorted({_name(child) for child in children} - {"Nothing"})
        for child_name in names:
            if child_name in seen:
                continue
            child_class = df.getOWLClass(java.iri(onto.namespace_of(java, reasoner.getRootOntology()) + child_name))
            node["children"].append(walk(child_class, depth + 1, seen | {child_name}))
        return node

    tree = walk(thing, 0, set())
    flat = []

    def collect(node, parent, depth):
        flat.append({"name": node["name"], "parent": parent, "depth": depth})
        for child in node["children"]:
            collect(child, node["name"], depth + 1)

    collect(tree, None, 0)
    return {"tree": tree, "flat": flat}


def individual_types(java, reasoner) -> dict:
    """Every individual's inferred (non-direct) types, excluding owl:Thing."""
    result = {}
    for individual in reasoner.getRootOntology().getIndividualsInSignature():
        types = sorted(
            {_name(entity) for entity in _flatten(reasoner.getTypes(individual, False))} - {"Thing"}
        )
        result[_name(individual)] = types
    return result


def run_queries(java, reasoner, ontology, queries: list[dict]) -> list[dict]:
    vocabulary = onto.entity_sets(java, ontology)
    namespace = onto.namespace_of(java, ontology)
    results = []
    for query in queries:
        started = time.time()
        entry = {
            "name": query.get("name"),
            "expression": query["expression"],
            "ask": query.get("ask", "individuals"),
            "comment": query.get("comment"),
        }
        try:
            expression = manchester.evaluate(java, None, namespace, vocabulary, query["expression"])
            ask = entry["ask"]
            if ask == "individuals":
                entities = sorted({_name(i) for i in _flatten(reasoner.getInstances(expression, False))})
                entry["kind"] = "named individuals"
            elif ask == "subclasses":
                entities = sorted(
                    {_name(c) for c in _flatten(reasoner.getSubClasses(expression, False))} - {"Nothing"}
                )
                entry["kind"] = "subclasses"
            elif ask == "superclasses":
                entities = sorted(
                    {_name(c) for c in _flatten(reasoner.getSuperClasses(expression, False))} - {"Thing"}
                )
                entry["kind"] = "superclasses"
            else:
                entities = sorted(
                    {_name(c) for c in _flatten(reasoner.getEquivalentClasses(expression))} - {"Nothing", "Thing"}
                )
                entry["kind"] = "equivalent classes"
            entry["entities"] = entities
            entry["count"] = len(entities)
            entry["ok"] = True
        except Exception as exc:
            entry["ok"] = False
            entry["error"] = str(exc)
            entry["entities"] = []
            entry["count"] = 0
        entry["elapsedMs"] = int((time.time() - started) * 1000)
        results.append(entry)
    return results


def reason(java, ontology, queries: list[dict] | None = None) -> dict:
    started = time.time()
    reasoner = open_reasoner(java, ontology)
    try:
        payload = {"ok": True}
        payload.update(consistency(java, reasoner))
        payload["hierarchy"] = hierarchy(java, reasoner)
        payload["individualTypes"] = individual_types(java, reasoner)
        payload["queries"] = run_queries(java, reasoner, ontology, queries or [])
        payload["reasoner"] = "HermiT"
        payload["elapsedMs"] = int((time.time() - started) * 1000)
        payload["axiomCount"] = int(ontology.getAxiomCount())
        payload["classCount"] = int(ontology.getClassesInSignature().size())
        payload["objectPropertyCount"] = int(ontology.getObjectPropertiesInSignature().size())
        payload["dataPropertyCount"] = int(ontology.getDataPropertiesInSignature().size())
        payload["individualCount"] = int(ontology.getIndividualsInSignature().size())
        return payload
    finally:
        try:
            reasoner.dispose()
        except Exception:  # pragma: no cover
            pass

