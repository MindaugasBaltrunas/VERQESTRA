// Siauras integracijos repair task'as (spec IVER-3, design §11). Behaviour etalon:
// AG_loop application/integration/create-integration-repair.ts (1:1).
//
// Kai integracijos peržiūra pasako „šitas konfliktas taisytinas", atsiranda pavojus, kurio
// bendras repair kelias neturi: konfliktas gyvena TARP dviejų task'ų, tad natūralus
// impulsas yra leisti taisytojui liesti abiejų pusių kodą. Būtent taip siauras taisymas
// virsta antra implementacija. Šis modulis yra ta riba — leistini keliai yra
// KONFLIKTO ∩ TASK'O APIMTIS:
//
//   1. REPAIR NEPERŽENGIA KONFLIKTO. Kelias, kurio konfliktas neliečia, į `Leidžiama` nepatenka.
//   2. REPAIR NEPERŽENGIA TASK'O. Konfliktas, kurio dalis yra už task'o leistinų kelių,
//      NĖRA taisomas siauru repair'u — jis eina į human-review.
//   3. PAKARTOTINIS KONFLIKTAS NEBETAISOMAS AUTOMATIŠKAI.
//   4. BE TIKSLINIO TESTO NĖRA REPAIR'O.
//
// Modulis GRYNAS — jokio FS, git ar laikrodžio: repair prompt'ą persistuoja kvietėjas
// (RunCoordinator), o tie patys įėjimai visada duoda tą patį `repair_hash`.

import { createHash } from "node:crypto";
import { canonicalJsonStringify } from "../../shared/json.js";
import { toComparablePosixPath as toPosix } from "../../shared/paths.js";
import type { IntegrationConflict, IntegrationRiskVerdict } from "./evaluate-integration-risk.js";
import { integrationAlternatives, type IntegrationReviewFinding } from "./review-integration.js";

/** Repair formato versija. Įeina į `repair_hash`. */
export const INTEGRATION_REPAIR_VERSION = 1;

export type IntegrationRepairTask = {
  version: number;
  task_id: string;
  wave_id: string;
  conflict_id: string;
  /** Grandinė yra fiksuota: orchestrator jau paruošė kontraktą, tad vykdo `repairer`. */
  agent: "repairer";
  allowed_paths: string[];
  forbidden_paths: string[];
  /** Tiksliniai cross-module testai — be jų repair'as negeneruojamas. */
  targeted_tests: string[];
  checks: string[];
  /** `# Repair Task` markdown, kuris tampa `error` bucket'o task'o kūnu. */
  body: string;
  repair_hash: string;
};

export type CreateIntegrationRepairInput = {
  taskId: string;
  waveId: string;
  conflict: IntegrationConflict;
  /** Task'o `## Failai` `Leidžiama:` keliai. Repair'as jų peržengti negali. */
  taskAllowedPaths: readonly string[];
  /** Task'o `Draudžiama:` keliai — perkeliami nepakeisti. */
  taskForbiddenPaths?: readonly string[];
  /** Testai, dengiantys būtent šį cross-module konfliktą. */
  targetedTests: readonly string[];
  /** Task'o patikros komandos; nenurodžius paliekama tuščia ir tikrinama tik testais. */
  checks?: readonly string[];
  /** Peržiūros išvados — jos tampa `## Klaida` turiniu. */
  findings?: readonly IntegrationReviewFinding[];
  /** Rizikos verdiktas — iš jo išvedamos alternatyvos, kai repair'as negeneruojamas. */
  risk?: IntegrationRiskVerdict;
};

export type CreateIntegrationRepairResult =
  | { kind: "repair"; repair: IntegrationRepairTask }
  | { kind: "human-review"; reason: string; alternatives: string[] };

function sorted(values: Iterable<string>): string[] {
  return [...new Set([...values].map((value) => value.trim()).filter(Boolean))].sort();
}

/**
 * Leistino kelio prefiksas. Glob'as sutraukiamas iki pirmo `*` — tiek `src/*.ts`, tiek
 * gilesni `src/**` šablonai tampa `src`. Tai sąmoningai konservatyvu apimties
 * SKAIČIAVIMUI, bet ne jos plėtimui: prefiksas naudojamas tik tikrinant, ar konflikto
 * kelias PATENKA į task'o apimtį, o į `Leidžiama` rašomi patys konflikto keliai.
 */
function allowedPrefix(entry: string): string {
  const normalized = toPosix(entry);
  const cut = normalized.indexOf("*");
  return (cut === -1 ? normalized : normalized.slice(0, cut)).replace(/\/+$/, "");
}

