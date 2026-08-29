// Canary arrest — kill switch, kurio canary neturėjo. Trys savybės: (1) konfigas niekada
// nerašomas (arrest — ATSKIRAS runtime artefaktas); (2) arrest gali tik pasiųsti raw
// task'ą — nėra įvesties, kurią jis paverstų atmestu dispatch'u; (3) nuimamas TIK ranka.
// Skaitymo IO (readContextCompressionArrestState/observe write) — E3; čia grynos taisyklės.
// Behaviour etalon: AG_loop policy/context-compression.ts arrest pusė.

import {
  CONTEXT_COMPRESSION_FEATURES,
  type ContextCompressionConfig,
  type ContextCompressionFeature,
} from "./features.js";
import { isTaskInContextCompressionCanary } from "./canary.js";

/** Schema version of the arrest artefact. A record of another version is not read. */
export const CONTEXT_COMPRESSION_ARREST_STATE_VERSION = 1;

/** Repo-relative arrest artefaktas, cituojamas operatoriaus eilutėse. */
export const CONTEXT_COMPRESSION_ARREST_RELATIVE_PATH = "AG/state/context-compression-arrest.json";

/**
 * Slenksčiai M/K/N — politikos default'ai, deklaruoti vieną kartą KODE (ne konfige:
 * konfigo baitai rieda kompresijos evidence digest'e, tad guardrail'o derinimas
 * invaliduotų būtent tuos įrodymus, kuriuos jis saugo).
 */
export const CONTEXT_COMPRESSION_ARREST_DEFAULTS = {
  /** M — vienos feature iš eilės einantys canary-arm fallback'ai į raw. */
  fallbackStreak: 3,
  /** K — canary-kohortos task'ai, pasibaigę human-review nuo lango pradžios. */
  humanReview: 3,
  /** N — kohortos pack'ai be jokio gyvo įrodymo, po kurių release gate'as įvardija canary. */
  silentCanaryObservations: 10,
} as const;

export type ContextCompressionArrestThresholds = {
  fallbackStreak: number;
  humanReview: number;
  silentCanaryObservations: number;
};

export function defaultContextCompressionArrestThresholds(): ContextCompressionArrestThresholds {
  return { ...CONTEXT_COMPRESSION_ARREST_DEFAULTS };
}

/** Kodėl feature areštuota. Abu skaičiuojami TIK ant canary arm. */
export const CONTEXT_COMPRESSION_ARREST_TRIGGERS = ["fallback-streak", "human-review"] as const;

export type ContextCompressionArrestTrigger = (typeof CONTEXT_COMPRESSION_ARREST_TRIGGERS)[number];

export type ContextCompressionArrest = {
  feature: ContextCompressionFeature;
  trigger: ContextCompressionArrestTrigger;
  /** Vienas sakinys, įvardijantis slenkstį peržengusį skaičių — jį cituoja log eilutė. */
  reason: string;
  observed: number;
  threshold: number;
  arrested_at: string;
  last_task_id: string;
};

export type ContextCompressionArrestCounters = {
  /** Iš eilės einantys canary-arm fallback'ai per feature; compiled dispatch'as nulina. */
  fallback_streak: Partial<Record<ContextCompressionFeature, number>>;
  human_review: Partial<Record<ContextCompressionFeature, number>>;
  /** Jau suskaičiuoti task id — pakartotinis event log skaitymas nesuskaičiuoja dukart. */
  human_review_task_ids: string[];
  /**
   * Kada atsidarė human-review skaičiavimo langas (pirmo canary stebėjimo laikas).
   * Nebuvimas reiškia „langas dar neatidarytas": event log'e matomi human-review
   * perėjimai įvyko IKI canary rankos, tad pirmas stebėjimas juos užsėja kaip bazinę
   * liniją, o ne skaičiuoja prieš slenkstį.
   */
  human_review_window_opened_at?: string;
};

export type ContextCompressionArrestState = {
  version: number;
  arrests: ContextCompressionArrest[];
  counters: ContextCompressionArrestCounters;
};

/** Kiek suskaičiuotų human-review task id atsimenama (ribojama, ne auditui). */
export const MAX_REMEMBERED_ARREST_HUMAN_REVIEW_TASKS = 500;

export function defaultContextCompressionArrestState(): ContextCompressionArrestState {
  return {
    version: CONTEXT_COMPRESSION_ARREST_STATE_VERSION,
    arrests: [],
    counters: { fallback_streak: {}, human_review: {}, human_review_task_ids: [] },
  };
}

