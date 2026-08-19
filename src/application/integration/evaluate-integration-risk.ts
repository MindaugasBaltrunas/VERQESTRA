// Deterministinis integracijos rizikos verdiktas (spec IVER-3, design §11 „Integration
// verifier"). Behaviour etalon: AG_loop application/integration/evaluate-integration-risk.ts
// (1:1; jautrumo taisyklės — domain/tasks/human-review, FQC-12).
//
// `contract-diff.ts` atsako, KOKIE kontraktai pasikeitė; `run-wave-gates.ts` — ar banga
// praeina mechanines patikras. Šis modulis atsako „ar šiam pokyčiui apskritai REIKIA
// semantinės (LLM) peržiūros" ir grąžina TRIS lygius:
//
//   - `routine`         — deterministinių įrodymų PAKANKA. LLM kviesti DRAUDŽIAMA.
//   - `review-required` — yra įrodyta rizika, kurios FORMOS analizė įvertinti negali.
//                         TIK šis lygis leidžia LLM kvietimą.
//   - `human-review`    — rizika, kurios automatinis patvirtinimas neleidžiamas iš principo.
//
// TRYS savybės, kurios čia yra taisyklė: (1) rizika išvedama TIK iš blokuojančių įrodymų —
// jautrus kelias pats savaime rizikos nekelia; (2) jautrumo taisyklės NEdubliuojamos —
// klasifikuoja kanoninė domain human-review aibė (`analyzeChangedPathGates`); (3) modulis
// GRYNAS — tie patys įėjimai visada duoda tą patį verdiktą ir tą patį `verdict_hash`.

import { createHash } from "node:crypto";
import { canonicalJsonStringify } from "../../shared/json.js";
import { toComparablePosixPath as toPosix } from "../../shared/paths.js";
import { analyzeChangedPathGates, type HumanReviewGateCategory } from "../../domain/tasks/index.js";
import type { ContractDiffEntry, ContractDiffReport } from "./contract-model.js";
import type { WaveGateReport } from "./wave-gates-schema.js";

/** Rizikos taisyklių versija. Įeina į `verdict_hash`, tad pakeitus taisykles seni verdiktai tampa stale. */
export const INTEGRATION_RISK_VERSION = 1;

export type IntegrationRiskLevel = "routine" | "review-required" | "human-review";

/** Lygiai, kuriuos gali priskirti signalas. `routine` yra signalų NEBUVIMAS, ne signalas. */
export type IntegrationRiskSignalLevel = Exclude<IntegrationRiskLevel, "routine">;

export type IntegrationRiskSignalCode =
  /** Pašalintas arba nesuderinamai pakeistas public kontraktas. */
  | "contract-break"
  /** Kontrakto suderinamumo įrodyti nebuvo iš ko (`unverified`). */
  | "contract-unverified"
  /** Blokuojantis pokytis liečia DB esybę ar migraciją. */
  | "db-contract"
  /** Nauja migracija turi destruktyvų teiginį. */
  | "destructive-migration"
  /** Blokuojantis pokytis liečia auth/permission/secret kelią. */
  | "security-contract"
  /** Pirmą kartą pasitaikęs bangos merge konfliktas. */
  | "merge-conflict"
  /** Tas pats konfliktas jau kartojasi — automatinis taisymas nekonverguoja. */
  | "repeated-conflict"
  /** Vienas kontrakto pokytis paliečia daugiau nei vieną modulį. */
  | "multi-module-contract";

export type IntegrationRiskSignal = {
  code: IntegrationRiskSignalCode;
  level: IntegrationRiskSignalLevel;
  /** Kodėl būtent šis signalas — konkretus, patikrinamas faktas. */
  detail: string;
  /** Kontraktų id, kelių ar vartų nuorodos, iš kurių signalas išvestas. */
  evidence: string[];
};

/**
 * Vienas bangos integracijos konfliktas. `id` yra TAPATYBĖ TARP BANDYMŲ: būtent iš jo
 * matyti, ar konfliktas kartojasi, ar kiekvieną kartą jis kitas.
 */
