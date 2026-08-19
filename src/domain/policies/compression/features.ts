// Kompresijos flag'ų registras, config forma ir jos validacija. Flag'ų raktai gyvena TIK
// čia — sąrašas ir validacija negali prasilenkti. Validacija hand-rolled (domain be zod);
// fixture-pin'uotas klaidos paviršius: `<label> validation failed: <kelias>: <žinutė>`,
// nežinomam raktui — `Unrecognized key: "x"`. Behaviour etalon: AG_loop
// policy/context-compression.ts konfigo pusė (pinned by compression-policy-verdicts.json).

/** Dabartinė konfigo schemos versija. Nesuderinamas pakeitimas kelia šį skaičių. */
export const CONTEXT_COMPRESSION_CONFIG_VERSION = 1;

/** Versijos, kurias šis kodas moka perskaityti be spėjimų. */
export const SUPPORTED_CONTEXT_COMPRESSION_VERSIONS: readonly number[] = [CONTEXT_COMPRESSION_CONFIG_VERSION];

/** Trečioji flag'o būsena: aktyvus tik canary kohortai. */
export const CONTEXT_COMPRESSION_CANARY = "canary";

/** `true` = visiems, `"canary"` = tik kohortai, `false` = niekam. */
export type ContextCompressionFeatureValue = boolean | typeof CONTEXT_COMPRESSION_CANARY;

export type ContextCompressionFeatures = {
  /** Kanoninis WorkerTaskIR vietoj raw task Markdown. */
  worker_task_ir: ContextCompressionFeatureValue;
  /** Kompaktiškas worker DSL rendereris. */
  compact_dsl: ContextCompressionFeatureValue;
  /** REF/SIG/SRC pakopos code-context'e. */
  symbol_slices: ContextCompressionFeatureValue;
  /** Bash/PowerShell output digest PostToolUse kelyje. */
  bash_output_digest: ContextCompressionFeatureValue;
  /** Dispatch tool schemų mažinimas. */
  dispatch_tool_schema: ContextCompressionFeatureValue;
};

export type ContextCompressionFeature = keyof ContextCompressionFeatures;

/** Kanoninis flag'ų sąrašas deterministine tvarka. */
export const CONTEXT_COMPRESSION_FEATURES: readonly ContextCompressionFeature[] = [
  "worker_task_ir",
  "compact_dsl",
  "symbol_slices",
  "bash_output_digest",
  "dispatch_tool_schema",
];

/**
 * Flag'ai, kurių canary NEĮMANOMAS: jų sprendimo taškas neturi task konteksto, tad
 * `"canary"` ten tyliai reikštų „išjungta" — konfigo eilutė atrodytų aktyvi, telemetrija
 * skelbtų canary ranką, o feature niekada neveiktų. Todėl tai klaida, ne inertiška reikšmė.
 */
export const CONTEXT_COMPRESSION_CANARY_UNSUPPORTED: readonly ContextCompressionFeature[] = ["bash_output_digest"];

export type ContextCompressionCanary = {
  /** Kohortos dydis procentais (0 = canary neveikia, 100 = visi task'ai). */
  percent: number;
  /** Kohortos rotacijos žetonas: pakeitus jį atrenkama kita task'ų imtis. */
  salt: string;
};

export type ContextCompressionConfig = {
  version: number;
  features: ContextCompressionFeatures;
  canary: ContextCompressionCanary;
};

const CONFIG_LABEL = "context compression config";

/** Visi flag'ai išjungti — ir trūkstamo failo, ir tylinčios `features` sekcijos reikšmė. */
export function defaultContextCompressionFeatures(): ContextCompressionFeatures {
  return {
    worker_task_ir: false,
    compact_dsl: false,
    symbol_slices: false,
    bash_output_digest: false,
    dispatch_tool_schema: false,
  };
}

/** Tuščia kohorta — canary neveikia, kol operatorius nenustato procento. */
export function defaultContextCompressionCanary(): ContextCompressionCanary {
  return { percent: 0, salt: "" };
}