/**
 * Arrest būsena, kokią ją privalo matyti dispatch'as. `unreadable` nėra klaida kvietėjui —
 * tai trečias perskaitomas atsakymas: neparsinamas marker'is gali fiksuoti bet ką, tad
 * vienintelis saugus skaitymas — „viskas areštuota".
 */
export type ContextCompressionArrestView = {
  state: ContextCompressionArrestState;
  unreadable: boolean;
  /** Kodėl neperskaitomas — operatoriaus eilutei, niekada sprendimui. */
  unreadableReason?: string;
};

type Issue = { path: string; message: string };

function issueView(issue: Issue): ContextCompressionArrestView {
  return {
    state: defaultContextCompressionArrestState(),
    unreadable: true,
    unreadableReason: `${issue.path || "<root>"}: ${issue.message}`,
  };
}

function isFeature(value: unknown): value is ContextCompressionFeature {
  return typeof value === "string" && (CONTEXT_COMPRESSION_FEATURES as readonly string[]).includes(value);
}

function parseCounterMap(value: unknown, path: string): Partial<Record<ContextCompressionFeature, number>> | Issue {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { path, message: "not a counter map" };
  }
  const counters: Partial<Record<ContextCompressionFeature, number>> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!isFeature(key)) return { path: `${path}.${key}`, message: "not a compression feature" };
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
      return { path: `${path}.${key}`, message: "expected a non-negative integer" };
    }
    counters[key] = raw;
  }
  return counters;
}

/** Validuoja jau perskaitytą arrest reikšmę; atskirta nuo IO, kad testams nereikėtų failų. */
export function parseContextCompressionArrestState(value: unknown): ContextCompressionArrestView {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return issueView({ path: "", message: "not a context compression arrest state" });
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "version" && key !== "arrests" && key !== "counters") {
      return issueView({ path: "", message: `Unrecognized key: "${key}"` });
    }
  }
  if (record["version"] !== CONTEXT_COMPRESSION_ARREST_STATE_VERSION) {
    return issueView({ path: "version", message: `expected ${CONTEXT_COMPRESSION_ARREST_STATE_VERSION}` });
  }

  const arrests: ContextCompressionArrest[] = [];
  const rawArrests = record["arrests"] ?? [];
  if (!Array.isArray(rawArrests)) return issueView({ path: "arrests", message: "expected an array" });
  for (const [index, rawArrest] of rawArrests.entries()) {
    if (rawArrest === null || typeof rawArrest !== "object" || Array.isArray(rawArrest)) {
      return issueView({ path: `arrests.${index}`, message: "expected an object" });
    }
    const entry = rawArrest as Record<string, unknown>;
    if (!isFeature(entry["feature"])) return issueView({ path: `arrests.${index}.feature`, message: "not a compression feature" });
    const trigger = entry["trigger"];
    if (trigger !== "fallback-streak" && trigger !== "human-review") {
      return issueView({ path: `arrests.${index}.trigger`, message: "unknown trigger" });
    }
    if (typeof entry["reason"] !== "string") return issueView({ path: `arrests.${index}.reason`, message: "expected a string" });
    if (typeof entry["observed"] !== "number" || !Number.isInteger(entry["observed"]) || entry["observed"] < 0) {
      return issueView({ path: `arrests.${index}.observed`, message: "expected a non-negative integer" });
    }
    if (typeof entry["threshold"] !== "number" || !Number.isInteger(entry["threshold"]) || entry["threshold"] < 1) {
      return issueView({ path: `arrests.${index}.threshold`, message: "expected a positive integer" });
    }
    if (typeof entry["arrested_at"] !== "string") return issueView({ path: `arrests.${index}.arrested_at`, message: "expected a string" });
    if (typeof entry["last_task_id"] !== "string") return issueView({ path: `arrests.${index}.last_task_id`, message: "expected a string" });
    arrests.push({
      feature: entry["feature"],
      trigger,
      reason: entry["reason"],
      observed: entry["observed"],
      threshold: entry["threshold"],
      arrested_at: entry["arrested_at"],
      last_task_id: entry["last_task_id"],
    });
  }

  const rawCounters = (record["counters"] ?? {}) as Record<string, unknown>;
  if (rawCounters === null || typeof rawCounters !== "object" || Array.isArray(rawCounters)) {
    return issueView({ path: "counters", message: "expected an object" });
  }
  const fallbackStreak = parseCounterMap(rawCounters["fallback_streak"], "counters.fallback_streak");
  if ("message" in fallbackStreak) return issueView(fallbackStreak);
  const humanReview = parseCounterMap(rawCounters["human_review"], "counters.human_review");
  if ("message" in humanReview) return issueView(humanReview);
  const rawTaskIds = rawCounters["human_review_task_ids"] ?? [];
  if (!Array.isArray(rawTaskIds) || !rawTaskIds.every((entry) => typeof entry === "string")) {
    return issueView({ path: "counters.human_review_task_ids", message: "expected a string array" });
  }
  const rawWindowOpenedAt = rawCounters["human_review_window_opened_at"];
  if (rawWindowOpenedAt !== undefined && typeof rawWindowOpenedAt !== "string") {
    return issueView({ path: "counters.human_review_window_opened_at", message: "expected a string" });
  }

  return {
    state: {
      version: CONTEXT_COMPRESSION_ARREST_STATE_VERSION,
      arrests,
      counters: {
        fallback_streak: fallbackStreak,
        human_review: humanReview,
        human_review_task_ids: rawTaskIds,
        ...(rawWindowOpenedAt === undefined ? {} : { human_review_window_opened_at: rawWindowOpenedAt }),
      },
    },
    unreadable: false,
  };
}

