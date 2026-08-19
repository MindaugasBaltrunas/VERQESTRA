// Wave-level quality gates (spec IVER-2, design §11 „Integration verifier"). Behaviour
// etalon: AG_loop application/integration/run-wave-gates.ts (raporto turinys 1:1; IO —
// per deps portus: komandų paleidimą, komandų politiką ir raporto persistavimą paduoda
// kvietėjas, nes procesų spawn'as ir FS yra E4/E5 pusė; vartų POLITIKA (`gates`) čia
// PRIVALOMA įvestis — jos skaitymą iš quality-policy konfigo atneš quality-gates klasteris).
//
// Kol šito nebuvo, bangos priėmimo kriterijus buvo „kiekvienas task'as atskirai žalias".
// Tas kriterijus klaidingas iš esmės: task'o patikros paleidžiamos PRIEŠ kitų bangos
// task'ų pakeitimus. Šis modulis yra vienintelis taškas, kuriame banga tikrinama kaip
// VISUMA. Trys savybės yra taisyklės:
//
//   1. NESUKONFIGŪRUOTAS VARTAS YRA NE-PRAĖJIMAS. `missing` niekada nevirsta „praleista";
//      trūkstami vartai nustatomi PRIEŠ paleidžiant bet ką.
//   2. KONTRAKTŲ SUDERINAMUMAS YRA VIDINIS VARTAS. `contract-compatibility` skaičiuojamas
//      iš contract diff rezultato, o ne iš projekto komandos.
//   3. TESTAI PARENKAMI IŠ BANGOS, NE IŠ TASK'O: visų integruotų task'ų impacted tests
//      SĄJUNGA su testais, dengiančiais PAKEISTUS kontraktus.

import { createHash } from "node:crypto";
import path from "node:path";
import { canonicalJsonStringify } from "../../shared/json.js";
import type { ContractDiffReport } from "./contract-model.js";
import { sanitizeRefSegment } from "./create-integration-plan.js";
import {
  WAVE_COMMAND_GATE_NAMES,
  WAVE_GATE_BLOCKED_EXIT_CODE,
  WAVE_GATE_NAMES,
  WAVE_GATE_NOT_RUN_EXIT_CODE,
  WAVE_GATE_REPORT_SCHEMA_VERSION,
  type WaveCommandGateName,
  type WaveGateName,
  type WaveGatePolicy,
  type WaveGateReport,
  type WaveGateResult,
} from "./wave-gates-schema.js";

/** Bangos vartų numatytas laiko limitas vienai komandai. Toks pat kaip task vartų. */
export const WAVE_GATE_DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Atrinktų testų perdavimo kanalas. Testai NEPRIDEDAMI prie komandos argumentų sąmoningai:
 * komandų politika leidžia paketų tvarkyklei tiksliai vieną script argumentą (`pnpm test`),
 * tad kelių pridėjimas komandą užblokuotų. Aplinkos kintamasis perduoda atranką
 * neišplečiant leidžiamos komandos formos.
 */
export const WAVE_TESTS_ENV = "AG_WAVE_TESTS";
export const WAVE_ID_ENV = "AG_WAVE_ID";
export const WAVE_BRANCH_ENV = "AG_INTEGRATION_BRANCH";

export type WaveGateCommand = {
  gate: WaveCommandGateName;
  cmd: string;
  args: string[];
  /** Žmogui skirta komandos forma; ji patenka į persistuojamą įrodymą. */
  display: string;
};

export type WaveGateCommandResult = { code: number; stdout: string; stderr: string };

/** Komandos paleidimas (E4 adapteris — realus spawn; testuose — fake). */
export type WaveGateRunner = (
  command: WaveGateCommand,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
) => Promise<WaveGateCommandResult>;

/**
 * Komandų politikos vartas: `blockedPattern` reiškia, kad komanda draudžiama. Konkrečias
 * taisykles (spawn allowlist) atneša quality-gates klasteris; be politikos bangos vartai
 * apskritai nepaleidžiami — todėl ji čia PRIVALOMA, ne optional.
 */
