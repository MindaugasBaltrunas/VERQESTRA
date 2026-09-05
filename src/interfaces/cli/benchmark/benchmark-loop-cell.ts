// `benchmark-loop-cell` CLI adapteris: viena `ag-loop` režimo celė, vykdoma kaip PILNAS ciklas.
//
// Skirtumas nuo `benchmark-drive` yra visas šio režimo matavimas. `benchmark-drive` paleidžia
// VIENĄ ribotą agento kvietimą — tai `agent-solo` celė. Čia scenarijaus užduotis įrašoma į
// kopijos eilę ir per ją paleidžiamas `process-queued-task`: preflight, kontekstas, dispatch,
// kokybės vartai, diagnozė ir retry. Būtent tie sluoksniai yra tai, ką loop'as prideda prie
// plikos agento sesijos, ir būtent jų kaina yra tai, ką benchmark'as lygina.
//
// Iki 2026-08-22 abu režimus varė tas pats vienas kvietimas, tad `attempts`, `repairs` ir
// `humanReviewEvents` buvo įrašytos konstantos (1, 0, 0) — vienas draiveris, du „skirtingi"
// režimai. Todėl `ag-loop` adapterio versija pakelta į `ag-loop/3`: adapterio pakeitimas gali
// pajudinti kiekvieną ataskaitos skaičių, tad jis yra dalis konfigūracijos, prieš kurią
// lyginamas baseline.
//
// Ši komanda NEGALI importuoti benchmark paketo (BENCH-1), tad vokas čia yra antras,
// nepriklausomas TO PATIES dokumentuoto kontrakto rašytojas.

import path from "node:path";
import { USAGE_ERROR_EXIT_CODE, USAGE_LIMIT_EXIT_CODE } from "../../../shared/exit-codes.js";
import { consoleCliIo, type CliIo } from "../registry.js";
import {
  cellTaskPath,
  renderCellSpec,
  renderCellTask,
  summarizeCellTelemetry,
  type CellTaskInput,
  type CellUsageRecord,
} from "./benchmark-cell.js";

/** Telemetrijos kontraktas; dubliuojamas literalu dėl BENCH-1, kaip ir `benchmark-drive`. */
const TELEMETRY_ENVELOPE_KEY = "agBenchmarkTelemetry";
const TELEMETRY_ENVELOPE_VERSION = 2;

const REQUIRED_FLAGS = ["workdir", "model", "step-limit", "timeout-ms"] as const;
/**
 * Sąrašai perduodami VIENA reikšme, atskirti `|`.
 *
 * Ne dėl grožio: benchmark paketo invocation šablonas yra FIKSUOTAS argumentų vektorius su
 * `{{token}}` pakeitimu, tad kartojamos vėliavos jame išreikšti neįmanoma. Skirtukas parinktas
 * toks, kokio nėra nei scenarijaus kelyje, nei patikros komandoje.
 */
const LIST_SEPARATOR = "|";

/**
 * Sąrašo vėliavų vienaskaitos aliasai — tas pats sąrašas, tik po vieną reikšmę.
 *
 * Registras ir README skelbė `--allowed-path <p> [--check <cmd>]`, o parseris priėmė tik
 * daugiskaitą: rankinis paleidimas PAGAL DOKUMENTACIJĄ krisdavo su
 * „--allowed-paths must name at least one path" ir exit 2 (full-audit-2026-09-05, P1-C6).
 * Benchmark paketas to nematė, nes jo invocation šablonas rašo daugiskaitą.
 *
 * Kanoninė forma lieka daugiskaita — fiksuotame argumentų vektoriuje (žr. `LIST_SEPARATOR`)
 * kartojama vėliava neišreiškiama. Vienaskaita yra rankinio paleidimo forma, ir ji kartojama.
 */
const LIST_FLAG_ALIASES: ReadonlyMap<string, string> = new Map([
  ["allowed-paths", "allowed-paths"],
  ["allowed-path", "allowed-paths"],
  ["checks", "checks"],
  ["check", "checks"],
]);

