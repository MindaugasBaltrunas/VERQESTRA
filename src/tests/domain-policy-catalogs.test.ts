// Politikų katalogai (2026-09-02, valdymo ekrano auditas): architektūros stilių ir programavimo
// principų pasirinkimų sąrašai gyvena domain'e, ne naršyklėje. Pin'inama tai, kas anksčiau
// prasilenkė tyliai: naršyklės sąrašas turėjo domain'ui nežinomą stilių ir neturėjo išvedamų,
// o SOLID ėjo be „L".

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ARCHITECTURE_STYLES,
  inferableStylesMissingFromCatalog,
  isArchitectureStyle,
} from "../domain/policies/architecture-style-catalog.js";
import { CODING_PRINCIPLE_IDS, CODING_PRINCIPLES } from "../domain/policies/coding-principles-catalog.js";
import { KNOWN_STYLES } from "../domain/policies/stack-decision-matrix.js";

test("architecture style catalog: apima VISUS išvedamus stilius, be dublių", () => {
  assert.deepEqual(inferableStylesMissingFromCatalog(), [], "kiekvienas KNOWN_STYLES įrašas turi būti kataloge");
  assert.equal(new Set(ARCHITECTURE_STYLES).size, ARCHITECTURE_STYLES.length);
  assert.ok(ARCHITECTURE_STYLES.length > KNOWN_STYLES.length, "katalogas platesnis už išvedimo vokabuliarą");
  assert.ok(isArchitectureStyle("modular_monolith"));
  assert.equal(isArchitectureStyle("spaghetti"), false);
  assert.equal(isArchitectureStyle(undefined), false);
});

test("coding principles catalog: SOLID pilnas, id unikalūs, etiketės netuščios", () => {
  for (const id of ["single_responsibility", "open_closed", "liskov_substitution", "interface_segregation", "dependency_inversion"]) {
    assert.ok((CODING_PRINCIPLE_IDS as readonly string[]).includes(id), `trūksta ${id}`);
  }
  assert.equal(new Set(CODING_PRINCIPLE_IDS).size, CODING_PRINCIPLE_IDS.length);
  assert.ok(CODING_PRINCIPLES.every((principle) => principle.label.trim().length > 0));
  // Id yra JSON raktas ir UI `id` — tik snake_case, be tarpų.
  assert.ok(CODING_PRINCIPLE_IDS.every((id) => /^[a-z][a-z0-9_]*$/.test(id)));
});
