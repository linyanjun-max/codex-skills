# -*- coding: utf-8 -*-
"""Turn a validated spec into a real OWL 2 ontology through the OWL API.

The .owl file is produced by the OWL API itself (not hand-written RDF/XML), so
Protégé re-opens it without normalisation warnings and the axiom count matches
what a reasoner sees.
"""

from __future__ import annotations

import os

from . import manchester, spec as spec_module


def _annotation_assertion(java, entity, property_name: str, value: str, language: str):
    df = java.df
    literal = df.getOWLLiteral(value, language)
    annotation_property = df.getRDFSLabel() if property_name == "label" else df.getRDFSComment()
    annotation = df.getOWLAnnotation(annotation_property, literal)
    return df.getOWLAnnotationAssertionAxiom(entity.getIRI(), annotation)


def _literal_for(java, datatype: str, value):
    """Build a literal typed exactly like the property's declared range.

    ``xsd:double`` and ``xsd:float`` have different value spaces, so letting a
    Python float become an ``xsd:double`` literal while the property range says
    ``xsd:float`` makes HermiT report the whole ontology inconsistent. The range
    therefore wins over any datatype mentioned in the assertion.
    """
    df = java.df
    datatype = datatype if datatype in (
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
    ) else "string"

    if datatype == "boolean":
        lexical = "true" if value in (True, "true", "1", "yes", 1) else "false"
    elif datatype in ("integer", "int"):
        lexical = str(int(float(value)))
    elif datatype in ("float", "double", "decimal"):
        lexical = repr(float(value))
    else:
        lexical = str(value)

    if datatype == "string":
        return df.getOWLLiteral(lexical)
    return df.getOWLLiteral(lexical, df.getOWLDatatype(java.iri(manchester.XSD + datatype)))


def _data_property_ranges(spec: dict) -> dict:
    return {entry["name"]: entry.get("range", "string") for entry in spec.get("dataProperties", [])}


def build(java, spec: dict) -> dict:
    """Create the ontology in memory from ``spec``; returns a summary dict."""
    df = java.df
    namespace = spec["iri"].rstrip("#/") + "#"
    manager = java.manager()
    ontology = manager.createOntology(java.iri(namespace.rstrip("#")))

    owl_classes: dict[str, object] = {}
    for entry in spec["classes"]:
        owl_classes[entry["name"]] = df.getOWLClass(java.iri(namespace + entry["name"]))

    # class hierarchy
    for entry in spec["classes"]:
        name = entry["name"]
        parent = entry.get("parent") or "Thing"
        if parent and parent != "Thing":
            manager.addAxiom(ontology, df.getOWLSubClassOfAxiom(owl_classes[name], owl_classes[parent]))

    # disjointness between top-level groups
    for group in spec.get("disjointGroups", []):
        members = [owl_classes[name] for name in group if name in owl_classes]
        if len(members) >= 2:
            array = java.array("org.semanticweb.owlapi.model.OWLClassExpression", members)
            manager.addAxiom(ontology, df.getOWLDisjointClassesAxiom(array))

    # annotations on classes
    entity_annotation_language = spec.get("language") or "ru"
    for entry in spec["classes"]:
        entity = owl_classes[entry["name"]]
        label = entry.get("label")
        if label:
            manager.addAxiom(
                ontology,
                _annotation_assertion(java, entity, "label", label, entity_annotation_language),
            )
        comment = entry.get("comment")
        if comment:
            manager.addAxiom(
                ontology,
                _annotation_assertion(java, entity, "comment", comment, entity_annotation_language),
            )

    # object properties
    owl_object_properties: dict[str, object] = {}
    for entry in spec["objectProperties"]:
        name = entry["name"]
        prop = df.getOWLObjectProperty(java.iri(namespace + name))
        owl_object_properties[name] = prop
        if entry.get("domain") in owl_classes:
            manager.addAxiom(ontology, df.getOWLObjectPropertyDomainAxiom(prop, owl_classes[entry["domain"]]))
        if entry.get("range") in owl_classes:
            manager.addAxiom(ontology, df.getOWLObjectPropertyRangeAxiom(prop, owl_classes[entry["range"]]))
        if entry.get("label"):
            manager.addAxiom(
                ontology,
                _annotation_assertion(java, prop, "label", entry["label"], entity_annotation_language),
            )
        if entry.get("comment"):
            manager.addAxiom(
                ontology,
                _annotation_assertion(java, prop, "comment", entry["comment"], entity_annotation_language),
            )

    # inverse pairs (declared once, from whichever side mentions it)
    for entry in spec["objectProperties"]:
        inverse_name = entry.get("inverse")
        if not inverse_name:
            continue
        inverse = owl_object_properties.get(inverse_name)
        if inverse is None:
            inverse = df.getOWLObjectProperty(java.iri(namespace + inverse_name))
            owl_object_properties[inverse_name] = inverse
        manager.addAxiom(
            ontology,
            df.getOWLInverseObjectPropertiesAxiom(owl_object_properties[entry["name"]], inverse),
        )

    # property characteristics
    characteristic_builders = {
        "functional": "getOWLFunctionalObjectPropertyAxiom",
        "inverseFunctional": "getOWLInverseFunctionalObjectPropertyAxiom",
        "transitive": "getOWLTransitiveObjectPropertyAxiom",
        "symmetric": "getOWLSymmetricObjectPropertyAxiom",
        "asymmetric": "getOWLAsymmetricObjectPropertyAxiom",
        "reflexive": "getOWLReflexiveObjectPropertyAxiom",
        "irreflexive": "getOWLIrreflexiveObjectPropertyAxiom",
    }
    for entry in spec["objectProperties"]:
        prop = owl_object_properties[entry["name"]]
        for characteristic in entry.get("characteristics", []):
            builder = characteristic_builders.get(characteristic)
            if builder:
                manager.addAxiom(ontology, getattr(df, builder)(prop))

    # data properties
    owl_data_properties: dict[str, object] = {}
    for entry in spec["dataProperties"]:
        name = entry["name"]
        prop = df.getOWLDataProperty(java.iri(namespace + name))
        owl_data_properties[name] = prop
        if entry.get("domain") in owl_classes:
            manager.addAxiom(ontology, df.getOWLDataPropertyDomainAxiom(prop, owl_classes[entry["domain"]]))
        manager.addAxiom(
            ontology,
            df.getOWLDataPropertyRangeAxiom(prop, df.getOWLDatatype(java.iri(manchester.XSD + entry["range"]))),
        )
        if entry.get("functional", True):
            manager.addAxiom(ontology, df.getOWLFunctionalDataPropertyAxiom(prop))
        if entry.get("label"):
            manager.addAxiom(
                ontology,
                _annotation_assertion(java, prop, "label", entry["label"], entity_annotation_language),
            )
        if entry.get("comment"):
            manager.addAxiom(
                ontology,
                _annotation_assertion(java, prop, "comment", entry["comment"], entity_annotation_language),
            )

    # restriction / equivalence axioms written in Manchester syntax
    vocabulary = spec_module.entities(spec)
    for entry in spec.get("classAxioms", []):
        subject = owl_classes[entry["subject"]]
        expression = manchester.evaluate(java, None, namespace, vocabulary, entry["expression"])
        if entry["kind"] == "equivalentTo":
            array = java.array(
                "org.semanticweb.owlapi.model.OWLClassExpression", [subject, expression]
            )
            axiom = df.getOWLEquivalentClassesAxiom(array)
        else:
            axiom = df.getOWLSubClassOfAxiom(subject, expression)
        manager.addAxiom(ontology, axiom)

    # individuals
    owl_individuals: dict[str, object] = {}
    for entry in spec["individuals"]:
        individual = df.getOWLNamedIndividual(java.iri(namespace + entry["name"]))
        owl_individuals[entry["name"]] = individual
        for type_name in entry["types"]:
            if type_name in owl_classes:
                manager.addAxiom(ontology, df.getOWLClassAssertionAxiom(owl_classes[type_name], individual))
        if entry.get("label"):
            manager.addAxiom(
                ontology,
                _annotation_assertion(java, individual, "label", entry["label"], entity_annotation_language),
            )
        if entry.get("comment"):
            manager.addAxiom(
                ontology,
                _annotation_assertion(java, individual, "comment", entry["comment"], entity_annotation_language),
            )

    data_ranges = _data_property_ranges(spec)
    for entry in spec["individuals"]:
        individual = owl_individuals[entry["name"]]
        for assertion in entry.get("objectAssertions", []):
            prop = owl_object_properties.get(assertion["property"])
            target = owl_individuals.get(assertion["target"])
            if prop is None or target is None:
                continue
            manager.addAxiom(
                ontology, df.getOWLObjectPropertyAssertionAxiom(prop, individual, target)
            )
        for assertion in entry.get("dataAssertions", []):
            prop = owl_data_properties.get(assertion["property"])
            if prop is None:
                continue
            declared_range = data_ranges.get(assertion["property"], "string")
            literal = _literal_for(java, declared_range, assertion.get("value"))
            manager.addAxiom(ontology, df.getOWLDataPropertyAssertionAxiom(prop, individual, literal))

    return {
        "namespace": namespace,
        "ontology": ontology,
        "manager": manager,
        "iri": namespace,
    }


