// 2026-08-24 RAG auditas 4 — konteksto PRARADIMŲ matomumas ir kandidatų tikslumas.
//
// Bendra visų šių radinių gija: pack'as atrodydavo pilnas tada, kai nebuvo. Vieni praradimai
// įvykdavo PO to, kai įspėjimai jau buvo užrakinti; kiti nebuvo praradimai, o priešingai — triukšmas,
// kuris išstumdavo tikrą kontekstą. Abi klaidos baigiasi tuo pačiu: worker'is dirba su nepilna
// specifikacija ir apie tai nežino.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildCodeIndex } from "../application/code-intelligence/indexing/builder.js";
import { gatherCodeContextCandidates, type CodeContextCandidates } from "../application/context-pack/assemble/gather.js";
import { DEFAULT_CONTEXT_SELECTION_LIMITS } from "../application/policy-governance/context-selection-policy.js";
import { nodeContextPackFsPort, nodeFsTestPort } from "./helpers/node-fs-port.js";
import {
  applySpecFragmentBudget,
  clipToBoundary,
  MAX_SPEC_CANDIDATES,
  retrieveSpecFragmentCandidates,
  type RetrievedFragment,
} from "../application/code-intelligence/retrieval/spec-fragments.js";
import { capSpecRetrievalWarnings, specSelectionDropWarning } from "../application/context-pack/assemble/spec-phase.js";
import { PACK_SEMANTICS_DESCRIPTOR } from "../application/context-pack/context-cache-key.js";
import { IMPACTED_TEST_IMPORTER_DEPTH } from "../application/code-intelligence/query/query.js";
import type { CodeIntelligenceFileSystemPort } from "../application/code-intelligence/ports.js";

function fragment(ref: string, text: string, fullText?: string): RetrievedFragment {
  return { ref, text, ...(fullText !== undefined ? { fullText } : {}) };
}

// ─── P2: biudžetas ir dedup (144-b: tapatybė NEKIRPTAS turinys, po biudžeto patikros) ───────

test("du SKIRTINGI ref'ai su tuo pačiu NEKIRPTU turiniu biudžeto nemoka dukart", () => {
  // `AG/openspec/changes/x` ir `AG/openspec/changes/x/proposal.md` išsisprendžia į TĄ PATĮ failą,
  // tad nekirptas turinys identiškas, o `ref` — ne. Su `ref` dedup rakte pora praeidavo kaip du
  // kandidatai.
  const selection = applySpecFragmentBudget(
    [
      fragment("AG/openspec/changes/x", "TURINYS", "TURINYS"),
      fragment("AG/openspec/changes/x/proposal.md", "TURINYS", "TURINYS"),
    ],
    10,
    1000,
  );

  assert.deepEqual(selection.kept.map((entry) => entry.ref), ["AG/openspec/changes/x"]);
  assert.deepEqual(
    selection.dropped,
    [{ ref: "AG/openspec/changes/x/proposal.md", reason: "duplicate" }],
    "tapatybė yra NEKIRPTAS TURINYS, o ne tai, kaip ref'as užrašytas",
  );
});

test("išsekęs biudžetas skirtingus ref'us numeta REALIA priežastimi, ne kaip 'duplicate' (144-b)", () => {
  // Fazė 1 prie nulinio/išsekusio biudžeto visus fragmentus apkerpa iki `""` (žr.
  // `retrieveSpecFragmentCandidates` su `maxCharsPerFragment` lygiu bendram biudžetui). Prieš
  // 144-b taisymą dedup rakte buvo `fragment.text`, tad VISI tušti fragmentai atrodydavo kaip
  // to paties turinio dublikatai, nors jų nekirptas `fullText` yra visiškai skirtingas.
  const selection = applySpecFragmentBudget(
    [
      fragment("a.md", "", "pilnas a.md turinys"),
      fragment("b.md", "", "pilnas b.md turinys"),
      fragment("c.md", "", "pilnas c.md turinys"),
    ],
    10,
    0,
  );

  assert.deepEqual(selection.kept, []);
  assert.deepEqual(
    selection.dropped,
    [
      { ref: "a.md", reason: "char_budget" },
      { ref: "b.md", reason: "char_budget" },
      { ref: "c.md", reason: "char_budget" },
    ],
    "nulinis biudžetas apkirpo VISUS fazėje 1 — tapatybė (fullText) skirtinga, tad nė vienas nėra 'duplicate'",
  );
});

test("dublikato numetimas tinka TIK kai pirmasis egzempliorius PATEKO į kept (144-b)", () => {
  // Pirmasis „x" egzempliorius pats krenta dėl `fragment_limit` (nespėja į vieno fragmento
  // limitą), tad antrasis, identiško turinio, egzempliorius NĖRA „duplicate" — jis turi TIKRĄJĄ
  // priežastį (tą pačią, dėl kurios krito ir pirmasis), nes „nieko neprarasta" būtų melas: pirmas
  // irgi neteko vietos pack'e.
  const selection = applySpecFragmentBudget(
    [
      fragment("stumdantis.md", "stumdo x lauk", "stumdantis turinys"),
      fragment("x-pirmas.md", "TURINYS", "TURINYS"),
      fragment("x-antras.md", "TURINYS", "TURINYS"),
    ],
    1,
    1000,
  );

  assert.deepEqual(selection.kept.map((entry) => entry.ref), ["stumdantis.md"]);
  assert.deepEqual(
    selection.dropped,
    [
      { ref: "x-pirmas.md", reason: "fragment_limit" },
      { ref: "x-antras.md", reason: "fragment_limit" },
    ],
    "antrasis 'x' negali būti 'duplicate', nes pirmasis pats niekada nepateko į kept",
  );
});