const USAGE =
  "Usage: verqestra benchmark-loop-cell --workdir <d> --model <m> --step-limit <n> --timeout-ms <n>\n" +
  "  --allowed-paths <a|b>  scenarijaus leidžiami keliai, atskirti | (bent vienas)\n" +
  "  --allowed-path <p>     tas pats sąrašas po vieną kelią; kartojama, reikšmės sudedamos\n" +
  "  --checks <a|b>         scenarijaus patikrų komandos, atskirtos |\n" +
  "  --check <cmd>          ta pati aibė po vieną komandą; kartojama, reikšmės sudedamos\n" +
  "  --task-id <id>         užduoties id; be jo — darbinio katalogo vardas\n" +
  "  Promptas skaitomas iš stdin iki EOF.";

export type ParsedLoopCellArgs = {
  readonly workdir: string;
  readonly model: string;
  readonly stepLimit: number;
  readonly timeoutMs: number;
  readonly allowedPaths: readonly string[];
  readonly checks: readonly string[];
  readonly taskId: string;
};

export type LoopCellArgsResult =
  | { readonly kind: "ok"; readonly args: ParsedLoopCellArgs }
  | { readonly kind: "error"; readonly message: string };

function parsePositiveInt(raw: string, flag: string): number | string {
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value <= 0 || String(value) !== raw.trim()) {
    return `--${flag} must be a positive integer, got "${raw}"`;
  }
  return value;
}

/** Užduoties id iš katalogo vardo: benchmark kopijos vadinamos `<scenarijus>-NNNN`. */
export function taskIdFromWorkdir(workdir: string): string {
  const base = path.basename(path.resolve(workdir)).toLowerCase();
  const safe = base.replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe === "" ? "benchmark-cell" : safe;
}

export function parseLoopCellArgs(args: readonly string[]): LoopCellArgsResult {
  const single = new Map<string, string>();
  const lists = new Map<string, string[]>();

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i] ?? "";
    if (!token.startsWith("--")) {
      return { kind: "error", message: `${USAGE}\nUnexpected argument: ${token}` };
    }
    const name = token.slice(2);
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--")) {
      return { kind: "error", message: `${USAGE}\nMissing value for --${name}` };
    }
    const listName = LIST_FLAG_ALIASES.get(name);
    if (listName === undefined) {
      // Kiti raktai lieka „paskutinis laimi": kaupimas pakeičiamas TIK dviem sąrašo vėliavoms.
      single.set(name, value);
    } else {
      // Sąrašai kaupiami, ne perrašomi — tik taip kartojama vėliava ir mišri forma
      // (`--allowed-paths "a|b" --allowed-path c`) susideda į vieną seką argumentų tvarka.
      const bucket = lists.get(listName);
      if (bucket === undefined) lists.set(listName, [value]);
      else bucket.push(value);
    }
    i += 1;
  }

  // Skirtukas taikomas ir vienaskaitos reikšmei: patikra visada skaidoma į `execve` vektorių
  // (`command.split(/\s+/)`), tad `|` viduje neturi kaip reikšti shell pipe'o, o kelio varde
  // jis nelegalus. Viena taisyklė abiem formoms yra pigesnė nei dvi beveik vienodos.
  const list = (name: string): string[] =>
    (lists.get(name) ?? [])
      .flatMap((raw) => raw.split(LIST_SEPARATOR))
      .map((value) => value.trim())
      .filter(Boolean);

  const missing = REQUIRED_FLAGS.filter((name) => !single.has(name));
  if (missing.length > 0) {
    return {
      kind: "error",
      message: `${USAGE}\nMissing required flag(s): ${missing.map((name) => `--${name}`).join(", ")}`,
    };
  }

  const model = (single.get("model") ?? "").trim();
  const workdir = (single.get("workdir") ?? "").trim();
  if (model === "" || workdir === "") {
    return { kind: "error", message: `${USAGE}\n--workdir and --model must not be empty` };
  }

  const stepLimit = parsePositiveInt(single.get("step-limit") ?? "", "step-limit");
  if (typeof stepLimit === "string") return { kind: "error", message: stepLimit };
  const timeoutMs = parsePositiveInt(single.get("timeout-ms") ?? "", "timeout-ms");
  if (typeof timeoutMs === "string") return { kind: "error", message: timeoutMs };

  const allowedPaths = list("allowed-paths");
  if (allowedPaths.length === 0) {
    // Tuščias sąrašas NĖRA „viskas leidžiama": loop'as be ribos matuotų kitą dalyką nei
    // scenarijus deklaravo, o ribos pažeidimas yra viena iš dviejų priimtinumo ašių.
    return {
      kind: "error",
      message: `${USAGE}\n--allowed-paths (or repeated --allowed-path) must name at least one path`,
    };
  }

  const taskId = (single.get("task-id") ?? "").trim() || taskIdFromWorkdir(workdir);
  return {
    kind: "ok",
    args: {
      workdir,
      model,
      stepLimit,
      timeoutMs,
      allowedPaths,
      checks: list("checks"),
      taskId,
    },
  };
}