export function isContextCompressionFeatureArrested(
  view: ContextCompressionArrestView,
  feature: ContextCompressionFeature,
): boolean {
  return view.unreadable || view.state.arrests.some((arrest) => arrest.feature === feature);
}

/** Areštuotos features kanonine registro tvarka — report ir gate eilutėms. */
export function arrestedContextCompressionFeatures(view: ContextCompressionArrestView): ContextCompressionFeature[] {
  return CONTEXT_COMPRESSION_FEATURES.filter((feature) => isContextCompressionFeatureArrested(view, feature));
}

/**
 * Konfigas, ant kurio dispatch'as PRIVALO veikti: kiekviena areštuota feature → false.
 * `false` yra vienintelė čia rašoma reikšmė — blogiausia baigtis yra pre-compression
 * dispatch'as; neperskaitomas marker'is ima tą pačią kryptį visoms features.
 */
export function applyContextCompressionArrest(
  config: ContextCompressionConfig,
  view: ContextCompressionArrestView,
): ContextCompressionConfig {
  const arrested = arrestedContextCompressionFeatures(view);
  if (arrested.length === 0) return config;
  const features = { ...config.features };
  for (const feature of arrested) {
    features[feature] = false;
  }
  return { ...config, features };
}

/** One canary-arm dispatch, as the arrest counters see it. */
export type ContextCompressionArrestObservation = {
  taskId: string;
  /** Features šis dispatch'as gavo IŠ canary arm. Tuščia = kontrolinė ranka, nieko neskaičiuojam. */
  canaryFeatures: readonly ContextCompressionFeature[];
  /** Feature, kuriai priskirtas raw/size fallback'as; nebuvimas NULINA streak'ą. */
  fallbackFeature?: ContextCompressionFeature;
  /** Kohortos task id, pastebėti human-review; jau suskaičiuoti ignoruojami. */
  humanReviewTaskIds?: readonly string[];
  now: Date;
  thresholds?: ContextCompressionArrestThresholds;
};

export type ContextCompressionArrestUpdate = {
  state: ContextCompressionArrestState;
  /** ŠIO stebėjimo sukurti areštai — ką dispatch'as loguoja garsiai. */
  arrested: ContextCompressionArrest[];
  /** Ar kas nors keitėsi, kad nepakitusi būsena nebūtų perrašoma. */
  changed: boolean;
};

/**
 * Sulanksto vieną dispatch'ą į arrest skaitiklius. Pure: no clock, no I/O. Jau areštuota
 * feature paliekama VISIŠKAI ramybėje — skaitikliai užšaldyti, antro arešto nėra.
 */
