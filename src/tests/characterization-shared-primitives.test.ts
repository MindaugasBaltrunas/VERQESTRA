// VQ-101 characterization (PAR-1): the fixture is a VERBATIM copy of AG_loop's
// shared-primitives.json — it is never edited here; a mismatch means VERQESTRA changed
// frozen behaviour. Kind mapping mirrors the AG_loop runner: canonical -> canonicalJsonStringify,
// sha256/normalized -> normalizedSha256, short-digest -> shortDigest. The JSON-inexpressible
// invariants live below, as the fixture description requires.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { canonicalJsonStringify } from "../shared/json.js";
import { normalizedSha256, sha256Hex, shortDigest } from "../shared/hash.js";

type PrimitiveCase = {
  id: string;
  kind: "canonical" | "sha256" | "normalized" | "short-digest";
  value?: unknown;
  text?: string;
  prefix?: string;
  payload?: unknown;
  expect: Record<string, unknown>;
};

const fixturePath = path.resolve(
  process.cwd(),
  "src",
  "tests",
  "fixtures",
  "characterization",
  "shared-primitives.json",
);
const fixture: { schema_version: number; cases: PrimitiveCase[] } = JSON.parse(await readFile(fixturePath, "utf8"));

function runCase(primitiveCase: PrimitiveCase): unknown {
  switch (primitiveCase.kind) {
    case "canonical":
      return { result: canonicalJsonStringify(primitiveCase.value) };
    case "sha256":
    case "normalized":
      return { digest: normalizedSha256(primitiveCase.text ?? "") };
    case "short-digest":
      return { digest: shortDigest(primitiveCase.prefix ?? "", primitiveCase.payload) };
    default:
      throw new Error(`fixture names unknown kind: ${String(primitiveCase.kind)}`);
  }
}

test("shared-primitives fixture is well-formed (schema v1, unique ids)", () => {
  assert.equal(fixture.schema_version, 1);
  assert.ok(fixture.cases.length >= 16, "fixture must keep its recorded coverage");
  const ids = fixture.cases.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, "case ids must be unique");
});

for (const primitiveCase of fixture.cases) {
  test(`shared primitive contract: ${primitiveCase.id}`, () => {
    const actual = JSON.parse(JSON.stringify(runCase(primitiveCase)));
    assert.deepStrictEqual(actual, primitiveCase.expect, primitiveCase.id);
  });
}

// JSON-inexpressible invariants (mandated by the fixture description):
test("canonicalJsonStringify throws on non-round-trippable values and drops undefined props", () => {
  assert.throws(() => canonicalJsonStringify(undefined), /unsupported value undefined at the document root/);
  assert.throws(() => canonicalJsonStringify(Number.NaN), /unsupported value NaN/);
  assert.throws(() => canonicalJsonStringify(Number.POSITIVE_INFINITY), /unsupported value Infinity/);
  assert.throws(() => canonicalJsonStringify(() => 0), /unsupported value of type function/);
  assert.throws(() => canonicalJsonStringify(BigInt(1)), /unsupported value of type bigint/);
  assert.equal(canonicalJsonStringify({ a: undefined, b: 1 }), '{"b":1}');
  assert.equal(canonicalJsonStringify([undefined, 1]), "[null,1]");
});

test("raw sha256Hex is the well-known digest and differs from the normalized one", () => {
  assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.notEqual(sha256Hex("a\n"), sha256Hex("a"), "raw hashing must NOT trim");
  assert.equal(normalizedSha256("a\n"), sha256Hex("a"), "normalized hashing MUST trim trailing whitespace");
});

test("normalizedSha256 treats CRLF and trailing whitespace as identity, leading space as distinct", () => {
  assert.equal(normalizedSha256("eilutė\r\nantra\r\n"), normalizedSha256("eilutė\nantra"));
  assert.equal(normalizedSha256("eilutė\nantra   \n\n\t "), normalizedSha256("eilutė\nantra"));
  assert.notEqual(normalizedSha256("  eilutė\nantra"), normalizedSha256("eilutė\nantra"));
});

test("shortDigest is key-order invariant, payload- and prefix-sensitive, shaped <prefix>:<16hex>", () => {
  const digest = shortDigest("wp1", { b: 1, a: 2 });
  assert.match(digest, /^wp1:[0-9a-f]{16}$/);
  assert.equal(digest, shortDigest("wp1", { a: 2, b: 1 }));
  assert.notEqual(digest, shortDigest("wp1", { a: 2, b: 2 }));
  assert.notEqual(digest, shortDigest("sr1", { b: 1, a: 2 }));
});