export type IntegrationConflict = {
  id: string;
  /** Repo-relative keliai (POSIX), kuriuose konfliktas realiai yra. */
  paths: readonly string[];
  /** Task'ai, kurių commit'ai susiduria. */
  tasks?: readonly string[];
  /** Kelintas kartas, kai šis konfliktas pasitaiko (1 = pirmas). */
  attempts?: number;
  summary?: string;
};

export type EvaluateIntegrationRiskInput = {
  contractDiff: ContractDiffReport;
  /** Bangos vartų raportas, jei jau paleistas. Jo nebuvimas rizikos savaime nekelia. */
  gates?: WaveGateReport;
  conflicts?: readonly IntegrationConflict[];
  /**
   * Kelias → jį valdantis modulis. Įrašo nebuvimas reiškia „modulis nežinomas", ir toks
   * kelias į multi-module skaičiavimą neįtraukiamas: nežinomybė negali virsti rizikos
   * įrodymu, kaip ir atvirkščiai.
   */
  modulesByPath?: Readonly<Record<string, string>>;
};

/** Peržiūros apimtis. Būtent ji riboja reviewer prompt'ą — už jos ribų konteksto nėra. */
export type IntegrationRiskFocus = {
  /** Blokuojančių kontraktų id. */
  contracts: string[];
  /** Keliai, kuriuose rizika įrodyta. */
  paths: string[];
  /** Tuos kelius valdantys moduliai. */
  modules: string[];
  /** Vartai, kurie nepraėjo (`failed` / `blocked` / `missing`). */
  failing_gates: string[];
  /** Konfliktų id. */
  conflicts: string[];
};

export type IntegrationRiskVerdict = {
  version: number;
  level: IntegrationRiskLevel;
  /** TIK `review-required` leidžia semantinį LLM kvietimą — tai IVER-3 kontraktas. */
  semantic_review_allowed: boolean;
  /** `human-review`: automatinis patvirtinimas draudžiamas nepriklausomai nuo peržiūros. */
  human_review_required: boolean;
  signals: IntegrationRiskSignal[];
  reasons: string[];
  focus: IntegrationRiskFocus;
  verdict_hash: string;
};

const LEVEL_RANK: Record<IntegrationRiskLevel, number> = {
  routine: 0,
  "review-required": 1,
  "human-review": 2,
};

function sorted(values: Iterable<string>): string[] {
  return [...new Set([...values].map((value) => value.trim()).filter(Boolean))].sort();
}

/** Kontrakto pokyčio paliesti keliai — abiejų revizijų įrodymai plius pati deklaracija. */
function entryPaths(entry: ContractDiffEntry): string[] {
  const paths = new Set<string>();
  for (const evidence of entry.evidence) paths.add(toPosix(evidence.path));
  if (entry.before) paths.add(toPosix(entry.before.path));
  if (entry.after) paths.add(toPosix(entry.after.path));
  return sorted(paths);
}

function isDestructiveMigration(entry: ContractDiffEntry): boolean {
  return entry.kind === "db-migration" && entry.reasons.some((reason) => /destructive/i.test(reason));
}

/** Nepraėję vartai. `skipped` čia nėra: jis reiškia „ankstesnis vartas jau lūžo", ne savą faktą. */
function failingGates(report: WaveGateReport | undefined): string[] {
  if (!report) return [];
  return sorted(
    report.gates.filter((gate) => ["failed", "blocked", "missing"].includes(gate.status)).map((gate) => gate.gate),
  );
}

function modulesOf(paths: readonly string[], modulesByPath: Readonly<Record<string, string>>): string[] {
  const modules = new Set<string>();
  for (const filePath of paths) {
    const owner = modulesByPath[filePath];
    if (owner && owner.trim()) modules.add(owner.trim());
  }
  return sorted(modules);
}