export function defaultContextCompressionConfig(): ContextCompressionConfig {
  return {
    version: CONTEXT_COMPRESSION_CONFIG_VERSION,
    features: defaultContextCompressionFeatures(),
    canary: defaultContextCompressionCanary(),
  };
}

type ValidationIssue = { path: string; message: string };

function fail(label: string, issues: ValidationIssue[]): never {
  const rendered = issues.map((issue) => `${issue.path || "<root>"}: ${issue.message}`).join("; ");
  throw new Error(`${label} validation failed: ${rendered}`);
}

/**
 * Validuoja jau perskaitytą konfigo reikšmę (strict: nežinomi raktai atmetami visuose
 * lygiuose; praleista `features`/`canary` sekcija = saugūs default'ai).
 */
export function parseContextCompressionConfig(value: unknown, label = CONFIG_LABEL): ContextCompressionConfig {
  const issues: ValidationIssue[] = [];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(label, [{ path: "", message: "expected an object" }]);
  }
  const record = value as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    if (key !== "version" && key !== "features" && key !== "canary") {
      issues.push({ path: "", message: `Unrecognized key: "${key}"` });
    }
  }

  const version = record["version"];
  if (typeof version !== "number" || !Number.isInteger(version)) {
    issues.push({ path: "version", message: "expected an integer" });
  } else if (!SUPPORTED_CONTEXT_COMPRESSION_VERSIONS.includes(version)) {
    issues.push({
      path: "version",
      message: `unsupported version (supported: ${SUPPORTED_CONTEXT_COMPRESSION_VERSIONS.join(", ")})`,
    });
  }

  const features = defaultContextCompressionFeatures();
  const rawFeatures = record["features"];
  if (rawFeatures !== undefined) {
    if (rawFeatures === null || typeof rawFeatures !== "object" || Array.isArray(rawFeatures)) {
      issues.push({ path: "features", message: "expected an object" });
    } else {
      for (const [key, raw] of Object.entries(rawFeatures as Record<string, unknown>)) {
        if (!(CONTEXT_COMPRESSION_FEATURES as readonly string[]).includes(key)) {
          issues.push({ path: "features", message: `Unrecognized key: "${key}"` });
          continue;
        }
        const feature = key as ContextCompressionFeature;
        if (raw !== true && raw !== false && raw !== CONTEXT_COMPRESSION_CANARY) {
          issues.push({ path: `features.${key}`, message: `must be true, false or "${CONTEXT_COMPRESSION_CANARY}"` });
          continue;
        }
        if (raw === CONTEXT_COMPRESSION_CANARY && CONTEXT_COMPRESSION_CANARY_UNSUPPORTED.includes(feature)) {
          issues.push({
            path: `features.${key}`,
            message:
              `does not support "${CONTEXT_COMPRESSION_CANARY}": its decision point has no task context, ` +
              "so a canary value would never be applied — use true or false",
          });
          continue;
        }
        features[feature] = raw as ContextCompressionFeatureValue;
      }
    }
  }

  const canary = defaultContextCompressionCanary();
  const rawCanary = record["canary"];
  if (rawCanary !== undefined) {
    if (rawCanary === null || typeof rawCanary !== "object" || Array.isArray(rawCanary)) {
      issues.push({ path: "canary", message: "expected an object" });
    } else {
      const canaryRecord = rawCanary as Record<string, unknown>;
      for (const key of Object.keys(canaryRecord)) {
        if (key !== "percent" && key !== "salt") {
          issues.push({ path: "canary", message: `Unrecognized key: "${key}"` });
        }
      }
      const percent = canaryRecord["percent"];
      if (percent !== undefined) {
        if (typeof percent !== "number" || !Number.isInteger(percent) || percent < 0 || percent > 100) {
          issues.push({ path: "canary.percent", message: "expected an integer between 0 and 100" });
        } else {
          canary.percent = percent;
        }
      }
      const salt = canaryRecord["salt"];
      if (salt !== undefined) {
        if (typeof salt !== "string") {
          issues.push({ path: "canary.salt", message: "expected a string" });
        } else {
          canary.salt = salt;
        }
      }
    }
  }

  if (issues.length > 0) fail(label, issues);
  return { version: version as number, features, canary };
}
