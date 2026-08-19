// Wave integration plan (spec IVER-1/IVER-2, design §11 „Integration verifier").
// Behaviour etalon: AG_loop application/integration/create-integration-plan.ts (1:1;
// glob matcher — kanoninis domain/tasks/allowed-paths#matchesAllowedPath, FQC-12 — etalone
// tai buvo pažodinė kopija su „privalo keistis kartu" komentaru).
//
// `IntegrationPlan` yra tarpinis artefaktas tarp „task'o darbas baigtas" ir „darbas
// pagrindinėje šakoje": aiški, hash'uojama vertė, kuri sako KURIE commit'ai, KOKIA tvarka
// ir ant KOKIO base head'o sudaro bangos integraciją, kokios jų leistinos ribos ir kokia
// rizika. Planas sudaromas ir validuojamas PRIEŠ liečiant bet kokį git ref'ą; realų
// branch'ą iš jo sukuria E4 infrastruktūra.
//
// Modulis GRYNAS — jokio FS, git, laikrodžio ar atsitiktinumo. Visi git faktai (commit
// egzistavimas, dirty medis, branch head) yra APPLY laiko tiesa ir tikrinami
// infrastruktūroje; čia tikrinama tik tai, ką galima įrodyti iš pačių duomenų.

import { createHash } from "node:crypto";
import { canonicalJsonStringify } from "../../shared/json.js";
import { toComparablePosixPath as toPosix } from "../../shared/paths.js";
import { matchesAllowedPath, normalizeTaskReference } from "../../domain/tasks/index.js";
import {
  dependenciesOf,
  resolveTaskNode,
  satisfiesDependency,
  taskGraphDepths,
  type TaskGraph,
} from "../../domain/tasks/graph/index.js";

/** Plano formato versija. Įeina į `plan_hash`, tad pakeitus taisykles seni planai tampa stale. */
export const INTEGRATION_PLAN_VERSION = 1;

/** Visų integration branch'ų vardų prefiksas — vienintelė vieta, kur jis apibrėžtas. */
export const INTEGRATION_BRANCH_PREFIX = "ag/integration";

export type IntegrationCommitInput = {
  sha: string;
  /** Commit'o paliesti repo-relative keliai (POSIX). Tušti = scope patikra neįmanoma. */
  files?: readonly string[];
  /** Commit'o antraštė — tik diagnostikai ir integracinio commit'o žinutei. */
  subject?: string;
};

export type IntegrationTaskResult = {
  task_id: string;
  /** Task'o commit'ai autorystės tvarka (seniausias pirmas) — kaip `git log --reverse`. */
  commits: readonly IntegrationCommitInput[];
  /** Leistini keliai iš task'o `## Failai`. Kai nenurodyta — imamas grafo mazgo `scope`. */
  scope?: readonly string[];
};

export type CreateIntegrationPlanInput = {
  /** Run identifikatorius (branch'o vardo dalis). */
  runId: string;
  /** Bangos ID iš scheduler'io (`WavePlan.wave_id`). */
  waveId: string;
  /** Kanoninis task grafas — tvarkos ir priklausomybių šaltinis. */
  graph: TaskGraph;
  /** Commit SHA, ant kurio planas taikomas (pagrindinės šakos head plano metu). */
  baseHead: string;
  /** Pagrindinės šakos vardas, jei žinomas — apply metu naudojamas stale-base patikrai. */
  baseBranch?: string;
  results: readonly IntegrationTaskResult[];
  /**
   * Ne-runtime dirty keliai plano metu (jau išfiltruoti kvietėjo). Netušti = bangoje yra
   * neužcommitinto darbo, kurio planas neaprašo, todėl integracija patikrintų nepilną rinkinį.
   */
  dirtyPaths?: readonly string[];
};

