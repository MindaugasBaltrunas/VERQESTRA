// Stack sprendimo matrica — deterministinis StackDecision iš StackSignals. Pure: no I/O,
// no randomness, no clock. Behaviour etalon: AG_loop policy/stack-decision-matrix.ts;
// zod validacija pakeista grynu objekto surinkimu (visi laukai visada užpildomi — R2:
// vėlesnio sluoksnio schema šį rezultatą TENKINA, ne apibrėžia).

import {
  evaluateStackHumanReview,
  stackSignalsToInputSignals,
  type StackDecision,
  type StackDecisionAlternative,
  type StackDecisionConfidence,
  type StackSignals,
} from "./stack-decision.js";

/** Explicit stack choice supplied by a caller; any field left `undefined` is inferred instead. */
export type ExplicitStackChoice = {
  language?: string | null;
  framework?: string | null;
  architectureStyle?: string;
};

type InferredCore = {
  language: string | null;
  framework: string | null;
  architectureStyle: string;
  confidence: StackDecisionConfidence;
  reason: string;
};

const CATEGORY_PRIORITY = ["data", "api", "ui", "integration"] as const;
type Category = (typeof CATEGORY_PRIORITY)[number];

// PC-ARCH-01: vienintelis architektūros stilių vokabuliaro tiesos šaltinis. Konfigo
// `style` reikšmė privalo likti šiame sąraše; paritetą saugo testas, ne schema enum'as.
export const KNOWN_STYLES = ["clean_architecture", "hexagonal", "layered", "modular-feature", "pipeline"] as const;

const CONFIDENCE_RANK: Record<StackDecisionConfidence, number> = { low: 0, medium: 1, high: 2 };

function lowerConfidence(a: StackDecisionConfidence, b: StackDecisionConfidence): StackDecisionConfidence {
  return CONFIDENCE_RANK[a] <= CONFIDENCE_RANK[b] ? a : b;
}

