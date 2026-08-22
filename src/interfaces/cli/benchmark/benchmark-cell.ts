// `ag-loop` benchmark celės GRYNOJI dalis: scenarijaus promptas → užduoties failas, ir loop'o
// palikti usage įrašai → telemetrijos vokas.
//
// Kodėl atskiras modulis nuo `benchmark-drive`: ten gyvena VIENAS ribotas agento kvietimas
// (`agent-solo` celė), o čia — visas ciklas. Sudėjus juos į vieną failą, dydžio vartas kristų,
// bet svarbiau kita: tai DU skirtingi matavimai, ir jų kodas neturi persidengti labiau, nei
// persidengia patys režimai. Bet koks bendras „patogumas" tarp jų vėliau pasirodytų
// rezultatuose kaip loop'o efektas.
//
// ## Ką ši celė matuoja, ko nematavo ankstesnė
//
// Iki 2026-08-22 `ag-loop` režimą varė `benchmark-drive` — vienas headless `claude` kvietimas
// scenarijaus kopijoje. Jokio preflight, konteksto pako, kokybės vartų, diagnozės ar retry, t. y.
// nieko, kas loop'as ir yra. Tai matėsi iš to, kad TAS PATS vokas tenkino ir
// `verifyLoopTelemetry`, ir `verifySoloTelemetry`: vienas draiveris, du „skirtingi" režimai.
// Adapterio dokumentacija tuo metu teigė priešingai — „the scenario is handed to the full AG
// Loop … preflight, dispatch, quality gates, diagnosis, retries and human review (BENCH-3)".

import path from "node:path";

const NEWLINE = "\n";

/** Vienas scenarijaus deklaruotas patikros veiksmas: komanda ir ko iš jos tikimasi. */
export type CellCheck = {
  readonly command: readonly string[];
};

export type CellTaskInput = {
  /** Scenarijaus užduoties tekstas — BENCH-3 reikalauja, kad abu režimai gautų TĄ PATĮ. */
  readonly prompt: string;
  /** Scenarijaus `allowedPaths`. Tuščias sąrašas yra klaida, o ne „viskas leidžiama". */
  readonly allowedPaths: readonly string[];
  /** Scenarijaus `checks` komandos, kurias loop'o kokybės vartai realiai paleis. */
  readonly checks: readonly CellCheck[];
  /** Užduoties id (failo vardo kamienas), iš kurio loop'as veda ledger'io raktą. */
  readonly taskId: string;
};

/**
 * Scenarijaus užduotis VERQESTRA task formatu.
 *
 * Promptas įdedamas VERBATIM į `## Tikslas` ir niekur nekartojamas: bet koks perrašymas čia
 * reikštų, kad loop'o režimas gavo kitą užduotį nei solo, ir BENCH-3 „identiškas promptas"
 * nustotų galioti būtent toje vietoje, kur jis svarbiausias.
 *
 * `## Agentai` sąmoningai NEDEKLARUOJAMI: grandinę parenka pats preflight pagal užduoties
 * klasifikaciją, ir būtent tas pasirinkimas yra dalis to, ką loop'as prideda prie plikos agento
 * sesijos. Įrašius ją čia, matuotume savo pačių spėjimą.
 */
export function renderCellTask(input: CellTaskInput): string {
  if (input.allowedPaths.length === 0) {
    throw new RangeError("The scenario declared no allowed path, so no bounded task can be built.");
  }
  const checks = input.checks.map((check) => `- \`${check.command.join(" ")}\``);
  return [
    "# Task",
    "",
    "## Spec source",
    `${cellChangeDir(input.taskId)}/spec.md`,
    "",
    "## Tikslas",
    input.prompt.trim(),
    "",
    "## Failai",
    "Leidžiama:",
    ...input.allowedPaths.map((allowed) => `- \`${allowed}\``),
    "Draudžiama:",
    "- `.git/**`",
    "- `vq/**`",
    "",
    "## Veiksmas",
    "- Įgyvendinti `## Tikslas` aprašytą pakeitimą leidžiamuose keliuose.",
    "",
    "## Patikra",
    ...(checks.length > 0 ? checks : ["- `node --test`"]),
    "",
    "## Stop",
    "Sustoti, kai patikros praeina ir pakeitimai lieka leidžiamuose keliuose.",
    "",
  ].join("\n");
}

/**
 * Scenarijaus spec change'as kopijoje.
 *
 * Be jo `claude-preflight` kodo užduotį teisingai nukreipia į human-review: spec-first
 * orkestratorius, vykdantis kodo pakeitimą be spec konteksto, prieštarauja savo apibrėžimui
 * (SH-2). Vienas scenarijus = vienas change'as, ir jo turinys yra TAS PATS promptas — struktūra
 * pridedama, informacija ne. Priešingu atveju loop'o režimas gautų daugiau, nei gavo solo, ir
 * BENCH-3 „identiškas promptas" nustotų galioti.
 */