test("tuščias pjūvis NĖRA fragmentas", () => {
  // Likutis mažesnis už pirmą pastraipos ribą → `clipToBoundary` grąžina "". Toks įrašas anksčiau
  // keliaudavo į pack'ą kaip įrodymas be turinio, o `usedChars` nepajudėdavo.
  assert.equal(clipToBoundary("\nabc", 1), "", "kontrolė: pjūvis tikrai gali būti tuščias");

  const selection = applySpecFragmentBudget([fragment("spec.md", "\nabc")], 10, 1);
  assert.deepEqual(selection.kept, [], "tuščias fragmentas į pack'ą nepatenka");
  assert.deepEqual(selection.dropped, [{ ref: "spec.md", reason: "char_budget" }], "ir praradimas įvardijamas");
});

test("tuščios `## Spec source` eilutės nevalgo kandidatų limito", async () => {
  const fs = {
    statKind: () => Promise.resolve("file" as const),
    readTextFile: () => Promise.resolve("turinys"),
  } as unknown as CodeIntelligenceFileSystemPort;

  // Tarpais išskirstytas blokas: tuščių eilučių DAUGIAU nei lubos, bet tikrų ref'ų — vienas.
  const refs = [...Array<string>(MAX_SPEC_CANDIDATES + 5).fill(""), "spec.md"];
  const candidates = await retrieveSpecFragmentCandidates(fs, "/repo", refs, 1000);

  assert.deepEqual(candidates.unresolved, [], "tuščia eilutė jokio IO nekainuoja — vietos ji irgi neužima");
  assert.deepEqual(candidates.fragments.map((entry) => entry.ref), ["spec.md"]);
});

test("tas pats neegzistuojantis ref du kartus duoda VIENĄ 'not found' eilutę (144-b)", async () => {
  let readAttempts = 0;
  let statAttempts = 0;
  const fs = {
    statKind: () => {
      statAttempts += 1;
      return Promise.resolve("absent" as const);
    },
    readTextFile: () => {
      readAttempts += 1;
      return Promise.reject(new Error("neturėjo būti kviečiama"));
    },
  } as unknown as CodeIntelligenceFileSystemPort;

  const candidates = await retrieveSpecFragmentCandidates(
    fs,
    "/repo",
    ["nera.md", "nera.md", "  nera.md  "],
    1000,
  );

  assert.deepEqual(
    candidates.unresolved,
    [{ ref: "nera.md", reason: "not_found" }],
    "identiškas (po trim) ref'as antrą kartą praleidžiamas VISIŠKAI, o ne dar kartą deklaruojamas",
  );
  assert.equal(statAttempts, 1, "antras pasikartojimas nekainuoja net vieno statKind kvietimo");
  assert.equal(readAttempts, 0);
});

// ─── P1 + P2: įspėjimų svarba ir vėlyvieji praradimai ───────────────────────────────────────

test("lubos taikomos SVARBOS tvarka, ne surašymo", () => {
  // Dešimt antraščių nepataikymų (fragmentas pack'e YRA) plius vienas ribų pažeidimas.
  const warnings = [
    ...Array.from({ length: 10 }, (_, index) => ({ severity: 5, text: `heading miss ${index}` })),
    { severity: 0, text: "spec source rejected: ../../etc/passwd (path escapes the project root)" },
  ];

  const capped = capSpecRetrievalWarnings(warnings);
  assert.equal(capped[0], "spec source rejected: ../../etc/passwd (path escapes the project root)");
  assert.ok(
    capped.some((line) => line.includes("warnings truncated: 1 more")),
    "nukirsta eilutė sako, kiek liko neįvardyta",
  );
  assert.ok(
    !capped.some((line) => line.includes("heading miss 9")),
    "išstumiamas mažiausiai svarbus, o ne paskutinis surašytas",
  );
});

test("įspėjimai tos pačios svarbos išlaiko surašymo tvarką", () => {
  const capped = capSpecRetrievalWarnings([
    { severity: 3, text: "a" },
    { severity: 3, text: "b" },
    { severity: 3, text: "c" },
  ]);
  assert.deepEqual(capped, ["a", "b", "c"], "rūšiavimas privalo būti STABILUS — pack'as yra deterministinis");
});