def save(java, built: dict, path: str, turtle: bool = False) -> dict:
    """Persist an in-memory ontology to RDF/XML (and optionally Turtle)."""
    manager = built["manager"]
    ontology = built["ontology"]
    os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
    if turtle:
        manager.saveOntology(ontology, java.turtle_format(), java.file_iri(os.path.abspath(path)))
    else:
        manager.saveOntology(ontology, java.rdfxml_format(), java.file_iri(os.path.abspath(path)))
    return {
        "path": os.path.abspath(path),
        "bytes": os.path.getsize(path),
        "axioms": int(ontology.getAxiomCount()),
    }


def load(java, path: str) -> dict:
    """Load an existing ontology document from disk."""
    manager = java.manager()
    ontology = manager.loadOntologyFromOntologyDocument(java.file_iri(os.path.abspath(path)))
    namespace = None
    try:
        document_iri = str(ontology.getOntologyID().getOntologyIRI().orNull())
        namespace = document_iri.rstrip("#/") + "#"
    except Exception:  # pragma: no cover - anonymous ontologies
        namespace = None
    return {"manager": manager, "ontology": ontology, "namespace": namespace, "iri": namespace}


def namespace_of(java, ontology) -> str:
    iri = str(ontology.getOntologyID().getOntologyIRI().orNull())
    return iri.rstrip("#/") + "#"


def entity_sets(java, ontology) -> dict:
    """Declared entity names (IRI fragments) for expression parsing."""
    def fragments(entities):
        names = []
        for entity in entities:
            names.append(str(entity.getIRI().getFragment()) or str(entity.getIRI()))
        return names

    return {
        "classes": fragments(ontology.getClassesInSignature()),
        "objectProperties": fragments(ontology.getObjectPropertiesInSignature()),
        "dataProperties": fragments(ontology.getDataPropertiesInSignature()),
        "individuals": fragments(ontology.getIndividualsInSignature()),
    }