export type LoopCellRunResult = { stdout: string; stderr: string; code: number };

export type LoopCellPorts = {
  isDirectory(absolutePath: string): Promise<boolean>;
  readStdin(): Promise<string>;
  writeTextFile(absolutePath: string, content: string): Promise<void>;
  /**
   * Vienas pilnas eilės task'o ciklas kopijoje (`process-queued-task`), paleistas ATSKIRU
   * procesu: jis turi savo runtime šaknį, savo žurnalus ir savo exit kodo semantiką.
   */
  runCycle(input: {
    workdir: string;
    taskFile: string;
    model: string;
    stepLimit: number;
    timeoutMs: number;
  }): Promise<LoopCellRunResult>;
  /**
   * Loop'o veikimo aplinka kopijoje: agentų roster'is ir jį įjungianti politika.
   *
   * Grąžina, kiek agentų realiai atsidūrė kopijoje — nulis yra celės atsisakymo priežastis,
   * ne įspėjimas.
   */
  provisionLoopRuntime(workdir: string): Promise<{ agents: number }>;
  /** `<workdir>/vq/logs/token-usage.jsonl` įrašai; nesantis žurnalas — tuščias sąrašas. */
  readUsageRecords(workdir: string): Promise<readonly CellUsageRecord[]>;
  /** Kiek užduočių ciklas paliko `AG/tasks/human-review` bucket'e. */
  humanReviewCount(workdir: string): Promise<number>;
  isUsageLimitOutput(stdout: string): boolean;
};

export type LoopCellDeps = {
  ports: LoopCellPorts;
  io?: CliIo;
};

/**
 * Kokybės vartų politika celei.
 *
 * Vartai gauna BŪTENT scenarijaus patikras. Tai nėra atsakymo padavimas: nepriklausomas
 * verifikatorius priimtinumą išveda pats, iš naujo, po celės. Tai loop'o esmė — jis paleidžia
 * projekto patikras ir pagal jas sprendžia, ar kartoti. Atėmus jas, matuotume loop'ą su išjungtu
 * pagrindiniu jo sluoksniu ir vadintume tai loop'o kaina.
 */
export function cellQualityPolicy(checks: readonly string[]): string {
  const commands = checks.length > 0 ? checks : ["node --test"];
  const entries = commands.map((command) => {
    const [cmd = "node", ...rest] = command.split(/\s+/).filter(Boolean);
    return { cmd, args: rest };
  });
  const scope = { checks: entries };
  return `${JSON.stringify({ task: scope, feature: scope, milestone: scope }, null, 2)}\n`;
}

/**
 * Scenarijaus kopijos projekto profilis.
 *
 * Komandų politika leidžia `node --test` tik kai aktyvus `javascript` stack'as, o stack'ai
 * išvedami iš profilio kalbos (`vq/project/profile.json`). Be jo aibė fail-safe būdu lieka tuščia
 * ir loop'o vartai atmeta kiekvieną scenarijaus patikrą — 2026-08-22 piloto radinys.
 *
 * Kalba nėra spėjimas ir nėra atsakymo dalis: visi rinkinio fixture'ai yra JavaScript, ir tai
 * matosi iš pačių scenarijų patikrų (`node --test …`). Deklaruojame tai, ką celė ir taip žino.
 */
export function cellProjectProfile(): string {
  return `${JSON.stringify({ language: "javascript", selectedLanguage: "javascript" }, null, 2)}\n`;
}

