// Task 029 — worker prompt'as task'ą neša VIENĄ kartą.
//
// Iki šito dispatch'as siųsdavo pilną task kūną PLIUS execution kontekstą, kuris iš to paties
// task failo perrenderindavo goal, acceptance criteria, allowed paths, checks ir out-of-scope.
// Kompresija to negalėjo atsipirkti kūno lygyje: sutaupymas gyveno dubliavime, ne task'o teksto
// formoje. Testai fiksuoja tris dalykus atskirai — kad artefaktas diske NEsikeičia, kad prompt'e
// antros kopijos nebelieka, ir kad dedup neįvyksta, kai jo negalima ĮRODYTI.

import assert from "node:assert/strict";
import test from "node:test";
import { contextPackSchema, TRUST_BOUNDARY_RULE } from "../application/context-pack/context-pack-schema.js";
import { renderExecutionContext } from "../application/context-pack/render-execution-context.js";
import { buildExecutionContextMarker } from "../application/context-pack/execution-context-fingerprint.js";
import {
  buildWorkerPrompt,
  resolveCanonicalWorkerPrompt,
  WORKER_PROMPT_CONTEXT_HEADING,
} from "../application/task-execution/execution-context-gate.js";

// Task-derived blokai — būtent tie penki, kurių kūnas yra to paties task failo lauko atspindys.
const TASK_DERIVED_HEADINGS = ["## Goal", "## Acceptance criteria", "## Allowed paths", "## Checks", "## Out of scope"];

// Realaus 029 task'o forma: kūnas, kurį prompt'as neša pilną, ir pack'as, surinktas iš jo.
const TASK_TEXT = [
  "# Task",
  "",
  "## Tikslas",
  "Worker prompt'as task'ą turi nešti VIENĄ kartą. Dabar `buildWorkerPrompt` sujungia pilną",
  "task kūną su execution context'u, kuris iš pack'o iš naujo renderina tų pačių task laukų kopijas.",
  "",
  "## Failai",
  "Leidžiama:",
  "- `src/application/task-execution/execution-context-gate.ts`",
  "- `src/application/context-pack/render-execution-context.ts`",
  "- `src/application/context-pack/render-candidates.ts`",
  "- `src/tests/**`",
  "",
  "## Patikra",
  "- `pnpm typecheck`",
  "- `pnpm test`",
  "",
  "## Neįtraukta",
  "- IR vidinio dubliavimo taisymas (task 030).",
  "- Preambulės mažinimas (task 031).",
].join("\n");

function realisticPack() {
  return contextPackSchema.parse({
    task_id: "029-prompt-nesa-taska-viena-karta",
    phase: "implementation",
    goal: "Worker prompt'as task'ą turi nešti VIENĄ kartą; konteksto kopijos nukrenta prompt'o surinkimo metu.",
    acceptance_criteria: [
      "Prompt'e nebelieka task-derived blokų, kai kūnas jau neša tą patį tekstą.",
      "`execution-context.md` diske lieka pilnas ir baitas į baitą nepakitęs.",
      "Vartų fingerprint'as ir toliau skaičiuojamas nuo RAW task teksto baitų.",
    ],
    stop_condition: "Commit'ink, kai patikros žalios; dizaino klausimą dėl fingerprint semantikos grąžink operatoriui.",
    allowed_paths: [
      "src/application/task-execution/execution-context-gate.ts",
      "src/application/context-pack/render-execution-context.ts",
      "src/application/context-pack/render-candidates.ts",
      "src/tests/**",
    ],
    checks: ["pnpm typecheck", "pnpm test"],
    out_of_scope: ["IR vidinio dubliavimo taisymas (task 030).", "Preambulės mažinimas (task 031)."],
    spec_fragments: ["AG/openspec/changes/029/spec.md\nSpec turinys, kurio task kūne NĖRA — jis privalo likti."],
    architecture_rules: ["code_context is advisory only; allowed_paths remains the hard edit boundary"],
    code_context: {
      enabled: true,
      summary: ["target: src/application/context-pack/render-candidates.ts", "symbols: buildCandidates:38-270"],
      related_files: ["src/application/context-pack/assemble/persist.ts"],
      impacted_tests: ["src/tests/context-pack.test.ts"],
    },
  });
}

