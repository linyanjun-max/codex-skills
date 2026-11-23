# -*- coding: utf-8 -*-
"""A small Manchester-syntax reader that emits OWL API class expressions.

We only need the subset a lab ontology uses (and that students type into
Protégé's DL Query tab), so the grammar is deliberately tiny:

    or      := and ( 'or' and )*
    and     := unary ( 'and' unary )*
    unary   := 'not' unary | primary
    primary := '(' or ')'
             | property ('some'|'only') unary
             | objectProperty 'value' individual
             | dataProperty 'value' literal
             | className

Names are resolved against the ontology's declared entity sets, so a typo is
reported as an error instead of silently creating a new class -- which is exactly
the mistake a reasoner would otherwise hide behind an "empty result".
"""

from __future__ import annotations

import re
from typing import Iterable

XSD = "http://www.w3.org/2001/XMLSchema#"

XSD_ALIASES = {
    "string": "string",
    "int": "int",
    "integer": "integer",
    "float": "float",
    "double": "double",
    "decimal": "decimal",
    "boolean": "boolean",
    "dateTime": "dateTime",
    "date": "date",
    "anyURI": "anyURI",
}

RESTRICTION_WORDS = {"some", "only", "value", "min", "max", "exactly"}

_TOKEN_RE = re.compile(
    r"""\s*(?:
        (?P<punct>[()])
      | (?P<string>"(?:[^"\\]|\\.)*")
      | (?P<number>-?\d+(?:\.\d+)?)
      | (?P<word>[^\s()]+)
    )""",
    re.VERBOSE,
)


class ExpressionError(ValueError):
    """Raised for an unparsable or unresolvable class expression."""


def tokenize(text: str) -> list[str]:
    tokens: list[str] = []
    position = 0
    while position < len(text):
        match = _TOKEN_RE.match(text, position)
        if not match:
            break
        position = match.end()
        token = match.group("punct") or match.group("string") or match.group("number") or match.group("word")
        if token is None:
            continue
        tokens.append(token)
    return tokens