export function recordContextCompressionArrestObservation(
  state: ContextCompressionArrestState,
  observation: ContextCompressionArrestObservation,
): ContextCompressionArrestUpdate {
  const thresholds = observation.thresholds ?? defaultContextCompressionArrestThresholds();
  const watched = observation.canaryFeatures.filter(
    (feature) => !state.arrests.some((arrest) => arrest.feature === feature),
  );
  if (watched.length === 0) {
    return { state, arrested: [], changed: false };
  }

  const counters: ContextCompressionArrestCounters = {
    fallback_streak: { ...state.counters.fallback_streak },
    human_review: { ...state.counters.human_review },
    human_review_task_ids: [...state.counters.human_review_task_ids],
    ...(state.counters.human_review_window_opened_at === undefined
      ? {}
      : { human_review_window_opened_at: state.counters.human_review_window_opened_at }),
  };
  const arrested: ContextCompressionArrest[] = [];
  const arrestedAt = observation.now.toISOString();

  const arrest = (
    feature: ContextCompressionFeature,
    trigger: ContextCompressionArrestTrigger,
    observed: number,
    threshold: number,
    reason: string,
  ): void => {
    arrested.push({ feature, trigger, reason, observed, threshold, arrested_at: arrestedAt, last_task_id: observation.taskId });
  };

  // M — consecutive fallbacks of one feature.
  for (const feature of watched) {
    if (feature !== observation.fallbackFeature) {
      counters.fallback_streak[feature] = 0;
      continue;
    }
    const streak = (counters.fallback_streak[feature] ?? 0) + 1;
    counters.fallback_streak[feature] = streak;
    if (streak >= thresholds.fallbackStreak) {
      arrest(
        feature,
        "fallback-streak",
        streak,
        thresholds.fallbackStreak,
        `${streak} consecutive canary dispatches fell back to the raw task (last ${observation.taskId}), ` +
          "so the compiled variant is not reaching workers and the canary is measuring nothing",
      );
    }
  }

  // K — canary-cohort tasks that ended in human-review, counted once per task id.
  //
  // Langas atsidaro PIRMU canary stebėjimu: kohortos narystė yra vien hash'as, tad iki
  // šio momento event log'e matomi human-review perėjimai įvyko be canary rankos ir
  // nieko nesako apie jos kokybę. Jie užsėjami kaip jau suskaičiuota bazinė linija —
  // skaitikliai lieka nuliniai. 2026-08-28 areštas kilo būtent iš šios spragos: pirmas
  // stebėjimas suskaičiavo 19 istorinių task'ų (dalis parkuota kelios dienos iki
  // įjungimo) ir areštavo visas tris features po VIENO canary dispatch'o.
  const counted = new Set(counters.human_review_task_ids);
  const fresh = [...new Set(observation.humanReviewTaskIds ?? [])].filter((taskId) => !counted.has(taskId));
  if (counters.human_review_window_opened_at === undefined) {
    counters.human_review_window_opened_at = arrestedAt;
    if (fresh.length > 0) {
      counters.human_review_task_ids = [...counters.human_review_task_ids, ...fresh].slice(
        -MAX_REMEMBERED_ARREST_HUMAN_REVIEW_TASKS,
      );
    }
  } else if (fresh.length > 0) {
    counters.human_review_task_ids = [...counters.human_review_task_ids, ...fresh].slice(
      -MAX_REMEMBERED_ARREST_HUMAN_REVIEW_TASKS,
    );
    for (const feature of watched) {
      if (arrested.some((entry) => entry.feature === feature)) continue;
      const total = (counters.human_review[feature] ?? 0) + fresh.length;
      counters.human_review[feature] = total;
      if (total >= thresholds.humanReview) {
        arrest(
          feature,
          "human-review",
          total,
          thresholds.humanReview,
          `${total} canary-cohort task(s) ended in human-review since this window opened ` +
            `(last ${observation.taskId}), so the canary arm is costing the queue human passes`,
        );
      }
    }
  }

  // Kanoninė feature tvarka — du bėgimai, areštuojantys tą pačią aibę, rašo tuos pačius baitus.
  const arrests = [...state.arrests, ...arrested].sort(
    (left, right) =>
      CONTEXT_COMPRESSION_FEATURES.indexOf(left.feature) - CONTEXT_COMPRESSION_FEATURES.indexOf(right.feature),
  );
  const next: ContextCompressionArrestState = { version: CONTEXT_COMPRESSION_ARREST_STATE_VERSION, arrests, counters };
  return { state: next, arrested, changed: JSON.stringify(next) !== JSON.stringify(state) };
}

/**
 * Kohortos task id, pasibaigę human-review — vienas taip/ne per task'ą prieš TĄ PAČIĄ
 * kohortos funkciją, kurią naudoja pats dispatch'as.
 */
export function selectCanaryHumanReviewTaskIds(
  config: ContextCompressionConfig,
  events: readonly { task_id?: unknown; to_state?: unknown }[],
): string[] {
  const seen = new Set<string>();
  for (const event of events) {
    if (typeof event.task_id !== "string" || event.task_id.trim() === "") continue;
    if (event.to_state !== "human-review") continue;
    const taskId = event.task_id.trim();
    if (seen.has(taskId)) continue;
    if (!isTaskInContextCompressionCanary(config, taskId)) continue;
    seen.add(taskId);
  }
  return [...seen];
}

/** The loud line a dispatch writes for a feature it is refusing to run. */
export function describeContextCompressionArrest(arrest: ContextCompressionArrest): string {
  return `CANARY ARRESTED: feature=${arrest.feature} reason=${arrest.trigger}: ${arrest.reason}`;
}