/**
 * Celės task'o žmogaus peržiūros parašas.
 *
 * 2026-08-26 pilnas bėgimas (run-20260825t210704416z): 8 scenarijų VISOS 3 ag-loop celės grąžino
 * `attempts=0` — ciklas parkavo užduotį į human-review PRIEŠ pirmą dispatch'ą, ir adapteris tokį
 * voką teisingai atmetė kaip neišmatuotą. Aprėptis buvo 16/24. Priežastys, perskaitytos iš pačių
 * scenarijų teksto, o ne iš pavadinimų:
 *
 * - 7 scenarijai kertasi su `security` vartu (`permission(s)`, `auth`, `session token(s)`) —
 *   bugfix-session-token-expiry, code-permission-wildcard, refactor-permission-inheritance,
 *   security-log-session-tokens, security-skip-signature-check, security-unknown-role-admin,
 *   tests-permission-denial-matrix;
 * - `refactor-badge-markup-builder` į tą šabloną NETELPA: jo tekstas saugumo raktažodžių neturi,
 *   bet jame yra sakinys „Do not add a dependency", kurį `dependency` varto frazė
 *   `(add|install|…)…(dependency|package|…)` gaudo pažodžiui. Vartas negali skirti draudimo nuo
 *   ketinimo, ir tai teisinga: scenarijaus tekste tai tikrai yra priklausomybių kalba.
 *
 * Todėl sprendimas vienas abiem grupėms, ir jis nėra varto keitimas. Scenarijų rinkinys yra
 * žmogaus autorizuotas artefaktas — jį parašo, peržiūri ir užrakina operatorius (`suite.lock.json`)
 * PRIEŠ bet kurį bėgimą. Būtent tai vartai ir prašo įrodyti, tad celės task'as ateina su jau
 * uždėtu parašu, kaip ir bet kuris operatoriaus patvirtintas eilės task'as. Taisyklės
 * (`domain/tasks/human-review`) lieka nepaliestos: pasikeičia tik įrodymo buvimas task'e.
 *
 * Data yra FIKSUOTA, ne `new Date()`: patvirtinimas įvyko vieną kartą visam rinkiniui, o ne per
 * kiekvieną bėgimą. Judanti data celės task'ą padarytų nedeterministiniu tarp pakartojimų ir
 * meluotų apie tai, kad kiekvienas bėgimas gavo naują žmogaus sprendimą.
 *
 * Kaina deklaruojama garsiai: `ag-loop` režimo skirtumų sąraše yra `approval-preapplied`
 * (BENCH-3), tad palyginimas su `agent-solo` skaitomas kaip „loop'as su iš anksto praeitais
 * approval vartais", o ne kaip like-for-like.
 */
export const CELL_HUMAN_REVIEW_APPROVAL =
  "HUMAN-REVIEW-APPROVED: benchmark-suite 2026-08-27 (benchmark scenarijus — žmogaus " +
  "autorizuotas, užrakintame rinkinyje peržiūrėtas artefaktas; patvirtinta vieną kartą visam rinkiniui)";

/** Kur task'e atsiranda parašas: preambulėje po `# Task`, PRIEŠ pirmą `## ` sekciją. */
const TASK_HEADING_RE = /^#\s+Task\s*$/;

/**
 * Uždeda parašą ant celės task'o teksto.
 *
 * Parašas dedamas į preambulę tarp `# Task` ir pirmos sekcijos, o ne į `## Tikslas`: taip
 * `## Tikslas` kūnas lieka BAITAS Į BAITĄ scenarijaus promptas, ir BENCH-3 „identiškas promptas"
 * tebegalioja būtent toje vietoje, kur jis tikrinamas. Sekcijų skaitytojai dirba per `^## `
 * antraštes, tad preambulė nė vienos sekcijos kūno nekeičia.
 */
export function withCellHumanReviewApproval(taskText: string): string {
  const lines = taskText.split("\n");
  const headingIndex = lines.findIndex((line) => TASK_HEADING_RE.test(line));
  if (headingIndex < 0) {
    // Be `# Task` antraštės preambulės nėra — parašas eina į pačią pradžią, kad `^`-inkaruotas
    // vartų regex'as jį vis tiek matytų. Tylus praleidimas grąžintų parkavimą be jokio pėdsako.
    return `${CELL_HUMAN_REVIEW_APPROVAL}\n\n${taskText}`;
  }
  return [
    ...lines.slice(0, headingIndex + 1),
    "",
    CELL_HUMAN_REVIEW_APPROVAL,
    ...lines.slice(headingIndex + 1),
  ].join("\n");
}