export type WaveGateCommandPolicy = (cmd: string, args: readonly string[]) => { blockedPattern?: string };

/** Raporto persistavimas — vienintelis šio modulio FS efektas, todėl jis yra portas. */
export type WaveGateReportStore = {
  persist(report: WaveGateReport): Promise<void>;
};

export type RunWaveGatesDeps = {
  runner: WaveGateRunner;
  commandPolicy: WaveGateCommandPolicy;
  store: WaveGateReportStore;
};

export type WaveTaskIntegration = {
  task_id: string;
  /** Task'o impacted tests (code-index projekcija), jei žinomi. */
  impacted_tests?: readonly string[];
  /** Task'o commit'ų paliesti keliai. */
  changed_paths?: readonly string[];
};

export type RunWaveGatesInput = {
  projectRoot: string;
  runId: string;
  waveId: string;
  /** Integration branch'as, kuriame vartai paleidžiami. */
  branch: string;
  /** Integration branch'o head — kartu su contract diff'u sudaro `source_hash`. */
  head?: string;
  contractDiff: ContractDiffReport;
  tasks: readonly WaveTaskIntegration[];
  /**
   * Kontrakto kelias → jį dengiantys testai. Tai code-index grafo užklausos projekcija,
   * kurią paduoda kvietėjas: modulis lieka be indekso priklausomybės.
   */
  testsByPath?: Readonly<Record<string, readonly string[]>>;
  /** Vartų komandos (quality-policy `wave` sekcija). Skaitymą iš konfigo atlieka kvietėjas. */
  gates: WaveGatePolicy;
  /** Bazinė aplinka vartų komandoms. Numatytai `process.env`. */
  baseEnv?: NodeJS.ProcessEnv;
  /** Monotoninis laikmatis trukmėms (ms). Numatytai `Date.now`. */
  now?: () => number;
  /** ISO laiko žymos. Numatytai dabartinis laikas. */
  timestamp?: () => string;
  timeoutMs?: number;
  /**
   * Ar po pirmo lūžusio varto praleisti likusius. Numatytai `true`: `build` po lūžusio
   * `typecheck` yra minutės be naujos informacijos. Praleisti vartai raportuojami kaip
   * `skipped`, o ne dingsta iš įrodymo.
   */
  stopOnFirstFailure?: boolean;
};

/** Persistuojamo bangos vartų raporto kelias (E4 adapterio konvencija). */
export function waveGateReportPath(projectRoot: string, runId: string, waveId: string): string {
  const file = `${sanitizeRefSegment(runId)}--${sanitizeRefSegment(waveId)}.json`;
  return path.join(projectRoot, "vq", "state", "wave-gates", file);
}

/**
 * Bangos testų atranka.
 *
 * Sąjunga, o ne sankirta: praleistas testas yra tyli regresija, o perteklinis testas —
 * tik laikas. Antrasis šaltinis (`testsByPath` prieš PAKEISTUS kontraktus) yra tas, dėl
 * kurio atranka apskritai egzistuoja — be jo banga paleistų tik tuos testus, kuriuos
 * kiekvienas task'as jau paleido atskirai, ir cross-module regresija liktų nepagauta.
 */
export function selectWaveTests(
  tasks: readonly WaveTaskIntegration[],
  contractDiff: ContractDiffReport,
  testsByPath: Readonly<Record<string, readonly string[]>> = {},
): string[] {
  const selected = new Set<string>();
  for (const task of tasks) {
    for (const test of task.impacted_tests ?? []) {
      const value = test.trim();
      if (value) selected.add(value);
    }
  }
  for (const filePath of contractChangedPaths(contractDiff)) {
    for (const test of testsByPath[filePath] ?? []) {
      const value = test.trim();
      if (value) selected.add(value);
    }
  }
  return [...selected].sort();
}

