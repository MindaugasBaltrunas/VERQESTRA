// release-readiness use case (etalono final-audit.ts, WBR VQ-305): sukomponuoja queue-empty,
// converge, readiness, backlog, release-check šviežumo, rule-status, architecture-boundary,
// benchmark-evidence ir compression-quality patikras į projekto užbaigimo verdiktą, o visoms
// žalioms — generuoja release notes ir commit'inamą release proof.
//
// Etalone dalis patikrų buvo tiesioginiai orchestrator/* kvietimai; VERQESTRA jos ateina per
// `FinalAuditPorts` deskriptoriais: converge/readiness/backlog/benchmark/compression moduliai
// atvyksta vėlesnėmis VQ-305 dalimis arba lieka E4/E5 — port'o nebuvimo NĖRA, kompozicija
// privalo paduoti visas patikras (final audit be kurios nors patikros būtų tylus praleidimas).
import path from "node:path";
import { recognizeTask, taskFileStem, taskNumberFromFilename } from "../../domain/tasks/identity.js";
import { CODING_PRINCIPLE_IDS } from "../../domain/policies/coding-principles-catalog.js";
import { ENFORCEMENT_LEVELS, isEnforcementLevel } from "../../domain/policies/enforcement-level.js";
import {
  loadArchitectureStylePolicy,
  loadCodingPrinciplesPolicy,
  loadEnforcementPolicy,
  type ArchitectureStylePolicyConfig,
  type CodingPrinciplesPolicy,
} from "../policy-governance/architecture-policies.js";
import type { PolicyConfigFileSystemPort } from "../policy-governance/ports.js";
import { computeSourceState, type ReleaseCheckFsPort, type ReleaseCheckSourceState, type SourceStateInputs } from "./release-check.js";
import type { ArchitectureBoundaryCheckResult } from "./architecture-boundary-check.js";
import type { ReleaseNotesResult } from "./release-notes.js";
import type { GenerateReleaseProofOptions, ReleaseProofWriteResult } from "./release-proof.js";

export type FinalAuditStatus = "complete" | "not_complete";

export type ReleaseCheckState = {
  status?: string;
  failed_parts?: string[];
  updated_at?: string;
  source_state?: ReleaseCheckSourceState;
};

export type FinalAuditResult = {
  status: FinalAuditStatus;
  pending_tasks: Record<string, string[]>;
  checks: Record<string, { ok: boolean; issues: string[] }>;
  release_notes?: ReleaseNotesResult;
  release_proof?: ReleaseProofWriteResult;
  report_path: string;
  updated_at: string;
};

const pendingBuckets = ["queue", "active", "delegated", "error", "failed", "human-review"] as const;

/** Vartų deskriptorius: `ok` + surūšiuotos priežastys — visos patikros grąžina šią formą. */
export type FinalAuditCheck = { ok: boolean; issues: string[] };

export type FinalAuditPorts = {
  /** Bucket'o `.md` failai su turiniu (vardų tvarka); katalogo nebuvimas — tuščias sąrašas. */
  listBucketFiles(bucket: string): Promise<{ name: string; text: string }[]>;
  /** Ar human-review task'as pažymėtas resolved state-history žurnale (uždarytas nejudinant failo). */
  humanReviewResolved(taskId: string): Promise<boolean>;
  /** Converge patikra: `{kind}:{ref}` formos issues; `incomplete-work human-review/...` filtruojami čia. */
  converge(): Promise<{ issues: { kind: string; ref: string }[] }>;
  /** Readiness auditas — adapteris suploja kategorijas į `{area}:{item}` eilutes. */
  readiness(): Promise<FinalAuditCheck>;
  /** Backlog auditas — adapteris suploja missing/duplicate/out-of-order į prefiksuotas eilutes. */
  backlog(): Promise<FinalAuditCheck>;
  readReleaseCheck(): Promise<ReleaseCheckState>;
  /** Naujausias mtime (ms) tarp nurodytų failų; `undefined`, kai nė vieno nėra. */
  newestMtime(absolutePaths: string[]): Promise<number | undefined>;
  /** Naujausias mtime (ms) katalogo medyje; `undefined`, kai katalogo nėra/tuščias. */
  newestMtimeInDir(absoluteDir: string): Promise<number | undefined>;
  /** Policy konfigų skaitymas rule-status vartams. */
  policyFs: PolicyConfigFileSystemPort;
  /** Source-state hash'o FS portas (release-check šviežumo palyginimui). */
  sourceFs: ReleaseCheckFsPort;
  /** Neišspręstų policy proposal'ų kiekis; meta, kai registro failas sugadintas. */
  pendingProposalCount(): Promise<number>;
  architectureBoundary(): Promise<ArchitectureBoundaryCheckResult>;
  /** BENCH-12 vartai (benchmark klasteris) — `describe` eilutė keliauja į release proof. */
  benchmarkEvidence(): Promise<FinalAuditCheck & { describe: string }>;
  /** Compression rollout vartai — `describe` eilutė keliauja į release proof. */
  compressionQuality(): Promise<FinalAuditCheck & { describe: string }>;
  releaseNotes(now: Date): Promise<ReleaseNotesResult>;
  releaseProof(options: GenerateReleaseProofOptions): Promise<ReleaseProofWriteResult>;
  writeReport(result: FinalAuditResult): Promise<void>;
};