export type IntegrationPlanViolationCode =
  /** Rezultatas nurodo task'ą, kurio kanoniniame grafe nėra — planas remtųsi spėjimu. */
  | "unknown-task"
  /** Task'as neturi nė vieno commit'o — nėra ką integruoti, bet banga jį laiko užbaigtu. */
  | "missing-commit"
  /** SHA nėra git objekto forma (40/64 hex). */
  | "invalid-commit-sha"
  /** Tas pats commit'as deklaruotas du kartus (to paties ar skirtingų task'ų). */
  | "duplicate-commit"
  /** Commit'as palietė failą už task'o leistinų kelių ribos. */
  | "out-of-scope-path"
  /** Task'as neturi leistinų kelių — scope patikra neįmanoma. */
  | "missing-scope"
  /** Commit'o failų sąrašas nežinomas — scope patikra neįmanoma. */
  | "unknown-commit-files"
  /** Integruojamo task'o blokatorius nėra nei šioje bangoje, nei `done`. */
  | "unsatisfied-dependency"
  /** Plano metu medyje yra neužcommitinto produkto darbo. */
  | "dirty-worktree"
  /** `baseHead` nėra commit SHA forma. */
  | "invalid-base-head"
  /** Bangoje nėra nė vieno integruotino commit'o. */
  | "empty-wave";

export type IntegrationPlanViolation = {
  code: IntegrationPlanViolationCode;
  severity: "error" | "warning";
  task_id?: string;
  sha?: string;
  paths?: string[];
  message: string;
};

export type IntegrationCommit = {
  task_id: string;
  sha: string;
  /** Eilės numeris plane (1-based) — deterministinė apply tvarka. */
  order: number;
  files: string[];
  subject?: string;
};

/** Rizikos požymis, dėl kurio banga negali būti laikoma rutinine. */
export type PlanRiskSignal =
  /** Public kontraktas: barrel'as, SDK, eksportuojama schema. */
  | "public-contract"
  /** DB schema arba migracija. */
  | "database-migration"
  /** Auth, rolės, leidimai, secret'ai, saugumo politika. */
  | "auth-security"
  /** Dependency manifestas arba lockfile. */
  | "dependency-manifest"
  /** Generuojamas artefaktas, kuris neturėtų būti redaguojamas ranka. */
  | "generated-artifact"
  /** Guard'ų / politikų konfigūracija — keičia pačių vartų elgseną. */
  | "policy-config";

export type PlanRiskEvidence = {
  signal: PlanRiskSignal;
  /** Konkretūs keliai, kurie požymį sukėlė — įrodymas, ne spėjimas. */
  paths: string[];
};

/**
 * `review-required` yra VIENINTELIS verdiktas, leidžiantis semantinę LLM peržiūrą (IVER-3).
 * Jis kyla tik iš įrodytų kelių, todėl rutininis pakeitimas jos niekada negauna.
 */
export type PlanRisk = {
  verdict: "routine" | "review-required";
  signals: PlanRiskEvidence[];
};

export type IntegrationPlan = {
  plan_version: number;
  run_id: string;
  wave_id: string;
  /** `ag/integration/<run-id>/<wave-id>` — izoliuota šaka, į kurią taikomas planas. */
  branch: string;
  base_head: string;
  /** Pagrindinė šaka, jei žinoma; tuščia reiškia „apply metu paimk dabartinę". */
  base_branch: string;
  /** Deterministinė commit'ų tvarka: pirma seklesni grafo mazgai, tada task ID, tada autorystė. */
  commits: IntegrationCommit[];
  /** Visų bangos task'ų leistinų kelių sąjunga — plano ribų įrodymas. */
  allowed_paths: string[];
  risk: PlanRisk;
  violations: IntegrationPlanViolation[];
  /** `true`, kai nėra nė vienos error-severity klaidos: planą LEIDŽIAMA taikyti. */
  ok: boolean;
  /** Turinio atspaudas: tas pats planas → tas pats hash. */
  plan_hash: string;
};

const COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

/**
 * Git ref'ui saugus vardo segmentas: leidžiami tik `[A-Za-z0-9._-]`, be pradinių/galinių
 * taškų ir brūkšnių, be `..` ir be `.lock` galūnės (git-check-ref-format taisyklės).
 * Segmentas, iš kurio nelieka nieko, virsta `x` — branch'as visada turi vardą.
 */