/** Ar konflikto kelias patenka į task'o leistinų kelių apimtį. */
export function isWithinTaskScope(filePath: string, taskAllowedPaths: readonly string[]): boolean {
  const target = toPosix(filePath);
  if (!target) return false;
  return taskAllowedPaths.some((entry) => {
    const prefix = allowedPrefix(entry);
    return Boolean(prefix) && (target === prefix || target.startsWith(`${prefix}/`));
  });
}

/** Signalai, kuriuos galima taisyti siauru repair'u (skirtingai nuo hard-gate signalų). */
const REPAIRABLE_SIGNALS = new Set(["contract-break", "contract-unverified", "multi-module-contract"]);

/**
 * Konfliktas, kuriam generuojamas repair'as.
 *
 * Aiškiai pateiktas bangos konfliktas laimi visada. Jo nesant konfliktas IŠVEDAMAS iš
 * pirmo taisytino rizikos signalo: reviewer'is gali pareikalauti pakeitimų ir tada, kai
 * git merge konflikto nėra (pvz. pašalintas eksportas, kurį kitas modulis vis dar
 * importuoja). Atranka deterministinė: konfliktai imami rūšiuota id tvarka, signalai —
 * jų verdikto tvarka.
 */
export function conflictForIntegrationRepair(
  risk: IntegrationRiskVerdict,
  conflicts: readonly IntegrationConflict[] = [],
): IntegrationConflict | undefined {
  const focused = conflicts
    .filter((conflict) => risk.focus.conflicts.includes(conflict.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (focused[0]) return focused[0];

  const signal = risk.signals.find((candidate) => REPAIRABLE_SIGNALS.has(candidate.code));
  if (!signal) return undefined;
  const paths = signal.evidence.filter((evidence) => risk.focus.paths.includes(evidence));
  return { id: signal.evidence[0] ?? signal.code, paths, summary: signal.detail, attempts: 1 };
}

function humanReview(reason: string, risk: IntegrationRiskVerdict | undefined, extra: string[]): CreateIntegrationRepairResult {
  const alternatives = risk ? integrationAlternatives(risk) : [];
  return { kind: "human-review", reason, alternatives: sorted([...extra, ...alternatives]) };
}

/**
 * Sugeneruoja siaurą integracijos repair task'ą arba atsisako jį generuoti.
 *
 * Atsisakymas NĖRA klaida: `human-review` su konkrečiomis alternatyvomis yra teisingas
 * rezultatas visur, kur siauras taisymas negali išspręsti viso konflikto.
 */
export function createIntegrationRepair(input: CreateIntegrationRepairInput): CreateIntegrationRepairResult {
  const { conflict } = input;
  const attempts = conflict.attempts ?? 1;
  const conflictPaths = sorted(conflict.paths.map(toPosix));

  if (attempts >= 2) {
    return humanReview(
      `repeated conflict "${conflict.id}" on attempt ${attempts} — automated integration repair is not converging`,
      input.risk,
      [],
    );
  }

  if (conflictPaths.length === 0) {
    return humanReview(`conflict "${conflict.id}" has no paths — its scope cannot be bounded`, input.risk, [
      "Nurodyk konflikto kelius (git merge išvestis) ir perleisk integraciją — be jų repair apimties suformuluoti neįmanoma.",
    ]);
  }

  const outOfScope = conflictPaths.filter((filePath) => !isWithinTaskScope(filePath, input.taskAllowedPaths));
  if (outOfScope.length > 0) {
    return humanReview(
      `conflict "${conflict.id}" reaches outside the task scope: ${outOfScope.join(", ")}`,
      input.risk,
      [
        `Suplanuok atskirą task'ą, kurio \`## Failai\` apima ${outOfScope.join(", ")}, ir integruok jį prieš šią bangą.`,
      ],
    );
  }

  const targetedTests = sorted(input.targetedTests.map(toPosix));
  if (targetedTests.length === 0) {
    return humanReview(
      `conflict "${conflict.id}" has no targeted cross-module test — a repair could not be proven`,
      input.risk,
      [
        `Pridėk cross-module testą, dengiantį ${conflictPaths.join(", ")}, ir perleisk integraciją.`,
      ],
    );
  }

  const forbiddenPaths = sorted(input.taskForbiddenPaths ?? []);
  const checks = [...(input.checks ?? [])].map((check) => check.trim()).filter(Boolean);
  const findings = (input.findings ?? []).filter((finding) => finding.detail.trim());

  const repair: Omit<IntegrationRepairTask, "repair_hash"> = {
    version: INTEGRATION_REPAIR_VERSION,
    task_id: input.taskId,
    wave_id: input.waveId,
    conflict_id: conflict.id,
    agent: "repairer",
    allowed_paths: conflictPaths,
    forbidden_paths: forbiddenPaths,
    targeted_tests: targetedTests,
    checks,
    body: renderIntegrationRepairBody({
      taskId: input.taskId,
      waveId: input.waveId,
      conflict,
      conflictPaths,
      forbiddenPaths,
      targetedTests,
      checks,
      findings,
    }),
  };

  return { kind: "repair", repair: { ...repair, repair_hash: computeIntegrationRepairHash(repair) } };
}

type RepairBodyInput = {
  taskId: string;
  waveId: string;
  conflict: IntegrationConflict;
  conflictPaths: readonly string[];
  forbiddenPaths: readonly string[];
  targetedTests: readonly string[];
  checks: readonly string[];
  findings: readonly IntegrationReviewFinding[];
};

function bullet(lines: readonly string[], empty = "- (nėra)"): string {
  return lines.length > 0 ? lines.map((line) => `- ${line}`).join("\n") : empty;
}

/**
 * `# Repair Task` kūnas kanonine sekcijų tvarka (`repairer` agento kontraktas):
 * `## Tikslas` / `## Agentas` / `## Klaida` / `## Failai` / `## Veiksmas` / `## Patikra` /
 * `## Stop` / `## Neįtraukta`. Sekcijų vardai NĖRA laisvi — pagal juos repair task'as
 * atpažįstamas preflight'e.
 */
export function renderIntegrationRepairBody(input: RepairBodyInput): string {
  const conflictSummary = input.conflict.summary?.trim() || `integracijos konfliktas ${input.conflict.id}`;
  const conflictTasks = input.conflict.tasks?.length ? input.conflict.tasks.join(", ") : "bangos commit'ai";

  return `# Repair Task

## Tikslas
Išspręsk vieną integracijos konfliktą \`${input.conflict.id}\` bangoje \`${input.waveId}\` neišplėsdamas jo apimties.

## Agentas
repairer

## Klaida
${conflictSummary} (tarp: ${conflictTasks}).
${bullet(input.findings.map((finding) => `${finding.target || input.conflict.id}: ${finding.detail.trim()}`), "- Konfliktą nustatė deterministiniai integracijos vartai.")}

## Failai
Leidžiama:
${bullet(input.conflictPaths.map((filePath) => `\`${filePath}\``))}