function attachInput(contextPackText: string | undefined, executionContext: string) {
  return {
    mode: "preferred" as const,
    sourceChange: true,
    taskId: "029-prompt-nesa-taska-viena-karta",
    taskText: TASK_TEXT,
    executionContext,
    staleSourceSlices: [] as readonly string[],
    ...(contextPackText === undefined ? {} : { contextPackText }),
  };
}

// Artefaktas, kurį PERSIST parašytų diske: markeris + numatytasis (pilnas) renderis.
function artifactFor(pack: ReturnType<typeof realisticPack>, contextPackText: string): string {
  const marker = buildExecutionContextMarker({
    taskId: pack.task_id,
    taskText: TASK_TEXT,
    contextPackText,
  });
  return `${marker}\n${renderExecutionContext(pack).markdown}`;
}

test("029: artefaktas diske lieka PILNAS — dedup yra tik prompt'o vaizdas", () => {
  const pack = realisticPack();
  const artifact = renderExecutionContext(pack).markdown;

  for (const heading of TASK_DERIVED_HEADINGS) {
    assert.ok(artifact.includes(heading), `savarankiškai skaitomas artefaktas privalo turėti ${heading}`);
  }
  // Numatytasis kelias nežino apie dedup: nei antraštės eilutės, nei kito elementų rinkinio.
  assert.ok(!artifact.includes("- task_derived:"), "numatytame renderyje dedup eilutės nėra");
  assert.equal(
    artifact,
    renderExecutionContext(pack, { excludeTaskDerived: false }).markdown,
    "`excludeTaskDerived: false` yra tas pats numatytasis kelias",
  );

  // Regresijos inkaras: `taskDerived` yra RENDERIO žyma ir NEturi patekti į elementų tapatybę.
  // Jei kada nors pateks, fingerprint'as pasikeis ir šis skaičius kris — būtent to ir norime.
  assert.equal(renderExecutionContext(pack).context.fingerprint, "11a044b3324d6501");
});

test("029: `excludeTaskDerived` nuima penkis blokus ir palieka įrodymus", () => {
  const pack = realisticPack();
  const deduped = renderExecutionContext(pack, { excludeTaskDerived: true }).markdown;

  for (const heading of TASK_DERIVED_HEADINGS) {
    assert.ok(!deduped.includes(heading), `${heading} yra task kūne, tad kontekste jo nebelieka`);
  }
  assert.ok(deduped.includes("## Spec fragment:"), "spec fragmentas NĖRA task-derived — lieka");
  assert.ok(deduped.includes("Spec turinys, kurio task kūne NĖRA"));
  assert.ok(deduped.includes("## Symbols"), "code context lieka");
  assert.ok(deduped.includes("## Architecture boundaries"), "architektūros blokas lieka");
  assert.ok(deduped.includes("## Impacted tests"), "impacted tests lieka");

  // Aptvaro taisyklė yra NEIŠMETAMA ir dedup vaizde.
  assert.ok(deduped.includes(TRUST_BOUNDARY_RULE.split("\n")[0] ?? ""), "ribos taisyklė lieka");

  // Praleidimas skelbiamas, o ne daromas tyliai: kitaip vaizdas atrodytų kaip artefaktas,
  // kuriam nepavyko surinkti goal/checks.
  assert.match(deduped, /- task_derived: 5 element\(s\) omitted/);
  assert.match(deduped, /not the `execution-context\.md` audit artifact/);

  assert.ok(deduped.length < renderExecutionContext(pack).markdown.length, "dedup vaizdas trumpesnis");
});