class ManchesterReader:
    def __init__(self, java, namespace: str, classes: Iterable[str], object_properties: Iterable[str], data_properties: Iterable[str], individuals: Iterable[str]):
        self.java = java
        self.df = java.df
        self.namespace = namespace
        self.classes = set(classes)
        self.object_properties = set(object_properties)
        self.data_properties = set(data_properties)
        self.individuals = set(individuals)

    # -- entity helpers ----------------------------------------------------
    def _iri(self, local: str):
        return self.java.iri(self.namespace + local)

    def owl_class(self, name: str):
        return self.df.getOWLClass(self._iri(name))

    def _object_property(self, name: str):
        return self.df.getOWLObjectProperty(self._iri(name))

    def _data_property(self, name: str):
        return self.df.getOWLDataProperty(self._iri(name))

    def _individual(self, name: str):
        return self.df.getOWLNamedIndividual(self._iri(name))

    def _datatype(self, alias: str):
        local = XSD_ALIASES.get(alias)
        if local is None:
            raise ExpressionError("unknown datatype: %s" % alias)
        return self.df.getOWLDatatype(self.java.iri(XSD + local))

    def _literal(self, token: str, datatype: str | None):
        if token.startswith('"') and token.endswith('"'):
            text = token[1:-1].replace('\\"', '"')
            if datatype:
                return self.df.getOWLLiteral(text, self._datatype(datatype))
            # plain xsd:string, not a language-tagged literal: ABox values are
            # written as plain strings, and "критическое"@en would never match them
            return self.df.getOWLLiteral(text)
        numeric = token
        alias = datatype or ("float" if "." in numeric else "integer")
        if alias in ("float", "double", "decimal"):
            return self.df.getOWLLiteral(numeric, self._datatype(alias))
        if alias == "integer" or alias == "int":
            return self.df.getOWLLiteral(numeric, self._datatype("integer"))
        return self.df.getOWLLiteral(numeric, self._datatype(alias))

    # -- parser ------------------------------------------------------------
    def parse(self, text: str):
        self.tokens = tokenize(text)
        self.position = 0
        if not self.tokens:
            raise ExpressionError("empty class expression")
        expression = self._parse_or()
        if self.position != len(self.tokens):
            raise ExpressionError(
                "unexpected token %r in %r" % (self.tokens[self.position], text)
            )
        return expression

    def _peek(self) -> str | None:
        if self.position < len(self.tokens):
            return self.tokens[self.position]
        return None

    def _take(self) -> str:
        token = self._peek()
        if token is None:
            raise ExpressionError("unexpected end of expression")
        self.position += 1
        return token

    def _accept(self, word: str) -> bool:
        token = self._peek()
        if token is not None and token.lower() == word:
            self.position += 1
            return True
        return False

    def _parse_or(self):
        left = self._parse_and()
        items = [left]
        while self._accept("or"):
            items.append(self._parse_and())
        if len(items) == 1:
            return left
        return self.df.getOWLObjectUnionOf(self.java.array("org.semanticweb.owlapi.model.OWLClassExpression", items))

    def _parse_and(self):
        left = self._parse_unary()
        items = [left]
        while self._accept("and"):
            items.append(self._parse_unary())
        if len(items) == 1:
            return left
        return self.df.getOWLObjectIntersectionOf(
            self.java.array("org.semanticweb.owlapi.model.OWLClassExpression", items)
        )

    def _parse_unary(self):
        if self._accept("not"):
            return self.df.getOWLObjectComplementOf(self._parse_unary())
        return self._parse_primary()

    def _parse_primary(self):
        token = self._peek()
        if token is None:
            raise ExpressionError("unexpected end of expression")
        if token == "(":
            self.position += 1
            inner = self._parse_or()
            if self._peek() != ")":
                raise ExpressionError("missing ')'")
            self.position += 1
            return inner

        word = self._take()
        following = self._peek()
        is_restriction = following is not None and following.lower() in RESTRICTION_WORDS

        if is_restriction and word in self.object_properties:
            keyword = following.lower()
            self.position += 1  # consume some/only/value
            filler = self._parse_unary()
            if keyword == "some":
                return self.df.getOWLObjectSomeValuesFrom(self._object_property(word), filler)
            if keyword == "only":
                return self.df.getOWLObjectAllValuesFrom(self._object_property(word), filler)
            if keyword == "value":
                return self.df.getOWLObjectHasValue(self._object_property(word), filler)
            raise ExpressionError("unsupported restriction %r on object property %r" % (keyword, word))

        if is_restriction and word in self.data_properties:
            keyword = following.lower()
            self.position += 1  # consume some/only/value
            literal_token = self._take()
            datatype = None
            if self._peek() is not None and self._peek().startswith("xsd:"):
                datatype = self._take()[len("xsd:"):]
            literal = self._literal(literal_token, datatype)
            if keyword == "value":
                return self.df.getOWLDataHasValue(self._data_property(word), literal)
            if keyword == "some":
                return self.df.getOWLDataSomeValuesFrom(
                    self._data_property(word), self._datatype(datatype or "string")
                )
            raise ExpressionError("unsupported restriction %r on data property %r" % (keyword, word))

        if word in self.classes:
            return self.owl_class(word)
        raise ExpressionError(
            "unknown name %r (not a class, object property or data property of this ontology)" % word
        )


def evaluate(java, annotation, namespace: str, entities: dict, text: str):
    """Parse ``text`` against the ontology's vocabulary and return an OWL object."""
    reader = ManchesterReader(
        java,
        namespace,
        entities.get("classes", ()),
        entities.get("objectProperties", ()),
        entities.get("dataProperties", ()),
        entities.get("individuals", ()),
    )
    return reader.parse(text)