Draudžiama:
${bullet(input.forbiddenPaths.map((filePath) => `\`${filePath}\``), "- Bet koks failas, kurio nėra `Leidžiama` sąraše.")}

## Veiksmas
- Pataisyk TIK šį konfliktą; kitų bangos pokyčių neliesk.
- Nekeisk public kontrakto plačiau, nei reikia konfliktui išspręsti.
- Jei konfliktui išspręsti reikia failo už \`Leidžiama\` ribų — sustok ir pranešk apie apimties pažeidimą.

## Patikra
${bullet([...input.targetedTests.map((test) => `\`${test}\``), ...input.checks.map((check) => `\`${check}\``)])}

## Stop
Sustok, kai tikslinis cross-module testas praeina ir konflikto \`${input.conflict.id}\` nebelieka.

## Neįtraukta
- Bendras kodo stiliaus review.
- Kitų bangos konfliktų taisymas.
- Task'o apimties plėtimas.
`;
}

/**
 * Repair atspaudas. Hash'uojama tik APIMTIS (konfliktas, keliai, testai, patikros) — kūno
 * formuluotė iš jos išvedama, tad tas pats `repair_hash` visada reiškia „ta pati taisymo
 * apimtis", o ne „tas pats tekstas".
 */
export function computeIntegrationRepairHash(repair: Omit<IntegrationRepairTask, "repair_hash">): string {
  const payload = {
    version: repair.version,
    task_id: repair.task_id,
    wave_id: repair.wave_id,
    conflict_id: repair.conflict_id,
    allowed: repair.allowed_paths,
    forbidden: repair.forbidden_paths,
    tests: repair.targeted_tests,
    checks: repair.checks,
  };
  const digest = createHash("sha256").update(canonicalJsonStringify(payload), "utf8").digest("hex");
  return `irp${INTEGRATION_REPAIR_VERSION}:${digest.slice(0, 16)}`;
}