/** Keliai, kuriuose kontraktas realiai pasikeitė (įskaitant nepatikrintus). */
export function contractChangedPaths(contractDiff: ContractDiffReport): string[] {
  const paths = new Set<string>(contractDiff.unverified_paths);
  for (const entry of contractDiff.entries) {
    for (const evidence of entry.evidence) paths.add(evidence.path);
  }
  return [...paths].filter(Boolean).sort();
}

/**
 * Bangos šaltinio atspaudas: KOKIAI kodo būsenai šie vartų rezultatai galioja. Be jo senas
 * raportas su tuo pačiu `wave_id` būtų neatskiriamas nuo šviežio.
 */
export function computeWaveSourceHash(input: {
  branch: string;
  head: string;
  contractDiffHash: string;
  changedPaths: readonly string[];
}): string {
  const payload = {
    version: WAVE_GATE_REPORT_SCHEMA_VERSION,
    branch: input.branch,
    head: input.head,
    contract_diff: input.contractDiffHash,
    changed: [...new Set(input.changedPaths)].sort(),
  };
  const digest = createHash("sha256").update(canonicalJsonStringify(payload), "utf8").digest("hex");
  return `wg${WAVE_GATE_REPORT_SCHEMA_VERSION}:${digest.slice(0, 16)}`;
}

function resolveGateCommands(policy: WaveGatePolicy): Map<WaveCommandGateName, WaveGateCommand> {
  const commands = new Map<WaveCommandGateName, WaveGateCommand>();
  for (const gate of WAVE_COMMAND_GATE_NAMES) {
    const configured = policy[gate];
    if (!configured) continue;
    const args = configured.args.slice();
    commands.set(gate, { gate, cmd: configured.cmd, args, display: [configured.cmd, ...args].join(" ") });
  }
  return commands;
}

function notRunResult(gate: WaveGateName, status: "missing" | "skipped", detail: string): WaveGateResult {
  return {
    gate,
    status,
    command: "",
    exit_code: WAVE_GATE_NOT_RUN_EXIT_CODE,
    duration_ms: 0,
    detail,
  };
}

/**
 * `contract-compatibility` verdiktas. Blokuoja tiek įrodytas nesuderinamumas (`breaking`),
 * tiek įrodymo NEBUVIMAS (`unverified`) — pastarasis yra tiesioginis atsakas į prielaidą,
 * kad failų diff'o pakanka semantiniam suderinamumui pagrįsti.
 */
function contractCompatibilityResult(contractDiff: ContractDiffReport): WaveGateResult {
  if (contractDiff.compatible) {
    return {
      gate: "contract-compatibility",
      status: "passed",
      command: "",
      exit_code: 0,
      duration_ms: 0,
      detail: `contract diff ${contractDiff.diff_hash}: ${contractDiff.entries.length} change(s), none blocking`,
    };
  }
  const summary = contractDiff.blocking
    .map((entry) => `${entry.breaking_risk}:${entry.id}`)
    .join(", ");
  return {
    gate: "contract-compatibility",
    status: "failed",
    command: "",
    exit_code: 1,
    duration_ms: 0,
    detail: `contract diff ${contractDiff.diff_hash} is blocking: ${summary}`,
  };
}

/**
 * Paleidžia bangos vartus ir persistuoja įrodymą.
 *
 * Raportas grąžinamas VISADA — net kai visi vartai trūksta. `ok: false` reiškia „bangos
 * priimti negalima", o ne „paleidimas nepavyko"; sprendimą, ką su tuo daryti (žmogaus
 * peržiūra, rollback, pakartojimas), priima kvietėjas.
 */