export type FinalAuditOptions = {
  projectRoot?: string;
  runtimeRoot?: string;
  now?: Date;
  sourceStateInputs?: SourceStateInputs;
};

/** `vq/state/final-audit-result.json` — kompozicijos verdikto failas (rašo adapteris). */
export function finalAuditResultPath(runtimeRoot: string): string {
  return path.join(runtimeRoot, "state", "final-audit-result.json");
}

export async function runFinalAudit(ports: FinalAuditPorts, options: FinalAuditOptions = {}): Promise<FinalAuditResult> {
  const root = path.resolve(options.projectRoot ?? process.cwd());
  const runtimeRoot = options.runtimeRoot ?? path.join(root, "vq");
  const now = options.now ?? new Date();
  const pendingTasks = await readPendingTasks(ports);
  const convergeResult = await ports.converge();
  const convergeIssues = await unresolvedConvergeIssues(ports, convergeResult.issues);
  const readiness = await ports.readiness();
  const backlog = await ports.backlog();
  const releaseCheck = await ports.readReleaseCheck();
  const releaseFreshnessIssues = await releaseFreshness(ports, root, runtimeRoot, releaseCheck, options.sourceStateInputs);

  const ruleStatusIssues = await checkRuleStatus(ports, runtimeRoot);
  const architectureBoundary = await ports.architectureBoundary();
  const benchmarkEvidence = await ports.benchmarkEvidence();
  const compressionQuality = await ports.compressionQuality();

  const checks = {
    queue_empty: check(Object.keys(pendingTasks).length === 0, pendingIssues(pendingTasks)),
    converge: check(convergeIssues.length === 0, convergeIssues.map((issue) => `${issue.kind}:${issue.ref}`)),
    readiness: check(readiness.ok, readiness.issues),
    backlog: check(backlog.ok, backlog.issues),
    release_check: check(
      releaseCheck.status === "ok" && releaseFreshnessIssues.length === 0,
      releaseCheck.status === "ok"
        ? releaseFreshnessIssues
        : (releaseCheck.failed_parts?.map((part) => `release-check:${part}`) ?? ["release-check-result missing"]),
    ),
    rule_status: check(ruleStatusIssues.length === 0, ruleStatusIssues),
    // Beyond-baseline forbidden layer imports: sekamos skolos neblokuoja, nauja regresija — taip.
    architecture_boundary: check(architectureBoundary.ok, architectureBoundary.issues),
    // BENCH-12: sėkmės deklaracija negalima ant pasenusio/nepilno/inconclusive/regresavusio
    // benchmark įrodymo; praeina vakuumiškai, kur benchmark paketo nėra.
    benchmark_evidence: check(benchmarkEvidence.ok, benchmarkEvidence.issues),
    // Compression rollout 4 žingsnis: `true` stovinti vėliava privalo būti paremta priimtu
    // varianto verdiktu, matavimu ir gyvu canary įrodymu; vakuumiška, kol nė viena neįjungta.
    compression_quality: check(compressionQuality.ok, compressionQuality.issues),
  };

  const status: FinalAuditStatus = Object.values(checks).every((item) => item.ok) ? "complete" : "not_complete";
  const releaseNotes = status === "complete" ? await ports.releaseNotes(now) : undefined;
  // Commit'inamas release-evidence artefaktas regeneruojamas tik kai VISI kiti vartai žali —
  // jis visada deterministiškai išvedamas iš ką tik praėjusio commit'o, niekada neatsilieka.
  const releaseProof =
    status === "complete"
      ? await ports.releaseProof({
          finalAuditStatus: status,
          convergeStatus: checks.converge.ok ? "converged" : "issues",
          releaseCheckStatus: releaseCheck.status ?? "missing",
          architectureBoundaryStatus: architectureBoundary.ok
            ? `ok (baseline debt: ${architectureBoundary.baseline_violation_count})`
            : `${architectureBoundary.new_violation_count} new violation(s)`,
          benchmarkEvidenceStatus: benchmarkEvidence.describe,
          compressionQualityStatus: compressionQuality.describe,
          ...(releaseNotes?.path === undefined ? {} : { releaseNotesPath: releaseNotes.path }),
          now,
        })
      : undefined;
  const result: FinalAuditResult = {
    status,
    pending_tasks: pendingTasks,
    checks,
    ...(releaseNotes === undefined ? {} : { release_notes: releaseNotes }),
    ...(releaseProof === undefined ? {} : { release_proof: releaseProof }),
    report_path: "vq/state/final-audit-result.json",
    updated_at: now.toISOString(),
  };

  await ports.writeReport(result);
  return result;
}