export function sanitizeRefSegment(value: string): string {
  const cleaned = (value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/-{2,}/g, "-")
    .replace(/^[.-]+/, "")
    .replace(/[.-]+$/, "")
    .replace(/\.lock$/i, "lock");
  return cleaned || "x";
}

/** Kanoninis bangos integration branch'o vardas. Vienintelė vieta, kur jis sudaromas. */
export function integrationBranchName(runId: string, waveId: string): string {
  return `${INTEGRATION_BRANCH_PREFIX}/${sanitizeRefSegment(runId)}/${sanitizeRefSegment(waveId)}`;
}

/** `true`, kai vardas yra šio prefikso integration branch'as ir atitinka git ref formatą. */
export function isIntegrationBranchName(name: string): boolean {
  if (!name.startsWith(`${INTEGRATION_BRANCH_PREFIX}/`)) return false;
  const segments = name.split("/");
  if (segments.length !== 4) return false;
  return segments.every((segment) => segment.length > 0 && segment === sanitizeRefSegment(segment));
}

/** Ar kelias telpa į leistinų kelių rinkinį (kanoninis domain matcher'is, FQC-12). */
export function isPathInScope(filePath: string, scope: readonly string[]): boolean {
  const file = toPosix(filePath);
  return scope.some((allowed) => matchesAllowedPath(file, toPosix(allowed)));
}

/**
 * Rizikos požymių taisyklės. Kiekviena yra kelio forma, o ne spėjimas apie turinį —
 * verdiktas privalo būti atkuriamas iš to paties failų sąrašo bet kada.
 */
const RISK_RULES: ReadonlyArray<{ signal: PlanRiskSignal; test: (file: string) => boolean }> = [
  {
    signal: "database-migration",
    test: (file) => /(^|\/)(migrations?|prisma)\//i.test(file) || /\.(sql|prisma)$/i.test(file),
  },
  {
    signal: "auth-security",
    test: (file) => /(^|\/)(auth|security|rbac|permissions?|secrets?)([./-]|\/)/i.test(file),
  },
  {
    signal: "dependency-manifest",
    test: (file) => /(^|\/)(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lock)$/i.test(file),
  },
  {
    signal: "generated-artifact",
    test: (file) => /(^|\/)generated\//i.test(file) || /\.generated\.[A-Za-z0-9]+$/i.test(file),
  },
  {
    signal: "policy-config",
    test: (file) => /(^|\/)(policy|policies)\//i.test(file) || /(^|\/)(write-policy|bash-policy)\.ts$/i.test(file),
  },
  {
    signal: "public-contract",
    test: (file) => /(^|\/)(index\.ts|schema\.ts|contracts?\.ts)$/i.test(file) || /(^|\/)(sdk|api)\//i.test(file),
  },
];

/**
 * Rizikos įrodymai iš bangos paliestų kelių. Verdiktas `review-required` reiškia TIK tai,
 * kad gilesnė (galimai semantinė) peržiūra yra leidžiama — ne tai, kad banga blokuojama.
 */
export function assessIntegrationRisk(files: readonly string[]): PlanRisk {
  const bySignal = new Map<PlanRiskSignal, Set<string>>();
  for (const rawFile of files) {
    const file = toPosix(rawFile);
    if (!file) continue;
    for (const rule of RISK_RULES) {
      if (!rule.test(file)) continue;
      const bucket = bySignal.get(rule.signal) ?? new Set<string>();
      bucket.add(file);
      bySignal.set(rule.signal, bucket);
    }
  }

  const signals = [...bySignal.entries()]
    .map(([signal, paths]) => ({ signal, paths: [...paths].sort() }))
    .sort((a, b) => a.signal.localeCompare(b.signal));

  return { verdict: signals.length > 0 ? "review-required" : "routine", signals };
}

function violation(
  code: IntegrationPlanViolationCode,
  severity: "error" | "warning",
  message: string,
  detail: Pick<IntegrationPlanViolation, "task_id" | "sha" | "paths"> = {},
): IntegrationPlanViolation {
  return { code, severity, message, ...detail };
}

type ResolvedResult = {
  task_id: string;
  depth: number;
  scope: string[];
  commits: readonly IntegrationCommitInput[];
};