export async function runWaveGates(input: RunWaveGatesInput, deps: RunWaveGatesDeps): Promise<WaveGateReport> {
  const projectRoot = input.projectRoot;
  const clock = input.now ?? (() => Date.now());
  const isoNow = input.timestamp ?? (() => new Date().toISOString());
  const timeoutMs = input.timeoutMs ?? WAVE_GATE_DEFAULT_TIMEOUT_MS;
  const stopOnFirstFailure = input.stopOnFirstFailure ?? true;

  const commands = resolveGateCommands(input.gates);

  const selectedTests = selectWaveTests(input.tasks, input.contractDiff, input.testsByPath ?? {});
  const changedPaths = [
    ...new Set([...input.tasks.flatMap((task) => [...(task.changed_paths ?? [])]), ...contractChangedPaths(input.contractDiff)]),
  ].sort();

  const startedAt = isoNow();
  const startedMs = clock();
  const results: WaveGateResult[] = [];
  const blockingReasons: string[] = [];

  // Trūkstami vartai nustatomi PRIEŠ vykdymą: ankstyvas kritimas neturi paslėpti fakto,
  // kad dalis privalomų vartų apskritai nesukonfigūruota.
  const missingGates = WAVE_COMMAND_GATE_NAMES.filter((gate) => !commands.has(gate));
  for (const gate of missingGates) {
    blockingReasons.push(`missing-gate: ${gate} is not configured in quality-policy.json#wave`);
  }

  const gateEnv: NodeJS.ProcessEnv = {
    ...(input.baseEnv ?? process.env),
    [WAVE_TESTS_ENV]: selectedTests.join("\n"),
    [WAVE_ID_ENV]: input.waveId,
    [WAVE_BRANCH_ENV]: input.branch,
  };

  let failed = false;
  for (const gate of WAVE_GATE_NAMES) {
    if (gate === "contract-compatibility") {
      const result = contractCompatibilityResult(input.contractDiff);
      results.push(result);
      if (result.status !== "passed") {
        failed = true;
        for (const entry of input.contractDiff.blocking) {
          blockingReasons.push(`contract-${entry.breaking_risk}: ${entry.id} (${entry.reasons[0] ?? entry.change})`);
        }
      }
      continue;
    }

    const command = commands.get(gate);
    if (!command) {
      results.push(notRunResult(gate, "missing", `gate ${gate} has no configured command`));
      continue;
    }
    if (failed && stopOnFirstFailure) {
      results.push(notRunResult(gate, "skipped", `skipped after an earlier wave gate failed`));
      continue;
    }

    const policyVerdict = deps.commandPolicy(command.cmd, command.args);
    if (policyVerdict.blockedPattern) {
      results.push({
        gate,
        status: "blocked",
        command: command.display,
        exit_code: WAVE_GATE_BLOCKED_EXIT_CODE,
        duration_ms: 0,
        detail: `wave gate command blocked by spawn policy: ${policyVerdict.blockedPattern}`,
      });
      blockingReasons.push(`gate-blocked: ${gate} — ${policyVerdict.blockedPattern}`);
      failed = true;
      continue;
    }

    const gateStart = clock();
    const outcome = await deps.runner(command, projectRoot, gateEnv, timeoutMs);
    const duration = Math.max(0, clock() - gateStart);
    const passed = outcome.code === 0;
    results.push({
      gate,
      status: passed ? "passed" : "failed",
      command: command.display,
      exit_code: outcome.code,
      duration_ms: duration,
      stdout: outcome.stdout,
      stderr: outcome.stderr,
    });
    if (!passed) {
      blockingReasons.push(`gate-failed: ${gate} exited ${outcome.code}`);
      failed = true;
    }
  }

  const finishedAt = isoNow();
  const report: WaveGateReport = {
    schema_version: WAVE_GATE_REPORT_SCHEMA_VERSION,
    run_id: input.runId,
    wave_id: input.waveId,
    branch: input.branch,
    head: input.head ?? "",
    source_hash: computeWaveSourceHash({
      branch: input.branch,
      head: input.head ?? "",
      contractDiffHash: input.contractDiff.diff_hash,
      changedPaths,
    }),
    contract_diff_hash: input.contractDiff.diff_hash,
    ok: blockingReasons.length === 0 && results.every((result) => result.status === "passed"),
    gates: results,
    selected_tests: selectedTests,
    blocking_reasons: blockingReasons,
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: Math.max(0, clock() - startedMs),
  };

  await deps.store.persist(report);
  return report;
}
