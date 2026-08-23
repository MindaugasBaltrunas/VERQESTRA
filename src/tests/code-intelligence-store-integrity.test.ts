// 2026-08-23 (operatoriaus radinys): „fresh" indeksas negarantavo saugyklos VIENTISUMO.
//
// JSON/JSONL buvo skaitomi nevaliduojamais type cast'ais, o `checkCodeIndexFreshness` tikrino tik
// manifesto egzistavimą, versiją ir `source_hash`. Manifeste užrašyti kiekiai su faktiniu turiniu
// nebuvo lyginami niekada.
//
// Atkurta: ištuštinus `edges.jsonl`, freshness grąžino `ok: true`, o architektūros ribų pažeidimų
// skaičius nukrito nuo 1 iki 0. Tai fail-open ANT VARTO, o ne vien duomenų higiena: sugadinta
// saugykla atrodė kaip švarus projektas.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildCodeIndex } from "../application/code-intelligence/indexing/builder.js";
import { checkCodeIndexFreshness, codeIndexPath, readCodeIndex } from "../application/code-intelligence/store/code-index-store.js";
import { findArchitectureBoundaryViolations } from "../application/code-intelligence/boundary/architecture-boundary.js";
import { nodeFsTestPort } from "./helpers/node-fs-port.js";

const POLICY = { layers: ["domain", "application"], forbidden_dependencies: ["domain -> application"] };

async function world(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vq-store-integrity-"));
  await mkdir(path.join(root, "src", "domain"), { recursive: true });
  await mkdir(path.join(root, "src", "application"), { recursive: true });
  await writeFile(path.join(root, "src", "application", "service.py"), "def run():\n    return 1\n", "utf8");
  await writeFile(path.join(root, "src", "domain", "rules.py"), "from ..application.service import run\n", "utf8");
  await buildCodeIndex(nodeFsTestPort, root);
  return root;
}

test("ištuštintas edges.jsonl NEBĖRA šviežias indeksas", async () => {
  const root = await world();
  try {
    // Prieš: pažeidimas matomas — būtent jį sugadinta saugykla ir paslėpdavo.
    const before = findArchitectureBoundaryViolations(await readCodeIndex(nodeFsTestPort, root), POLICY);
    assert.equal(before.length, 1, "kontrolė: sveika saugykla randa pažeidimą");
    assert.equal((await checkCodeIndexFreshness(nodeFsTestPort, root)).ok, true);

    await writeFile(codeIndexPath(root, "edges.jsonl"), "", "utf8");

    const freshness = await checkCodeIndexFreshness(nodeFsTestPort, root);
    assert.equal(freshness.ok, false, "manifesto kiekiai privalo būti tikrinami");
    assert.match(
      freshness.ok ? "" : freshness.reason,
      /corrupt.*edge records/,
      "priežastis įvardija, KAS neatitinka, o ne tik „blogai\"",
    );

    // Ir tai, dėl ko visa tai svarbu: be varto pažeidimas dingsta be pėdsako.
    const after = findArchitectureBoundaryViolations(await readCodeIndex(nodeFsTestPort, root), POLICY);
    assert.equal(after.length, 0, "sugadinta saugykla NERANDA pažeidimo — todėl ji ir negali būti laikoma šviežia");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 2026-08-23 (operatoriaus radinys): JSON buvo sąmoningai išmestas iš `source_hash`, o grįždavo tik
// per `kind === "config"` išimtį, kurią lemia VARDŲ heuristika. Todėl `data.json` turinio
// pakeitimas indekso nepasendindavo — nors tas failas indekse YRA ir neša savo `hash`.
test("KIEKVIENO indeksuoto failo pakeitimas pasendina indeksą", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vq-source-hash-"));
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "main.ts"), "export const a = 1;\n", "utf8");
    await writeFile(path.join(root, "src", "data.json"), JSON.stringify({ v: 1 }), "utf8");
    await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: {} }), "utf8");
    await buildCodeIndex(nodeFsTestPort, root);

    // `data.json` vardas neatitinka jokios config heuristikos — būtent tokie failai ir buvo akli.
    await writeFile(path.join(root, "src", "data.json"), JSON.stringify({ v: 999 }), "utf8");
    const afterData = await checkCodeIndexFreshness(nodeFsTestPort, root);
    assert.equal(afterData.ok, false, "eilinio JSON pakeitimas privalo pasendinti indeksą");

    await buildCodeIndex(nodeFsTestPort, root);
    await writeFile(path.join(root, "src", "main.ts"), "export const a = 2;\n", "utf8");
    assert.equal((await checkCodeIndexFreshness(nodeFsTestPort, root)).ok, false, "kontrolė: kodas irgi");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Kita to paties pakeitimo pusė: įtraukus JSON, PATIES įrankio išvestis būtų nuolat sendinusi
// indeksą, kurį jis ką tik naudojo. `vq/supervisor` ir `vq/generated` skenavime trūko — AG pusėje
// `AG/supervisor` buvo, o jo VQ atitikmuo migruojant neatsirado.
test("įrankio išvestis NĖRA produkto kodas", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vq-runtime-scan-"));
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(path.join(root, "vq", "supervisor"), { recursive: true });
    await mkdir(path.join(root, "vq", "generated"), { recursive: true });
    await writeFile(path.join(root, "src", "main.ts"), "export const a = 1;\n", "utf8");

    const index = await buildCodeIndex(nodeFsTestPort, root);
    const before = index.manifest.source_hash;
    assert.deepEqual(index.files.map((file) => file.path), ["src/main.ts"], "skenuojamas TIK produkto medis");

    await writeFile(path.join(root, "vq", "supervisor", "context-pack.json"), JSON.stringify({ big: "pack" }), "utf8");
    await writeFile(path.join(root, "vq", "generated", "out.json"), JSON.stringify({ x: 1 }), "utf8");

    assert.equal((await checkCodeIndexFreshness(nodeFsTestPort, root)).ok, true, "sava išvestis indekso NESENDINA");
    assert.equal((await buildCodeIndex(nodeFsTestPort, root)).manifest.source_hash, before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("nukirstas files.jsonl ir sugadinta eilutė gaudomi atskirai", async () => {
  const root = await world();
  try {
    // A. Trūksta įrašo — kiekiai nesutampa.
    await writeFile(codeIndexPath(root, "files.jsonl"), "", "utf8");
    const truncated = await checkCodeIndexFreshness(nodeFsTestPort, root);
    assert.equal(truncated.ok, false);
    assert.match(truncated.ok ? "" : truncated.reason, /corrupt.*file records/);

    // B. Struktūriškai netinkama eilutė — schema, ne kiekiai.
    await writeFile(codeIndexPath(root, "edges.jsonl"), `${JSON.stringify({ from: "a", to: "b" })}\n`, "utf8");
    const shapeless = await checkCodeIndexFreshness(nodeFsTestPort, root);
    assert.equal(shapeless.ok, false, "briauna be `type` yra NEMATOMA briauna — vartas atrenka pagal tipą");
    assert.match(shapeless.ok ? "" : shapeless.reason, /edges\.jsonl line 1/, "įvardijama konkreti eilutė");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