// „Resolved" state-history įvykis uždaro human-review task'ą nejudinant jo failo, tad plikas
// katalogo sąrašas jį vis dar matytų kaip blokuojantį. Abu vartotojai (converge ir
// queue-empty) filtruoja per tą patį kelią, kad resolved taskai liktų audituojami
// nesulaikydami final audit.
async function unresolvedConvergeIssues(
  ports: FinalAuditPorts,
  issues: { kind: string; ref: string }[],
): Promise<{ kind: string; ref: string }[]> {
  const result: { kind: string; ref: string }[] = [];
  for (const issue of issues) {
    if (issue.kind !== "incomplete-work" || !issue.ref.startsWith("human-review/")) {
      result.push(issue);
      continue;
    }
    if (!(await ports.humanReviewResolved(taskFileStem(issue.ref)))) {
      result.push(issue);
    }
  }
  return result;
}

async function readPendingTasks(ports: FinalAuditPorts): Promise<Record<string, string[]>> {
  const result: Record<string, string[]> = {};
  for (const bucket of pendingBuckets) {
    const files = await ports.listBucketFiles(bucket);
    // Numeruoti lifecycle failai lieka autoritetingi. UI įkėlimai gali teisėtai turėti
    // nenumeruotą vardą, tad atpažįstami `# Task` dokumentai su tikslu irgi skaičiuojami;
    // pašalinės pastabos/README markdown užbaigimo vis tiek neblokuoja.
    const markdown: string[] = [];
    for (const entry of files) {
      if (!entry.name.toLowerCase().endsWith(".md")) continue;
      if (taskNumberFromFilename(entry.name) !== undefined) {
        markdown.push(entry.name);
        continue;
      }
      if (recognizeTask(entry.text)) markdown.push(entry.name);
    }
    markdown.sort();
    if (bucket === "human-review") {
      // Resolved human-review taskai lieka kataloge auditui, bet nebeblokuoja.
      const unresolved: string[] = [];
      for (const name of markdown) {
        if (!(await ports.humanReviewResolved(taskFileStem(name)))) unresolved.push(name);
      }
      markdown.splice(0, markdown.length, ...unresolved);
    }
    if (markdown.length > 0) result[bucket] = markdown;
  }
  return result;
}