test("029: prompt'as neša task'ą vieną kartą ir yra trumpesnis už pre-dedup prompt'ą", () => {
  const pack = realisticPack();
  const contextPackText = JSON.stringify(pack);
  const artifact = artifactFor(pack, contextPackText);

  const canonical = resolveCanonicalWorkerPrompt(attachInput(contextPackText, artifact));
  assert.equal(canonical.kind, "prompt");
  if (canonical.kind !== "prompt") {
    return;
  }
  assert.equal(canonical.gate.kind, "attach", "vartų sprendimas nesikeičia — dedup vyksta po jų");

  const context = canonical.prompt.slice(canonical.prompt.indexOf(WORKER_PROMPT_CONTEXT_HEADING));
  for (const heading of TASK_DERIVED_HEADINGS) {
    assert.ok(!context.includes(heading), `${heading} prompt'o kontekste yra ANTRA kopija — jos nebeturi būti`);
  }
  // ...bet tas pats turinys prompt'e VIS TIEK yra — jį neša pats task kūnas.
  assert.ok(canonical.prompt.startsWith("# Task"));
  assert.ok(canonical.prompt.includes("- `pnpm typecheck`"), "checks ateina iš task kūno");
  assert.ok(canonical.prompt.includes("- IR vidinio dubliavimo taisymas (task 030)."), "out-of-scope iš task kūno");
  assert.ok(context.includes("## Spec fragment:"), "spec įrodymas lieka kontekste");

  // Aptvaro taisyklė lieka ABIEJOSE vietose: prompt'o siūlėje ir konteksto antraštėje.
  const firstRuleLine = TRUST_BOUNDARY_RULE.split("\n")[0] ?? "";
  assert.equal(canonical.prompt.split(firstRuleLine).length - 1, 2, "taisyklė lieka ir siūlėje, ir dokumente");

  // Markeris — prompt'o audito nuoroda į task_sha256/context_pack_sha256 — išsaugomas.
  assert.ok(canonical.prompt.includes("<!-- ag:execution-context task_id="), "markeris nenukerpamas");

  // MATAVIMAS (`sent_prompt_chars` naudos pusė): pre-dedup prompt'as yra tas pats task kūnas
  // su NEPAKEISTU artefaktu.
  const before = buildWorkerPrompt({ taskText: TASK_TEXT, executionContext: artifact.trim() });
  assert.ok(
    canonical.prompt.length < before.length,
    `dedup privalo mažinti prompt'ą: ${canonical.prompt.length} vs ${before.length}`,
  );
});

test("029: be ĮRODYMO, kad pack'as atkuria artefaktą, dedup neįvyksta", () => {
  const pack = realisticPack();
  const contextPackText = JSON.stringify(pack);
  const artifact = artifactFor(pack, contextPackText);

  // 1. Pack'o nėra — prompt'as gauna NEPAKEISTĄ artefaktą. (Markeris be `context_pack_sha256`:
  //    su juo vartai pack'o nebuvimą atmeta dar prieš dedup žingsnį.)
  const packlessArtifact = artifact.replace(/ context_pack_sha256=[0-9a-f]+/, "");
  const noPack = resolveCanonicalWorkerPrompt(attachInput(undefined, packlessArtifact));
  assert.equal(noPack.kind, "prompt");
  if (noPack.kind === "prompt") {
    assert.ok(noPack.prompt.includes(packlessArtifact.trim()), "be pack'o kontekstas nepaliestas");
    for (const heading of TASK_DERIVED_HEADINGS) {
      assert.ok(noPack.prompt.includes(heading), `fallback kelyje ${heading} lieka`);
    }
  }

  // 2. Pack'as yra, bet neparsinamas pagal `contextPackSchema` — dedup nesiremia spėjimu.
  //    Markeris statomas nuo TO PATIES sugadinto teksto, kitaip varto fingerprint'as jį atmestų
  //    dar prieš dedup žingsnį.
  const brokenText = "{ne json";
  const brokenMarker = buildExecutionContextMarker({
    taskId: pack.task_id,
    taskText: TASK_TEXT,
    contextPackText: brokenText,
  });
  const brokenPack = resolveCanonicalWorkerPrompt(
    attachInput(brokenText, `${brokenMarker}\n${renderExecutionContext(pack).markdown}`),
  );
  assert.equal(brokenPack.kind, "prompt");
  if (brokenPack.kind === "prompt") {
    for (const heading of TASK_DERIVED_HEADINGS) {
      assert.ok(brokenPack.prompt.includes(heading), `neparsinamo pack'o kelyje ${heading} lieka`);
    }
  }

  // 3. Pack'as yra, bet artefaktas NĖRA jo renderis (pvz. kitaip surinktas ar redaguotas).
  //    Vartai jį patvirtino, tad prompt'as privalo atiduoti tai, ką jie patvirtino.
  const handEdited = `${artifact.trim()}\n\n## Ranka pridėta sekcija\n\nTurinys.`;
  const mismatched = resolveCanonicalWorkerPrompt(attachInput(contextPackText, handEdited));
  assert.equal(mismatched.kind, "prompt");
  if (mismatched.kind === "prompt") {
    assert.ok(mismatched.prompt.includes("## Ranka pridėta sekcija"));
    for (const heading of TASK_DERIVED_HEADINGS) {
      assert.ok(mismatched.prompt.includes(heading), `nesutampant renderiui ${heading} lieka`);
    }
  }
});
