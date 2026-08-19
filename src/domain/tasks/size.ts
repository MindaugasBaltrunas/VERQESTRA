// Task dydžio matavimo GRYNOS taisyklės: eilutės, path tokenai, scope domenai, veiksmo
// bullet'ai ir ribų patikra. Behaviour etalon: AG_loop orchestrator/tasks/task-size.ts
// (grynoji pusė; WBR VQ-302/304 — orchestrator/tasks dubliai jungiami į kanonines vietas).
// PreflightLimits konfigo IO — VQ-305; čia tik struktūrinis limitų vaizdas.

import { extractSection } from "../../shared/markdown.js";
import { allowedPaths } from "./allowed-paths.js";

export interface TaskSizeMetrics {
  /** task teksto eilučių skaičius */
  lines: number;
  /** `## Failai` → `Leidžiama:` skilties path/glob tokenų skaičius */
  allowedPaths: number;
  /** unikalūs scope domenai iš leidžiamų kelių (feature/module/package lygiu) */
  domains: number;
  /** `## Veiksmas` skilties bullet punktų skaičius */
  actionBullets: number;
  /** domenų vardai (diagnostikai / human_review priežasčiai) */
  domainNames: string[];
}

/** Struktūrinis limitų vaizdas — konfigo loader'is (E3 VQ-305) jį TENKINA. */
export type TaskSizeLimitsView = {
  maxLines: number;
  maxAllowedPaths: number;
  maxDomains: number;
  maxActionBullets: number;
};

/** True, kai tokenas atrodo kaip kelias/glob: turi `/`, `**` arba `*.ext` glob. */
function isPathShapedToken(token: string): boolean {
  return /\/|\*\*|\*\.[A-Za-z0-9]+/.test(token);
}

function escapeRegExpLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Normalizes a profile source root for prefix matching: backslashes, `./`, and a trailing slash. */
function normalizeSourceRoot(root: string): string {
  return root
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "")
    .trim();
}

/**
 * One-level-deeper domain match against a project profile's `source_roots` (task 888): a path
 * under `<root>/<segment>...` collapses to `<root>/<segment>`, mirroring the granularity of
 * the legacy `modules/<x>`/`packages/<x>`/`workers/<x>` patterns below but generalized to
 * whatever roots the profile declares. Longest root first so a more specific configured root
 * wins over a shorter one that is also a prefix of it.
 */
function matchProfileSourceRoot(norm: string, sourceRoots: string[]): string | undefined {
  const roots = sourceRoots
    .map(normalizeSourceRoot)
    .filter((root) => root.length > 0)
    .sort((a, b) => b.length - a.length);
  for (const root of roots) {
    const match = norm.match(new RegExp(`^(${escapeRegExpLiteral(root)}/[^/]+)`));
    if (match) {
      return match[1];
    }
  }
  return undefined;
}

/**
 * Iš kelio nustato scope domeną. Granuliarumas atitinka izoliuotą darbo vienetą:
 * apps feature, modulis, paketas, worker arba AG/orchestrator. `logs/` ir kiti
 * meta keliai domenu nelaikomi.
 *
 * Legacy `apps/modules/packages/workers/AG orchestrator` konvencija tikrinama PIRMA ir
 * visada — tai išlaiko pnpm triados (ir AG-formos target'ų) elgesį nepakitusį. Kai
 * konvencija neatpažįsta kelio, `sourceRoots` (projekto profilio `source_roots`, task 888)
 * suteikia bendrą alternatyvą prieš krentant į pirmojo segmento fallback'ą.
 */
export function extractDomain(rawPath: string, sourceRoots?: string[]): string | undefined {
  const norm = rawPath
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^`+|`+$/g, "")
    .trim();
  if (!norm) {
    return undefined;
  }

  let match: RegExpMatchArray | null;
  if ((match = norm.match(/^(apps\/[^/]+)\/src\/features\/([^/*]+)/))) {
    return `${match[1]}/features/${match[2]}`;
  }
  if ((match = norm.match(/^(apps\/[^/]+)/))) {
    return match[1];
  }
  if ((match = norm.match(/^(modules\/[^/]+)/))) {
    return match[1];
  }
  if ((match = norm.match(/^(packages\/[^/]+)/))) {
    return match[1];
  }
  if ((match = norm.match(/^(workers\/[^/]+)/))) {
    return match[1];
  }
  if ((match = norm.match(/^(AG\/orchestrator)/))) {
    return match[1];
  }

  if (sourceRoots && sourceRoots.length > 0) {
    const profileMatch = matchProfileSourceRoot(norm, sourceRoots);
    if (profileMatch) {
      return profileMatch;
    }
  }

  const first = norm.split("/")[0];
  // Meta/infra keliai (visada būna užduotyse) — ne darbo domenas.
  if (!first || first === "logs" || first === "AG" || first === "doc" || first === "openspec") {
    return undefined;
  }
  return first;
}

/** Deterministiškai išmatuoja task dydį iš jo MD teksto. `sourceRoots` — žr. {@link extractDomain}. */
export function measureTaskSize(taskText: string, sourceRoots?: string[]): TaskSizeMetrics {
  const text = taskText ?? "";
  const lines = text.split(/\r?\n/).length;

  // Dydžio metrikai skaičiuojami TIK path-formos tokenai: plėtinio neturintys bazinio
  // lygio vardai (pvz. `Dockerfile`) sąmoningai neįskaitomi, kad size/domain gate
  // nesugriežtėtų. Įtraukimą į ribą tvarko `allowedPaths` (žr. jo komentarą).
  const pathTokens = allowedPaths(text).filter(isPathShapedToken);

  const domainSet = new Set<string>();
  for (const token of pathTokens) {
    const domain = extractDomain(token, sourceRoots);
    if (domain) {
      domainSet.add(domain);
    }
  }

  const veiksmas = extractSection(text, "## Veiksmas");
  const actionBullets = veiksmas.split(/\r?\n/).filter((line) => /^\s*[-*]\s+\S/.test(line)).length;

  return {
    lines,
    allowedPaths: pathTokens.length,
    domains: domainSet.size,
    actionBullets,
    domainNames: Array.from(domainSet),
  };
}

/** Grąžina žmogiškai skaitomus pažeidimus; tuščias masyvas = po ribomis. */
export function exceedsLimits(metrics: TaskSizeMetrics, limits: TaskSizeLimitsView): string[] {
  const violations: string[] = [];
  if (metrics.lines > limits.maxLines) {
    violations.push(`lines ${metrics.lines} > ${limits.maxLines}`);
  }
  if (metrics.allowedPaths > limits.maxAllowedPaths) {
    violations.push(`allowed paths ${metrics.allowedPaths} > ${limits.maxAllowedPaths}`);
  }
  if (metrics.domains > limits.maxDomains) {
    violations.push(`domains ${metrics.domains} > ${limits.maxDomains} (${metrics.domainNames.join(", ")})`);
  }
  if (metrics.actionBullets > limits.maxActionBullets) {
    violations.push(`action bullets ${metrics.actionBullets} > ${limits.maxActionBullets}`);
  }
  return violations;
}

export interface TaskSizeValidation {
  ok: boolean;
  metrics: TaskSizeMetrics;
  violations: string[];
}

/** Vienas struktūruotas API preflight/task generation vartotojams. */
export function validateTaskSize(
  taskText: string,
  limits: TaskSizeLimitsView,
  sourceRoots?: string[],
): TaskSizeValidation {
  const metrics = measureTaskSize(taskText, sourceRoots);
  const violations = exceedsLimits(metrics, limits);
  return {
    ok: violations.length === 0,
    metrics,
    violations,
  };
}