async function releaseFreshness(
  ports: FinalAuditPorts,
  root: string,
  runtimeRoot: string,
  releaseCheck: ReleaseCheckState,
  sourceStateInputs?: SourceStateInputs,
): Promise<string[]> {
  const updatedAt = releaseCheck.updated_at;
  if (!updatedAt) return ["release-check-result has no updated_at"];
  const checkedAt = Date.parse(updatedAt);
  if (!Number.isFinite(checkedAt)) return ["release-check-result has invalid updated_at"];

  const issues: string[] = [];

  const ledgerMtime = await ports.newestMtime([
    path.join(runtimeRoot, "state", "task-ledger.json"),
    path.join(runtimeRoot, "project", "status.md"),
    path.join(runtimeRoot, "project", "next-tasks.md"),
  ]);
  if (ledgerMtime !== undefined && ledgerMtime > checkedAt) issues.push("release-check-result is stale: ledger");

  // OpenSpec ir bucket'ai VERQESTRA prižiūrimame projekte gyvena AG/ pusėje (etalono
  // sutartis nekeičiama); spec ir architecture — runtime šaknyje.
  const openspecMtime = await ports.newestMtimeInDir(path.join(root, "AG", "openspec", "changes"));
  if (openspecMtime !== undefined && openspecMtime > checkedAt) issues.push("release-check-result is stale: openspec");

  const specMtime = await ports.newestMtimeInDir(path.join(runtimeRoot, "spec", "changes"));
  if (specMtime !== undefined && specMtime > checkedAt) issues.push("release-check-result is stale: spec");

  const architectureMtime = await ports.newestMtimeInDir(path.join(runtimeRoot, "architecture"));
  if (architectureMtime !== undefined && architectureMtime > checkedAt) issues.push("release-check-result is stale: architecture");

  if (releaseCheck.source_state) {
    const currentSourceState = await computeSourceState(ports.sourceFs, root, sourceStateInputs);
    if (currentSourceState.hash !== releaseCheck.source_state.hash) issues.push("release-check-result is stale: source");
  } else {
    const sourceMtime = await ports.newestMtimeInDir(path.join(root, "src"));
    if (sourceMtime !== undefined && sourceMtime > checkedAt) issues.push("release-check-result is stale: source");
  }

  return issues;
}

function check(ok: boolean, issues: string[]): { ok: boolean; issues: string[] } {
  return { ok, issues: issues.sort() };
}

function pendingIssues(pending: Record<string, string[]>): string[] {
  return Object.entries(pending).flatMap(([bucket, files]) => files.map((file) => `${bucket}/${file}`));
}

async function checkRuleStatus(ports: FinalAuditPorts, runtimeRoot: string): Promise<string[]> {
  const issues: string[] = [];
  // Sėkmingai įkelti architecture-style ir coding-principles objektai pagaunami iš tų pačių
  // load kvietimų, kad gynybinei enforcement-level patikrai žemiau nereikėtų antro skaitymo.
  let architectureStylePolicy: ArchitectureStylePolicyConfig | undefined;
  let codingPrinciplesPolicy: CodingPrinciplesPolicy | undefined;
  const loaders: Array<{ name: string; load: () => Promise<unknown>; capture?: (value: unknown) => void }> = [
    {
      name: "architecture-style-policy",
      load: () => loadArchitectureStylePolicy(ports.policyFs, runtimeRoot),
      capture: (value) => {
        architectureStylePolicy = value as ArchitectureStylePolicyConfig;
      },
    },
    {
      name: "coding-principles-policy",
      load: () => loadCodingPrinciplesPolicy(ports.policyFs, runtimeRoot),
      capture: (value) => {
        codingPrinciplesPolicy = value as CodingPrinciplesPolicy;
      },
    },
    { name: "enforcement-policy", load: () => loadEnforcementPolicy(ports.policyFs, runtimeRoot) },
  ];
  for (const { name, load, capture } of loaders) {
    try {
      const value = await load();
      capture?.(value);
    } catch (error: unknown) {
      issues.push(`${name}:${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Gynyba gilyn: zod schema šiuos laukus jau riboja iki advisory/warn/block, bet final audit
  // pertikrina įkeltas reikšmes prieš tą patį ENFORCEMENT_LEVELS sąrašą, kad būsimas schemos
  // dreifas (ar passthrough laukas, apeinantis validaciją) vis tiek būtų pagautas.
  if (architectureStylePolicy && !isEnforcementLevel(architectureStylePolicy.strictness)) {
    issues.push(
      `architecture-style-policy:strictness not in [${ENFORCEMENT_LEVELS.join(", ")}]: ${String(architectureStylePolicy.strictness)}`,
    );
  }
  if (codingPrinciplesPolicy) {
    // Laukai iš katalogo: naujas principas į auditą patenka be atskiro sąrašo čia.
    for (const field of CODING_PRINCIPLE_IDS) {
      const value = codingPrinciplesPolicy[field];
      if (!isEnforcementLevel(value)) {
        issues.push(`coding-principles-policy:${field} not in [${ENFORCEMENT_LEVELS.join(", ")}]: ${String(value)}`);
      }
    }
  }

  try {
    const pendingCount = await ports.pendingProposalCount();
    if (pendingCount > 0) issues.push(`unresolved-proposal:${pendingCount}`);
  } catch (error: unknown) {
    issues.push(`policy-proposals:${error instanceof Error ? error.message : String(error)}`);
  }
  return issues;
}