function isNonEmpty(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

/** Dominuojanti kategorija su fiksuota tie-break tvarka (data > api > ui > integration). */
function dominantCategory(counts: Record<Category, number>): Category {
  let winner: Category = CATEGORY_PRIORITY[0];
  for (const category of CATEGORY_PRIORITY) {
    if (counts[category] > counts[winner]) {
      winner = category;
    }
  }
  return winner;
}

/** Near-tie downgrade: kuri nors kita ui/api/data kategorija yra per 1 nuo laimėtojos. */
function hasNearTie(counts: { ui: number; api: number; data: number }, winnerCategory: "ui" | "api" | "data"): boolean {
  const winnerCount = counts[winnerCategory];
  const runnerUps = (["ui", "api", "data"] as const)
    .filter((category) => category !== winnerCategory)
    .map((category) => counts[category]);
  return runnerUps.some((count) => winnerCount - count <= 1);
}

function inferCore(signals: StackSignals): InferredCore {
  const uiCount = signals.uiNodeIds.length;
  const apiCount = signals.apiNodeIds.length;
  const dataCount = signals.dataNodeIds.length;
  const integrationCount = signals.integrationNodeIds.length;

  // worker-only teisėtai aptinkamas nepriklausomai nuo kategorijų masyvų, tad visų
  // tuščios kategorijos jam nėra nepakankamo signalo ženklas.
  const allEmpty =
    signals.appType !== "worker-only" && uiCount === 0 && apiCount === 0 && dataCount === 0 && integrationCount === 0;

  if (signals.appType === "unknown" || signals.complexity.nodeCount === 0 || allEmpty) {
    return {
      language: null,
      framework: null,
      architectureStyle: "layered",
      confidence: "low",
      reason:
        "Insufficient signals to determine app type or dominant node category; defaulting to layered style with no language/framework pick.",
    };
  }

  const counts: Record<Category, number> = { data: dataCount, api: apiCount, ui: uiCount, integration: integrationCount };
  const winner = dominantCategory(counts);
  const dataIsStrictMax = winner === "data" && dataCount > uiCount && dataCount > apiCount && dataCount >= 2;

  if (dataIsStrictMax) {
    return {
      language: "typescript",
      framework: "node",
      architectureStyle: "pipeline",
      confidence: "medium",
      reason: `Data nodes dominate the graph (${dataCount} data nodes vs ${uiCount} UI / ${apiCount} API); defaulting to a TypeScript/Node pipeline style with explicit storage boundaries.`,
    };
  }

  const highComplexityCondition = signals.complexity.level !== "high";
  const categoryCounts = { ui: uiCount, api: apiCount, data: dataCount };

  switch (signals.appType) {
    case "ui-only": {
      const highEligible = uiCount > 0 && highComplexityCondition;
      const nearTie = hasNearTie(categoryCounts, "ui");
      const confidence: StackDecisionConfidence = highEligible && !nearTie ? "high" : "medium";
      return {
        language: "typescript",
        framework: "vite-react",
        architectureStyle: "modular-feature",
        confidence,
        reason: `UI-only app type with ${uiCount} UI nodes; defaulting to Vite+React modular-feature style.`,
      };
    }
    case "api-only": {
      const highEligible = apiCount > 0 && highComplexityCondition;
      const nearTie = hasNearTie(categoryCounts, "api");
      const confidence: StackDecisionConfidence = highEligible && !nearTie ? "high" : "medium";
      return {
        language: "typescript",
        framework: "node",
        architectureStyle: "layered",
        confidence,
        reason: `API-only app type with ${apiCount} API nodes; defaulting to TypeScript/Node layered style.`,
      };
    }
    case "worker-only": {
      const highEligible = highComplexityCondition;
      const nearTie = hasNearTie(categoryCounts, "data");
      const confidence: StackDecisionConfidence = highEligible && !nearTie ? "high" : "medium";
      return {
        language: "typescript",
        framework: "node",
        architectureStyle: "hexagonal",
        confidence,
        reason: "Worker-only app type detected; defaulting to TypeScript/Node hexagonal style.",
      };
    }
    case "fullstack":
    default:
      return {
        language: "typescript",
        framework: "vite-react+node",
        architectureStyle: "modular-feature",
        confidence: "medium",
        reason: `Fullstack app type combining ${uiCount} UI and ${apiCount} API nodes; defaulting to Vite+React and Node modular-feature style (combined signals are inherently less certain).`,
      };
  }
}

function buildAlternatives(selectedStyle: string): StackDecisionAlternative[] {
  return KNOWN_STYLES.filter((style) => style !== selectedStyle)
    .map((style) => ({
      label: style,
      reason: `Not selected: ${style} was not the best match for the observed signals.`,
      confidence: "low" as const,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Deterministinis StackDecision iš StackSignals: eksplicitiniai laukai išsaugomi
 * pažodžiui, tik praleisti — išvedami iš lentelės; `humanReviewRequired` — per gryną
 * {@link evaluateStackHumanReview}.
 */
export function deriveStackDecision(signals: StackSignals, explicit?: ExplicitStackChoice): StackDecision {
  const inputSignals = stackSignalsToInputSignals(signals);
  const inferred = inferCore(signals);

  const hasLanguage = explicit !== undefined && explicit.language !== undefined;
  const hasFramework = explicit !== undefined && explicit.framework !== undefined;
  const hasStyle = explicit !== undefined && isNonEmpty(explicit.architectureStyle);

  if (hasLanguage && hasFramework && hasStyle) {
    // Pilnai eksplicitinis pasirinkimas autoritetingas: nieko neišvedama, konflikto nėra;
    // rizikos/deployment/kompleksikos vartai galioja toliau.
    const humanReviewRequired = evaluateStackHumanReview(signals, {
      confidence: "high",
      explicitConflictsWithInferred: false,
    });
    return {
      selectedLanguage: explicit.language ?? null,
      selectedFramework: explicit.framework ?? null,
      architectureStyle: (explicit.architectureStyle as string).trim(),
      inputSignals,
      alternativesConsidered: [],
      confidence: "high",
      reason: "Explicit stack choice provided by caller; no inference performed.",
      humanReviewRequired,
    };
  }

  const selectedLanguage = hasLanguage ? (explicit.language ?? null) : inferred.language;
  const selectedFramework = hasFramework ? (explicit.framework ?? null) : inferred.framework;
  const architectureStyle = hasStyle ? (explicit.architectureStyle as string).trim() : inferred.architectureStyle;

  const anyExplicit = hasLanguage || hasFramework || hasStyle;

  if (!anyExplicit) {
    const humanReviewRequired = evaluateStackHumanReview(signals, {
      confidence: inferred.confidence,
      explicitConflictsWithInferred: false,
    });
    return {
      selectedLanguage,
      selectedFramework,
      architectureStyle,
      inputSignals,
      alternativesConsidered: buildAlternatives(architectureStyle),
      confidence: inferred.confidence,
      reason: inferred.reason,
      humanReviewRequired,
    };
  }

  const explicitParts: string[] = [];
  if (hasLanguage) explicitParts.push(`language=${String(selectedLanguage)}`);
  if (hasFramework) explicitParts.push(`framework=${String(selectedFramework)}`);
  if (hasStyle) explicitParts.push(`architectureStyle=${architectureStyle}`);

  const reason = `Explicit stack choice provided for ${explicitParts.join(", ")}; remaining fields inferred. ${inferred.reason}`;
  const confidence = lowerConfidence("high", inferred.confidence);

  // README↔.mmd konfliktas: eksplicitinis laukas nesutampa su (ne-null) išvestu.
  const explicitConflictsWithInferred =
    (hasLanguage && inferred.language !== null && selectedLanguage !== inferred.language) ||
    (hasFramework && inferred.framework !== null && selectedFramework !== inferred.framework) ||
    (hasStyle && architectureStyle !== inferred.architectureStyle);

  const humanReviewRequired = evaluateStackHumanReview(signals, { confidence, explicitConflictsWithInferred });

  return {
    selectedLanguage,
    selectedFramework,
    architectureStyle,
    inputSignals,
    alternativesConsidered: buildAlternatives(architectureStyle),
    confidence,
    reason,
    humanReviewRequired,
  };
}