test("atrankos stadijoje numesti spec ref'ai įvardijami VARDAIS", () => {
  const warning = specSelectionDropWarning(["spec.md#API", "design.md"]);
  assert.ok(warning, "praradimas privalo turėti įspėjimą");
  assert.match(warning.text, /spec\.md#API, design\.md/, "įspėjimas įvardija REF'US, ne tik skaičių");
  assert.equal(warning.severity, 3, "prarastas turinys yra svarbesnis už antraštės nepataikymą");
  assert.ok(
    capSpecRetrievalWarnings([{ severity: 5, text: "heading miss" }, warning])[0]?.startsWith("spec fragments dropped"),
    "ir tvarkoje jis stovi prieš nepataikymą",
  );
  assert.equal(specSelectionDropWarning([]), undefined, "nieko neprarasta — įspėjimo nėra");
});

// Įspėjimas yra VIENA eilutė su apribotu vardų sąrašu, ir tai load-bearing: jis guli pačiame
// pack'e, tad neapribotas jis atimtų biudžetą iš fragmentų, kuriuos aprašo. Su eilute kiekvienam
// ref'ui perrinkimo ciklas ėmė mesti daugiau, kad tilptų diagnostika, ir `budget-shrink`
// charakterizacija prarado VISUS fragmentus.
test("praradimo įspėjimas turi PASTOVIAS lubas", () => {
  const many = Array.from({ length: 40 }, (_, index) => `doc/file-${index}.md#section`);
  const warning = specSelectionDropWarning(many);
  assert.ok(warning);
  assert.match(warning.text, /\+35 more\)$/, "įvardijami penki, likusieji suskaičiuojami");
  assert.ok(warning.text.length < 250, `įspėjimo ilgis privalo būti apribotas: ${warning.text.length}`);
});

// ─── P2/P3: architektūros mazgai ───────────────────────────────────────────────────────────

async function codeContextWorld(graphJson: string | undefined): Promise<CodeContextCandidates> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vq-arch-match-"));
  try {
    await mkdir(path.join(root, "src", "build"), { recursive: true });
    await writeFile(path.join(root, "src", "build", "pipeline.ts"), "export const pipeline = 1;\n", "utf8");
    await buildCodeIndex(nodeFsTestPort, root);
    if (graphJson !== undefined) {
      await mkdir(path.join(root, "vq", "state", "architecture"), { recursive: true });
      await writeFile(path.join(root, "vq", "state", "architecture", "graph.json"), graphJson, "utf8");
    }
    return await gatherCodeContextCandidates(
      nodeFsTestPort,
      nodeContextPackFsPort,
      root,
      ["src/build/pipeline.ts"],
      DEFAULT_CONTEXT_SELECTION_LIMITS,
      { maxContractSymbols: 0, readSourceSlices: false },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("architektūros mazgai atitinka SEGMENTUS, ne plikus substring'us", async () => {
  const candidates = await codeContextWorld(
    JSON.stringify({
      nodes: [
        // `ui` ir `db` yra tikri mazgų vardai, kurie plikame substring'e atitiktų `src/build/…`
        // (`b`+`ui`+`ld`) ir bet kurį kelią su `db`. Jie varžosi dėl to paties konteksto biudžeto
        // kaip spec fragmentai, tad triukšmas juos IŠSTUMIA.
        { id: "ui", label: "UI sluoksnis" },
        { id: "db", label: "DB sluoksnis" },
        { id: "build", label: "Build pipeline" },
        { id: "pipeline", label: "" },
      ],
    }),
  );

  assert.deepEqual(
    candidates.architectureNodes.sort(),
    ["Build pipeline", "pipeline"],
    "atitinka tik tie, kurių žymuo yra VISAS kelio žetonas",
  );
});

test("sugadintas architektūros grafas NEBEDINGSTA tyliai", async () => {
  const candidates = await codeContextWorld("{ this is not json");
  assert.deepEqual(candidates.architectureNodes, []);
  assert.ok(
    candidates.notes.some((note) => note.startsWith("architecture graph unreadable")),
    `degradacija privalo būti matoma: ${candidates.notes.join(" | ")}`,
  );
});

test("grafo NEBUVIMAS nėra degradacija", async () => {
  const candidates = await codeContextWorld(undefined);
  assert.deepEqual(candidates.architectureNodes, []);
  assert.ok(
    !candidates.notes.some((note) => note.includes("architecture graph")),
    "projektas be grafo neturi gauti klaidos pastabos",
  );
});

// ─── P2: kešo raktas ───────────────────────────────────────────────────────────────────────

test("gate: pack'ą formuojanti konstanta PRIVALO būti semantikos deskriptoriuje", () => {
  // 2026-08-23 audite 3 įvestas `IMPACTED_TEST_IMPORTER_DEPTH` keičia, kiek testų patenka į
  // `impacted_tests` ir per juos į `related_files` — bet į deskriptorių nepateko. Deskriptoriaus
  // visa prasmė ta, kad tokios konstantos į raktą patektų BE atskiro prisiminimo.
  assert.ok(
    PACK_SEMANTICS_DESCRIPTOR.includes(`impacted_test_importer_depth:${IMPACTED_TEST_IMPORTER_DEPTH}`),
    `deskriptoriuje trūksta importuotojų gylio: ${PACK_SEMANTICS_DESCRIPTOR}`,
  );
});