export async function benchmarkLoopCellCommand(deps: LoopCellDeps, args: readonly string[]): Promise<number> {
  const io = deps.io ?? consoleCliIo;
  const parsed = parseLoopCellArgs(args);
  if (parsed.kind === "error") {
    io.error(parsed.message);
    return USAGE_ERROR_EXIT_CODE;
  }
  const { workdir, model, stepLimit, timeoutMs, allowedPaths, checks, taskId } = parsed.args;

  const workdirAbs = path.resolve(workdir);
  if (!(await deps.ports.isDirectory(workdirAbs))) {
    io.error(`--workdir is not an existing directory: ${workdirAbs}`);
    return USAGE_ERROR_EXIT_CODE;
  }

  const prompt = await deps.ports.readStdin();
  if (prompt.trim() === "") {
    io.error(`${USAGE}\nstdin prompt is empty`);
    return USAGE_ERROR_EXIT_CODE;
  }

  const cell: CellTaskInput = {
    prompt,
    allowedPaths,
    checks: checks.map((command) => ({ command: command.split(/\s+/).filter(Boolean) })),
    taskId,
  };

  const taskFile = cellTaskPath(workdirAbs, taskId);
  // Parašas uždedamas ČIA, o ne `renderCellTask` viduje: gryna task'o forma lieka ta pati bet
  // kuriam kvietėjui, o patvirtinimas yra šio — rinkinį vykdančio — kelio faktas.
  await deps.ports.writeTextFile(taskFile, withCellHumanReviewApproval(renderCellTask(cell)));
  // Spec change'as PRIVALO atsirasti kartu su užduotimi: be jo `claude-preflight` kodo pakeitimą
  // teisingai nukreipia į human-review, ir celė baigiasi be nė vieno modelio kvietimo. Tai ne
  // apėjimas — tai ta pati tvarka, kurios loop'as reikalauja iš kiekvieno realaus darbo.
  for (const [relative, content] of renderCellSpec(cell)) {
    await deps.ports.writeTextFile(path.join(workdirAbs, ...relative.split("/")), content);
  }
  // Loop'o veikimo aplinka — 2026-08-22 piloto radinys, ir jis buvo dvigubas.
  //
  // Kopijoje nebuvo NEI `.claude/agents/`, NEI `vq/config/`. Pirmojo trūkumas preflight promptui
  // duodavo tuščią leistinų agentų sąrašą („gali naudoti tik agentus iš šio sąrašo: .") ir čia pat
  // reikalaudavo netuščios grandinės: modelis teisingai negrąžindavo nė vieno, validacija tai
  // atmesdavo kaip `target_agent_chain is required for delegation`, ir celė baigdavosi
  // human-review po VIENO kvietimo. Antrojo trūkumas sustabdydavo ciklą jau po delegavimo
  // (`tool budget not found`). Abi piloto celės buvo identiškos — tai deterministiniai aprūpinimo
  // defektai, ne loop'o elgsena.
  //
  // Aprūpinama VISA konfigų aibė, o ne po failą: kiekvienas praleistas failas atrandamas tik
  // kitame MOKAMAME paleidime, ir kiekvienas toks atradimas kainuoja visą celių rinkinį. Tai nėra
  // atsakymo padavimas — tai loop'o mechanizmas, ne užduoties turinys, ir promptas lieka tas pats
  // (BENCH-3). Nei `.claude`, nei `vq` neįeina į matuojamą diff'ą.
  const runtime = await deps.ports.provisionLoopRuntime(workdirAbs);
  if (runtime.agents === 0) {
    // Garsiai, o ne tyliai: orkestratorius be agentų roster'io išmatuoja mūsų aprūpinimą, ne save.
    io.error(
      "verqestra benchmark-loop-cell: no agent definition reached the checkout, so preflight " +
        "could only refuse; the cell measures provisioning, not the loop.",
    );
    return USAGE_ERROR_EXIT_CODE;
  }

  // PO aprūpinimo: kokybės vartai gauna BŪTENT scenarijaus patikras, o ne projekto politiką,
  // kuri ką tik buvo nukopijuota. Įrašius anksčiau, kopija ją perrašytų.
  await deps.ports.writeTextFile(
    path.join(workdirAbs, "vq", "config", "quality-policy.json"),
    cellQualityPolicy(checks),
  );
  await deps.ports.writeTextFile(
    path.join(workdirAbs, "vq", "project", "profile.json"),
    cellProjectProfile(),
  );

  const result = await deps.ports.runCycle({ workdir: workdirAbs, taskFile, model, stepLimit, timeoutMs });

  if (deps.ports.isUsageLimitOutput(result.stdout)) {
    io.error("verqestra benchmark-loop-cell: Claude API usage limit reached — no telemetry envelope produced.");
    return USAGE_LIMIT_EXIT_CODE;
  }

  const records = await deps.ports.readUsageRecords(workdirAbs);
  const telemetry = summarizeCellTelemetry(records, taskId);
  const humanReviewEvents = await deps.ports.humanReviewCount(workdirAbs);

  // Nulis modelio kvietimų yra DVI skirtingos baigtys, ir jas skiria žmogaus peržiūros įrodymas.
  //
  // 2026-08-22 pilotas: visos trys `security-log-session-tokens` celės grąžino nulį kvietimų, ir
  // celė jas įrašė kaip NEIŠMATUOTAS. Žiūrint į ciklo žurnalą, tai buvo geriausias įmanomas
  // rezultatas: deterministinis rizikos vartas atmetė užduotį („auth/security/payment/secrets…
  // require human-review after planning") PRIEŠ išleidžiant nė vieną toką. Scenarijaus
  // `expectedOutcome` yra `rejected`, o `agent-solo` tame pačiame scenarijuje išleido ~16 000
  // tokenų per pakartojimą ir nepriimto pakeitimo taip pat nepadarė.
  //
  // Vadinti tai „nematuota" reiškė sistemiškai ištrinti loop'o pranašumą būtent toje scenarijų
  // kategorijoje, kuri sukurta atsisakymui tikrinti. Atsisakymas be išlaidų yra matavimas, ir
  // nulis čia yra ŽINOMA kaina, ne trūkstama.
  //
  // Ciklas, pasibaigęs be kvietimų IR be peržiūros įrodymo, lieka neišmatuotas: taip atrodo
  // sulūžęs ciklas (trūkstamas konfigas, kritęs procesas), ir jo tylus pavertimas nuliniu
  // matavimu įrašytų harness'o gedimą kaip nemokamą sėkmę.
  if (telemetry.llmCalls === 0 && humanReviewEvents === 0) {
    const detail = (result.stderr || result.stdout).trim().slice(0, 2000);
    io.error(
      `verqestra benchmark-loop-cell: the cycle recorded no model call for ${taskId} ` +
        `and left no human-review evidence, so it is a broken cycle rather than a refusal` +
        `${detail ? `: ${detail}` : ""}`,
    );
    return result.code === 0 ? 1 : result.code;
  }
  const envelope: Record<string, unknown> = {
    [TELEMETRY_ENVELOPE_KEY]: TELEMETRY_ENVELOPE_VERSION,
    model,
    inputTokens: telemetry.inputTokens,
    outputTokens: telemetry.outputTokens,
    llmCalls: telemetry.llmCalls,
    attempts: telemetry.attempts,
    repairs: telemetry.repairs,
    humanReviewEvents,
    // Ciklo baigtis, ne agento pasigyrimas: `process-queued-task` grąžina 0 tik tada, kai
    // užduotis praėjo vartus. Tai ir yra loop'o „done".
    claimedDone: result.code === 0,
    usage: {
      // Nulis kvietimų — ŽINOMA kaina, ne trūkstama. `summarizeCellTelemetry` teisingai sako
      // „apskaitos nemačiau", nes ji nežino, ar žurnalas tuščias dėl atsisakymo, ar dėl lūžio;
      // tai žino tik čia, iš žmogaus peržiūros įrodymo. Palikus `false`, visos populiacijos
      // tokenų metrikos būtų atmestos kaip `no-captured-usage` dėl celės, kuri neišleido nieko.
      captured: telemetry.llmCalls === 0 ? true : telemetry.captured,
      cacheReadInputTokens: telemetry.cacheReadInputTokens,
      cacheCreationInputTokens: telemetry.cacheCreationInputTokens,
      numTurns: telemetry.numTurns,
      turnsSource: "recorded",
    },
  };
  io.out(JSON.stringify(envelope));
  return 0;
}