/**
 * Bangos task'ai deterministine tvarka. Raktas tas pats, kurį naudoja ready set
 * (`application/scheduling/build-ready-set.ts`): pirma grafo gylis (blokatorius visada
 * anksčiau už priklausinį), tada task ID.
 */
function resolveResults(input: CreateIntegrationPlanInput, violations: IntegrationPlanViolation[]): ResolvedResult[] {
  const depths = taskGraphDepths(input.graph);
  const resolved: ResolvedResult[] = [];

  for (const result of input.results) {
    const reference = normalizeTaskReference(result.task_id);
    const node = reference ? resolveTaskNode(input.graph, reference) : undefined;
    if (!node) {
      violations.push(
        violation("unknown-task", "error", `integration result references task ${result.task_id || "<empty>"}, which is not in the graph`, {
          task_id: result.task_id,
        }),
      );
      continue;
    }

    const scope = [...new Set([...(result.scope ?? node.scope)].map((value) => toPosix(value)).filter(Boolean))].sort();
    if (scope.length === 0) {
      violations.push(
        violation("missing-scope", "error", `task ${node.task_id} declares no allowed paths, so its commits cannot be scope-checked`, {
          task_id: node.task_id,
        }),
      );
    }

    resolved.push({
      task_id: node.task_id,
      depth: depths.get(node.task_id) ?? 0,
      scope,
      commits: result.commits ?? [],
    });
  }

  return resolved.sort((a, b) => a.depth - b.depth || a.task_id.localeCompare(b.task_id));
}

/**
 * Priklausomybių patikra bangos ribose: kiekvienas integruojamo task'o blokatorius privalo
 * būti arba TOJE PAČIOJE bangoje (tada tvarka jį garantuoja), arba grafe pažymėtas `done`.
 * Blokatorius, kuris nėra nei viena, nei kita, reiškia, kad į pagrindinę šaką keliautų
 * darbas, kurio prielaida dar neįrodyta — todėl tai error, o ne įspėjimas.
 */
function checkDependencies(
  input: CreateIntegrationPlanInput,
  resolved: readonly ResolvedResult[],
  violations: IntegrationPlanViolation[],
): void {
  const inWave = new Set(resolved.map((entry) => entry.task_id));
  for (const entry of resolved) {
    for (const reference of dependenciesOf(input.graph, entry.task_id)) {
      const blocker = resolveTaskNode(input.graph, reference);
      if (blocker && (inWave.has(blocker.task_id) || satisfiesDependency(blocker.status))) continue;
      violations.push(
        violation(
          "unsatisfied-dependency",
          "error",
          `task ${entry.task_id} depends on ${reference}, which is neither in this wave nor done`,
          { task_id: entry.task_id },
        ),
      );
    }
  }
}

/**
 * Sudaro ir iškart validuoja bangos integracijos planą.
 *
 * Vartai taikomi griežta tvarka, ir tvarka yra taisyklė: (1) base head forma; (2) dirty
 * medis; (3) task'ų atpažinimas grafe ir jų scope; (4) priklausomybės bangos ribose;
 * (5) commit'ai — forma, dublikatai, failų žinomumas ir scope; (6) tuščia banga.
 *
 * Nė vienas radinys neužtildomas ir niekas nėra „pataisoma spėjant": planas grąžinamas
 * VISADA, su pilnu pažeidimų sąrašu, o `ok` pasako, ar jį leidžiama taikyti.
 */