/**
 * Deterministinis rizikos verdiktas.
 *
 * Grąžinamas VISADA — sprendimą, ką su verdiktu daryti (kviesti reviewer'į, generuoti
 * repair'ą ar parkuoti į human-review), priima `review-integration.ts` ir RunCoordinator,
 * ne šis modulis. `level: "routine"` reiškia „semantinės peržiūros nereikia", o NE „banga
 * gera": lūžę vartai lieka `focus.failing_gates` ir juos tvarko targeted repair.
 */
export function evaluateIntegrationRisk(input: EvaluateIntegrationRiskInput): IntegrationRiskVerdict {
  const modulesByPath = input.modulesByPath ?? {};
  const conflicts = input.conflicts ?? [];
  const signals: IntegrationRiskSignal[] = [];

  const blockingEntries = input.contractDiff.blocking;
  const contractPaths = new Set<string>();
  for (const entry of blockingEntries) {
    for (const filePath of entryPaths(entry)) contractPaths.add(filePath);
  }
  const conflictPaths = new Set<string>();
  for (const conflict of conflicts) {
    for (const filePath of conflict.paths) {
      const normalized = toPosix(filePath);
      if (normalized) conflictPaths.add(normalized);
    }
  }
  const riskPaths = sorted([...contractPaths, ...conflictPaths]);

  // Savybė 2: kelio jautrumas klasifikuojamas kanonine human-review taisyklių aibe ir tik
  // TIEMS keliams, kurie jau yra blokuojančiame įrodyme (savybė 1).
  const sensitivity = analyzeChangedPathGates(riskPaths);
  const sensitiveByCategory = new Map<HumanReviewGateCategory, Set<string>>();
  for (const gate of sensitivity.gates) {
    const paths = new Set<string>();
    for (const evidence of gate.evidence) {
      if (evidence.startsWith("path:")) paths.add(evidence.slice("path:".length));
    }
    sensitiveByCategory.set(gate.category, paths);
  }

  /** Ar kelias pateko į konkrečios jautrios kategorijos įrodymus (be didžiųjų raidžių skirtumo). */
  function sensitivePathsOf(category: HumanReviewGateCategory, paths: readonly string[]): string[] {
    const flagged = sensitiveByCategory.get(category);
    if (!flagged) return [];
    return paths.filter((filePath) => flagged.has(filePath.toLowerCase()));
  }

  for (const entry of blockingEntries) {
    const paths = entryPaths(entry);
    const reason = entry.reasons[0] ?? entry.change;

    if (isDestructiveMigration(entry)) {
      signals.push({
        code: "destructive-migration",
        level: "human-review",
        detail: `destructive migration "${entry.id}" cannot be approved automatically`,
        evidence: [entry.id, ...paths],
      });
      continue;
    }

    if (entry.kind === "db-entity" || entry.kind === "db-migration") {
      signals.push({
        code: "db-contract",
        level: "human-review",
        detail: `database contract "${entry.id}" changed (${reason})`,
        evidence: [entry.id, ...paths],
      });
      continue;
    }

    const securityPaths = [
      ...sensitivePathsOf("security", paths),
      ...sensitivePathsOf("database", paths),
      ...sensitivePathsOf("destructive_data", paths),
    ];
    if (securityPaths.length > 0) {
      signals.push({
        code: "security-contract",
        level: "human-review",
        detail: `auth/permission-sensitive contract "${entry.id}" changed (${reason})`,
        evidence: sorted([entry.id, ...securityPaths]),
      });
      continue;
    }

    if (entry.breaking_risk === "unverified") {
      signals.push({
        code: "contract-unverified",
        level: "review-required",
        detail: `contract "${entry.id}" could not be proven compatible (${reason})`,
        evidence: sorted([entry.id, ...paths]),
      });
      continue;
    }

    signals.push({
      code: "contract-break",
      level: "review-required",
      detail: `public contract "${entry.id}" is breaking (${reason})`,
      evidence: sorted([entry.id, ...paths]),
    });
  }

  // Multi-module: vienas kontrakto pokytis, matomas keliuose moduliuose, yra būtent tas
  // atvejis, kurio formos analizė įvertinti negali — ji mato parašą, o ne vartotojų elgseną.
  for (const entry of blockingEntries) {
    const paths = entryPaths(entry);
    const modules = modulesOf(paths, modulesByPath);
    if (modules.length > 1) {
      signals.push({
        code: "multi-module-contract",
        level: "review-required",
        detail: `contract "${entry.id}" spans modules: ${modules.join(", ")}`,
        evidence: sorted([entry.id, ...modules]),
      });
    }
  }

  for (const conflict of conflicts) {
    const attempts = conflict.attempts ?? 1;
    const paths = sorted(conflict.paths.map(toPosix));
    if (attempts >= 2) {
      signals.push({
        code: "repeated-conflict",
        level: "human-review",
        detail: `conflict "${conflict.id}" repeated on attempt ${attempts} — automated repair is not converging`,
        evidence: sorted([conflict.id, ...paths, ...(conflict.tasks ?? [])]),
      });
      continue;
    }
    signals.push({
      code: "merge-conflict",
      level: "review-required",
      detail: conflict.summary?.trim()
        ? `conflict "${conflict.id}": ${conflict.summary.trim()}`
        : `conflict "${conflict.id}" between ${(conflict.tasks ?? []).join(", ") || "wave commits"}`,
      evidence: sorted([conflict.id, ...paths, ...(conflict.tasks ?? [])]),
    });
  }

  const level = signals.reduce<IntegrationRiskLevel>(
    (highest, signal) => (LEVEL_RANK[signal.level] > LEVEL_RANK[highest] ? signal.level : highest),
    "routine",
  );

  const focus: IntegrationRiskFocus = {
    contracts: sorted(blockingEntries.map((entry) => entry.id)),
    paths: riskPaths,
    modules: modulesOf(riskPaths, modulesByPath),
    failing_gates: failingGates(input.gates),
    conflicts: sorted(conflicts.map((conflict) => conflict.id)),
  };

  const reasons =
    signals.length > 0
      ? signals.map((signal) => `${signal.code}: ${signal.detail}`)
      : [
          focus.failing_gates.length > 0
            ? `deterministic gates are sufficient: failing gate(s) ${focus.failing_gates.join(", ")} have an exact address`
            : "no public API, DB, auth, conflict or multi-module evidence",
        ];

  const verdict: Omit<IntegrationRiskVerdict, "verdict_hash"> = {
    version: INTEGRATION_RISK_VERSION,
    level,
    semantic_review_allowed: level === "review-required",
    human_review_required: level === "human-review",
    signals,
    reasons,
    focus,
  };

  return { ...verdict, verdict_hash: computeIntegrationRiskHash(verdict) };
}

/**
 * Verdikto atspaudas. Hash'uojama tik tai, kas keičia SPRENDIMĄ — lygis, signalų kodai su
 * savo įrodymais ir apimtis. Formuluotės (`detail`, `reasons`) iš jų išvedamos, tad į
 * atspaudą neįeina: tas pats `verdict_hash` visada reiškia „tas pats sprendimas dėl LLM
 * kvietimo", o ne „ta pati formuluotė".
 */
export function computeIntegrationRiskHash(verdict: Omit<IntegrationRiskVerdict, "verdict_hash">): string {
  const payload = {
    version: verdict.version,
    level: verdict.level,
    signals: verdict.signals
      .map((signal) => ({ code: signal.code, level: signal.level, evidence: signal.evidence }))
      .sort((a, b) => a.code.localeCompare(b.code) || a.evidence.join().localeCompare(b.evidence.join())),
    focus: verdict.focus,
  };
  const digest = createHash("sha256").update(canonicalJsonStringify(payload), "utf8").digest("hex");
  return `ir${INTEGRATION_RISK_VERSION}:${digest.slice(0, 16)}`;
}
