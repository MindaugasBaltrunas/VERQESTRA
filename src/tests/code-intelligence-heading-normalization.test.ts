// Antraščių normalizavimas RAG sekcijų paieškoje.
//
// 2026-08-23 (operatoriaus radinys): raktas buvo TIK ASCII (`[^a-z0-9]+ → "-"`), tad kirilicos,
// kinų ir kitų rašmenų antraštės virsdavo TUŠČIU raktu — `matchHeadingSection` grąžindavo
// `undefined`, ir į pack'ą patekdavo VISAS dokumentas vietoj vienos sekcijos. Tyliai, biudžeto
// sąskaita, išstumdamas kitus įrodymus.
//
// Antra to paties bėda — SUSILIEJIMAI: `Раздел 2` virsdavo `2` ir sutapdavo su bet kuria „## 2";
// lietuviška `Sąsaja` virsdavo `s-saja`, o `Überblick` — `berblick`, prarasdama pirmą raidę. Tai
// lietė ir šio repo dokumentus, ne tik svetimus.
//
// Atskiras failas nuo `code-intelligence`, nes tas peržengė 500 eilučių vartus, o tema savarankiška.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { retrieveSpecFragmentCandidates } from "../application/code-intelligence/retrieval/spec-fragments.js";
import { nodeFsTestPort } from "./helpers/node-fs-port.js";

test("ne lotyniškos antraštės randamos, o ne virsta visu dokumentu", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vq-frag-unicode-"));
  try {
    const doc = [
      "# Документ",
      "įvadas",
      "## Интерфейс",
      "interfeiso tekstas",
      "## Sąsaja",
      "sąsajos tekstas",
      "## Überblick",
      "überblick tekstas",
      "",
    ].join("\n");
    await writeFile(path.join(root, "spec.md"), doc, "utf8");

    const { fragments } = await retrieveSpecFragmentCandidates(
      nodeFsTestPort,
      root,
      ["spec.md#Интерфейс", "spec.md#Sąsaja", "spec.md#Überblick", "spec.md#nerasta"],
      5000,
    );

    assert.equal(fragments[0]?.text, "## Интерфейс\ninterfeiso tekstas", "kirilica randama");
    assert.equal(fragments[0]?.headingMiss, undefined);
    assert.equal(fragments[1]?.text, "## Sąsaja\nsąsajos tekstas", "lietuviška raidė nebeiškrenta");
    assert.equal(fragments[2]?.text, "## Überblick\nüberblick tekstas", "pirma raidė nebeiškrenta");

    // Kontrolė: tikras `headingMiss` toliau veikia — pataisymas neišjungė varto, tik nustojo
    // gaminti netikrus miss'us.
    assert.equal(fragments[3]?.headingMiss, "nerasta");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("skirtingos antraštės NESUSILIEJA į vieną raktą", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vq-frag-collide-"));
  try {
    // Iki taisymo `Раздел 2` virsdavo `2`, t. y. sutapdavo su antrąja antrašte.
    await writeFile(
      path.join(root, "spec.md"),
      ["## Раздел 2", "rusiskas tekstas", "## 2", "skaitinis tekstas", ""].join("\n"),
      "utf8",
    );

    const { fragments } = await retrieveSpecFragmentCandidates(
      nodeFsTestPort,
      root,
      ["spec.md#Раздел 2", "spec.md#2"],
      5000,
    );

    assert.equal(fragments[0]?.text, "## Раздел 2\nrusiskas tekstas");
    assert.equal(fragments[1]?.text, "## 2\nskaitinis tekstas");
    assert.notEqual(fragments[0]?.text, fragments[1]?.text, "dvi skirtingos antraštės — dvi skirtingos sekcijos");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