export function cellChangeDir(taskId: string): string {
  return `AG/openspec/changes/${taskId}`;
}

/** Change'o failai: raktas — kelias kopijos atžvilgiu, reikšmė — turinys. */
export function renderCellSpec(input: CellTaskInput): ReadonlyMap<string, string> {
  const dir = cellChangeDir(input.taskId);
  const prompt = input.prompt.trim();
  const scope = input.allowedPaths.map((allowed) => `- \`${allowed}\``).join(NEWLINE);
  return new Map([
    [
      `${dir}/proposal.md`,
      `# Proposal: ${input.taskId}

Benchmark scenarijus, vykdomas kaip viena eilės užduotis.

${prompt}
`,
    ],
    [
      `${dir}/spec.md`,
      `# Spec: ${input.taskId}

## Reikalavimas

${prompt}

## Apimtis

${scope}
`,
    ],
    [
      `${dir}/design.md`,
      `# Design: ${input.taskId}

Sprendimas paliekamas vykdytojui — tai ir yra matuojamas dalykas.
`,
    ],
    [`${dir}/tasks.md`, `# Tasks: ${input.taskId}

- [ ] ${prompt.split(NEWLINE)[0] ?? input.taskId}
`],
  ]);
}

/** Kur celės užduoties failas atsiduria scenarijaus kopijoje. */
export function cellTaskPath(workdir: string, taskId: string): string {
  return path.join(workdir, "AG", "tasks", "queue", `${taskId}.md`);
}

/**
 * Vieno usage įrašo laukai, kurių reikia celės sumai. Struktūrinis tipas: `infrastructure`
 * `TokenUsageRecord` jį tenkina, bet interfaces sluoksnis jo neimportuoja.
 */
export type CellUsageRecord = {
  readonly task_id?: string;
  readonly task_phase?: string;
  readonly attempt?: number;
  readonly usage_captured?: boolean;
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly cache_read_input_tokens?: number;
  readonly cache_creation_input_tokens?: number;
  readonly num_turns?: number;
};

export type CellTelemetry = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly llmCalls: number;
  readonly attempts: number;
  readonly repairs: number;
  readonly numTurns: number;
  /** `false`, kai bent vienas modelio kvietimas usage negrąžino — tada suma nėra pilna. */
  readonly captured: boolean;
};

function nonNegative(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * Loop'o palikti usage įrašai → celės telemetrija.
 *
 * `attempts` imamas kaip DIDŽIAUSIAS matytas bandymo numeris, ne kaip įrašų skaičius: vienas
 * bandymas gali turėti kelis modelio kvietimus (preflight, dispatch, diagnozė), ir suskaičiavus
 * juos kaip bandymus `repairs < attempts` invariantas liktų teisingas atsitiktinai.
 *
 * `repairs` — įrašai, kuriuos loop'as pats pažymėjo `task_phase: "repair"`. Tai jo paties
 * liudijimas, o ne mūsų išvedimas iš bandymų skaičiaus: bandymas gali pasikartoti ir dėl
 * infrastruktūros, o tai NĖRA remontas.
 *
 * `captured` yra `false`, jei bent vienas kvietimas usage negrąžino. Tada suma yra dalinė, ir
 * kvietėjas privalo tai pasakyti garsiai — trūkstami tokenai buvo išleisti, o jų praleidimas
 * sumažintų būtent tą režimą, kurio apskaita sugedo.
 */
export function summarizeCellTelemetry(records: readonly CellUsageRecord[], taskId: string): CellTelemetry {
  const mine = records.filter((record) => (record.task_id ?? "").trim() === taskId);
  let captured = true;
  let attempts = 0;
  let repairs = 0;
  const totals = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, turns: 0 };

  for (const record of mine) {
    if (record.usage_captured === false) captured = false;
    totals.input += nonNegative(record.input_tokens);
    totals.output += nonNegative(record.output_tokens);
    totals.cacheRead += nonNegative(record.cache_read_input_tokens);
    totals.cacheCreation += nonNegative(record.cache_creation_input_tokens);
    totals.turns += nonNegative(record.num_turns);
    attempts = Math.max(attempts, nonNegative(record.attempt));
    if ((record.task_phase ?? "") === "repair") repairs += 1;
  }

  return {
    inputTokens: totals.input,
    outputTokens: totals.output,
    cacheReadInputTokens: totals.cacheRead,
    cacheCreationInputTokens: totals.cacheCreation,
    llmCalls: mine.length,
    // Bent vienas bandymas įvyko, jei įvyko bent vienas kvietimas: loop'as, kuris nespėjo
    // įrašyti `attempt`, vis tiek dirbo, o `attempts: 0` su `llmCalls > 0` būtų prieštaravimas,
    // kurį adapteris teisingai atmestų kaip sugadintą telemetriją.
    attempts: Math.max(attempts, mine.length > 0 ? 1 : 0),
    repairs,
    numTurns: totals.turns,
    captured: captured && mine.length > 0,
  };
}