export function createIntegrationPlan(input: CreateIntegrationPlanInput): IntegrationPlan {
  const violations: IntegrationPlanViolation[] = [];
  const baseHead = (input.baseHead ?? "").trim().toLowerCase();

  if (!COMMIT_SHA.test(baseHead)) {
    violations.push(violation("invalid-base-head", "error", `integration base head is not a commit SHA: ${input.baseHead || "<empty>"}`));
  }

  const dirtyPaths = [...new Set((input.dirtyPaths ?? []).map((value) => toPosix(value)).filter(Boolean))].sort();
  if (dirtyPaths.length > 0) {
    violations.push(
      violation("dirty-worktree", "error", `worktree has ${dirtyPaths.length} uncommitted product path(s) not described by the plan`, {
        paths: dirtyPaths,
      }),
    );
  }

  const resolved = resolveResults(input, violations);
  checkDependencies(input, resolved, violations);

  const commits: IntegrationCommit[] = [];
  const allowedPaths = new Set<string>();
  const seenSha = new Set<string>();

  for (const entry of resolved) {
    for (const allowed of entry.scope) allowedPaths.add(allowed);

    if (entry.commits.length === 0) {
      violations.push(
        violation("missing-commit", "error", `task ${entry.task_id} is part of the wave but produced no commit to integrate`, {
          task_id: entry.task_id,
        }),
      );
      continue;
    }

    for (const commit of entry.commits) {
      const sha = (commit.sha ?? "").trim().toLowerCase();
      if (!COMMIT_SHA.test(sha)) {
        violations.push(
          violation("invalid-commit-sha", "error", `task ${entry.task_id} declares an invalid commit SHA: ${commit.sha || "<empty>"}`, {
            task_id: entry.task_id,
            sha: commit.sha,
          }),
        );
        continue;
      }
      if (seenSha.has(sha)) {
        violations.push(
          violation("duplicate-commit", "error", `commit ${sha} is declared more than once in this wave`, {
            task_id: entry.task_id,
            sha,
          }),
        );
        continue;
      }
      seenSha.add(sha);

      const files = [...new Set((commit.files ?? []).map((file) => toPosix(file)).filter(Boolean))].sort();
      if (commit.files === undefined) {
        violations.push(
          violation("unknown-commit-files", "error", `commit ${sha} of task ${entry.task_id} has no file list, so its scope cannot be verified`, {
            task_id: entry.task_id,
            sha,
          }),
        );
      } else if (entry.scope.length > 0) {
        const outside = files.filter((file) => !isPathInScope(file, entry.scope));
        if (outside.length > 0) {
          violations.push(
            violation("out-of-scope-path", "error", `commit ${sha} of task ${entry.task_id} touches paths outside its allowed scope`, {
              task_id: entry.task_id,
              sha,
              paths: outside,
            }),
          );
        }
      }

      commits.push({
        task_id: entry.task_id,
        sha,
        order: commits.length + 1,
        files,
        ...(commit.subject === undefined ? {} : { subject: commit.subject.trim() }),
      });
    }
  }

  if (commits.length === 0) {
    violations.push(violation("empty-wave", "error", "integration plan has no commits to apply"));
  }

  const plan: Omit<IntegrationPlan, "plan_hash"> = {
    plan_version: INTEGRATION_PLAN_VERSION,
    run_id: input.runId,
    wave_id: input.waveId,
    branch: integrationBranchName(input.runId, input.waveId),
    base_head: baseHead,
    base_branch: (input.baseBranch ?? "").trim(),
    commits,
    allowed_paths: [...allowedPaths].sort(),
    risk: assessIntegrationRisk(commits.flatMap((commit) => commit.files)),
    violations,
    ok: !violations.some((entry) => entry.severity === "error"),
  };

  return { ...plan, plan_hash: computeIntegrationPlanHash(plan) };
}

/**
 * Plano atspaudas. Hash'uojama tik tai, kas keičia APPLY rezultatą — šaka, base, commit'ų
 * tvarka ir ribos. Pažeidimai ir rizikos verdiktas iš jų išvedami, todėl į atspaudą
 * neįeina: tas pats `plan_hash` visada reiškia „tas pats taikymas".
 */
export function computeIntegrationPlanHash(plan: Omit<IntegrationPlan, "plan_hash">): string {
  const payload = {
    version: plan.plan_version,
    branch: plan.branch,
    base: plan.base_head,
    commits: plan.commits.map((commit) => ({ order: commit.order, task: commit.task_id, sha: commit.sha, files: commit.files })),
    allowed: plan.allowed_paths,
  };
  const digest = createHash("sha256").update(canonicalJsonStringify(payload), "utf8").digest("hex");
  return `ip${INTEGRATION_PLAN_VERSION}:${digest.slice(0, 16)}`;
}
