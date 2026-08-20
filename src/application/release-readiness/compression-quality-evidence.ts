// Compression rollout vartų ĮRODYMŲ pusė: raporto compression sekcija, run-identity
// sidecar skenavimas ir canary telemetrijos faktai. Elgesio etalonas: AG_loop
// application/release-readiness/compression-quality-check.ts (apatinė pusė).
// Sprendimo kompozicija gyvena compression-quality-check.ts.

import path from "node:path";
import { z } from "zod";
import {
  CONTEXT_COMPRESSION_ARREST_DEFAULTS,
  arrestedContextCompressionFeatures,
  type ContextCompressionArrestView,
} from "../../domain/policies/compression/arrest.js";
import { isTaskInContextCompressionCanary } from "../../domain/policies/compression/canary.js";
import {
  CONTEXT_COMPRESSION_CANARY,
  type ContextCompressionConfig,
  type ContextCompressionFeature,
} from "../../domain/policies/compression/features.js";
import {
  BENCHMARK_REPORT_COMMAND,
  BENCHMARK_REPORT_RELATIVE_PATH,
  readBenchmarkReportView,
} from "../benchmark/suite-report-view.js";
import { readContextSizeMetrics } from "../context-pack/metrics.js";
import { COMPRESSION_CONFIG_SOURCE } from "./compression-config-digest.js";
import type {
  CheckCompressionQualityOptions,
  CompressionQualityFinding,
  CompressionQualityFsPort,
} from "./compression-quality-model.js";

/** Vienintelis kompresijos verdiktas, palaikantis vėliavos įjungimą (`COMPRESSION_VERDICTS`). */
export const ACCEPTED_COMPRESSION_VERDICT = "accepted";

/** Repo-relative katalogas su vienu ledger'iu ir vienu identity sidecar'u kiekvienam benchmark run'ui. */
export const RUN_IDENTITY_RELATIVE_DIRECTORY = "AG/benchmark/results/runs";

/** Veidrodis benchmark paketo `RUN_IDENTITY_SUFFIX`. */
export const RUN_IDENTITY_SUFFIX = ".identity.json";

/** Veidrodis `RUN_IDENTITY_RECORD_SCHEMA_VERSION`: kitos versijos įrašas neskaitomas. */
export const SUPPORTED_RUN_IDENTITY_SCHEMA_VERSION = 2;

/** Už šitą didesnis sidecar'as laikomas neperskaitomu, o ne parsinamas į atmintį. */
export const MAX_RUN_IDENTITY_BYTES = 1024 * 1024;

/**
 * Kiek sidecar'ų peržiūrima, naujausi pirmiausia.
 *
 * Run katalogas auga be ribų — po failą kiekvienam benchmark run'ui, niekada nevalomas —
 * o release vartai negali virsti neribotu katalogo skaitymu. Naujausi pirmiausia, nes
 * run'as, matavęs dabar galiojančią konfigūraciją, yra naujausias ją įvardijantis.
 */
export const MAX_RUN_IDENTITY_RECORDS = 200;

/** Canary telemetrijos žurnalo etiketė operatoriaus eilutėms (realus kelias — iš runtimeRoot). */
export const CONTEXT_SIZE_LOG_LABEL = "vq/logs/context-size.jsonl";

/** Kiek vienos feature aibės variantų žinutė išvardija prieš sustodama; vartų eilutė skaitoma, ne scroll'inama. */
const MAX_LISTED_VARIANTS = 3;

// Loose objektai visur: orkestratorius čia kurjeris ir niekada ne autorius, tad benchmark'o
// pridėtas laukas negali paversti perskaitomo artefakto neperskaitomu. Išrašyta tik tai,
// ką šie vartai skaito.

const compressionSectionSchema = z.looseObject({
  registryVersion: z.number().int().nonnegative(),
  baselineVariantId: z.string(),
  variants: z.array(
    z.looseObject({
      variantId: z.string(),
      variantIdentity: z.string(),
      features: z.array(z.string()),
      hookProfile: z.string(),
      verdict: z.string(),
    }),
  ),
});

export type CompressionSection = z.infer<typeof compressionSectionSchema>;
type CompressionVariantRow = CompressionSection["variants"][number];

const runIdentitySidecarSchema = z.looseObject({
  schemaVersion: z.number().int().positive(),
  runId: z.string(),
  compressionConfig: z.looseObject({
    state: z.enum(["read", "absent", "unreadable"]),
    source: z.string(),
    digest: z.string(),
    view: z
      .looseObject({
        version: z.number().optional(),
        // Tri-state per feature, kaip konfigūracija autorina (`"canary"` nėra nei on, nei off) —
        // optional, nes senesnės schemos versijos sidecar'as yra senesnis įrašas, ne neperskaitomas.
        features: z.array(
          z.looseObject({ feature: z.string(), state: z.union([z.boolean(), z.literal("canary")]).optional() }),
        ),
        canary: z.looseObject({ percent: z.number().optional(), salt: z.string().optional() }).optional(),
      })
      .optional(),
  }),
});

type RunIdentitySidecar = z.infer<typeof runIdentitySidecarSchema>;

/**
 * Raporto compression sekcija arba jos vietoje stovinti voko problema.
 *
 * Trūkstamas, corrupt ar stale raportas į kompresijos klausimą atsako taip pat, kaip į
 * kiekvieną kitą — neatsako — tad verdikto patikros praleidžiamos, o ne leidžiamos prieš
 * dokumentą, kurio niekas negali atributuoti.
 */
export async function readCompressionSection(
  fs: CompressionQualityFsPort,
  projectRoot: string,
  options: CheckCompressionQualityOptions,
  envelope: CompressionQualityFinding[],
): Promise<CompressionSection | undefined> {
  const view = await readBenchmarkReportView(fs, {
    projectRoot,
    ...(options.currentAgCommit === undefined ? {} : { currentAgCommit: options.currentAgCommit }),
  });

  if (view.state === "missing" || view.state === "corrupt") {
    envelope.push({
      reason: "missing-verdict",
      text:
        `${BENCHMARK_REPORT_RELATIVE_PATH} carries no readable compression verdict ` +
        `(${view.reason ?? view.state}). Produce one with: ${BENCHMARK_REPORT_COMMAND}`,
    });
    return undefined;
  }

  if (view.state === "stale") {
    envelope.push({
      reason: "stale-identity",
      text:
        `${BENCHMARK_REPORT_RELATIVE_PATH} was measured on another tree, so its compression verdicts do ` +
        `not describe this one (${view.reason ?? "the report describes another commit"})`,
    });
    return undefined;
  }

  const rawSection = (view.report as { compression?: unknown } | undefined)?.compression;
  if (rawSection === undefined) {
    envelope.push({
      reason: "missing-verdict",
      text:
        `${BENCHMARK_REPORT_RELATIVE_PATH} carries no compression section, so it states nothing about the ` +
        `enabled feature(s). Re-run the benchmark over a compression cohort: ${BENCHMARK_REPORT_COMMAND}`,
    });
    return undefined;
  }

  const parsed = compressionSectionSchema.safeParse(rawSection);
  if (!parsed.success) {
    // Zod įvardija kelią dokumento VIDUJE, niekada failo baitų: raportas — generuotas
    // git'o ignoruojamas output'as, o jo turinio aidas paverstų svetimą failą disclosure kanalu.
    envelope.push({
      reason: "missing-verdict",
      text:
        `${BENCHMARK_REPORT_RELATIVE_PATH} carries a compression section this build cannot read — ` +
        `${describeSchemaFailure(parsed.error)}`,
    });
    return undefined;
  }

  return parsed.data;
}

/** Pirma zod problema viena eilute: kelias dokumente ir žinutė, nieko daugiau. */
function describeSchemaFailure(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "the section does not match the compression report schema";
  const at = issue.path.length > 0 ? issue.path.join(".") : "<root>";
  return `${at}: ${issue.message}`;
}

/**
 * Kanoninė feature aibės rašyba: rūšiuota, be pasikartojimų — ta pati, po kuria
 * benchmark'as saugo variantą, tad `{a, b}` ir `{b, a}` lyginasi kaip ta viena aibė.
 */
export function canonicalFeatureSet(features: readonly string[]): string[] {
  return [...new Set(features)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function sameFeatureSet(left: readonly string[], right: readonly string[]): boolean {
  const a = canonicalFeatureSet(left);
  const b = canonicalFeatureSet(right);
  return a.length === b.length && a.every((feature, index) => feature === b[index]);
}

/** Variantai, kurių kanoninė feature aibė yra tiksliai `features`, kad ir ką jie nusprendė. */
function variantsFor(section: CompressionSection, features: readonly string[]): CompressionVariantRow[] {
  return section.variants.filter((variant) => sameFeatureSet(variant.features, features));
}

export function acceptedVariantFor(
  section: CompressionSection,
  features: readonly string[],
): CompressionVariantRow | undefined {
  return variantsFor(section, features).find((variant) => variant.verdict === ACCEPTED_COMPRESSION_VERDICT);
}

/**
 * Ką raportas apie šią feature aibę SAKO, kaip viena trailing frazė: blokas, sakantis tik
 * "no accepted verdict", paliktų operatorių aiškintis, ar variantas atmestas, ar niekada
 * nebėgo — du skirtingi kiti žingsniai.
 */
export function describeVariants(section: CompressionSection, features: readonly string[]): string {
  const candidates = variantsFor(section, features);
  if (candidates.length === 0) return "; the report declares no variant with exactly that feature set";
  const listed = candidates
    .slice(0, MAX_LISTED_VARIANTS)
    .map((variant) => `${variant.variantId}: ${variant.verdict}`);
  const rest = candidates.length - listed.length;
  return `; the report's variants with that feature set are ${listed.join(", ")}${rest > 0 ? ` (+${rest} more)` : ""}`;
}

export type RunIdentityScan = {
  /** Kiek sidecar'ų katalogas laiko, prieš pritaikant {@link MAX_RUN_IDENTITY_RECORDS}. */
  total: number;
  /** Kiek realiai atidaryta: `total` arba naujausi {@link MAX_RUN_IDENTITY_RECORDS}. */
  examined: number;
  unreadable: number;
  matched: number;
};

/**
 * Cap'as, įvardijamas tik kai suveikė: vartai, praneštų "holds 200 record(s)" virš 5000
 * failų katalogo, meluotų apie įrodymus pačioje juos atmetančioje žinutėje.
 */
export function describeRunIdentityCap(scan: RunIdentityScan): string {
  return scan.total > scan.examined ? ` (only the ${scan.examined} newest were examined)` : "";
}

/**
 * Kiek saugomų run'ų buvo įvykdyta po dabar galiojančia kompresijos konfigūracija.
 *
 * `identity.agCommit` sąmoningai nelyginamas: klausimas čia — KURI konfigūracija pagamino
 * įrodymus, o commit'as, ant kurio matuota, yra benchmark raporto vartų klausimas
 * (BENCH-12), ne šitų.
 */
export async function scanRunIdentitySidecars(
  fs: CompressionQualityFsPort,
  projectRoot: string,
  digest: string,
): Promise<RunIdentityScan> {
  const directory = path.join(projectRoot, ...RUN_IDENTITY_RELATIVE_DIRECTORY.split("/"));
  const entries = await fs.listDirectory(directory).catch(() => [] as string[]);
  // Vardų tvarka chronologinė pagal konstrukciją (`createRunId` prasideda fiksuoto pločio
  // UTC žyma), tad descending yra naujausi pirmiausia ir cap'as išlaiko naujausius run'us.
  const found = entries
    .filter((name) => name.endsWith(RUN_IDENTITY_SUFFIX))
    .sort((left, right) => (left < right ? 1 : left > right ? -1 : 0));
  const names = found.slice(0, MAX_RUN_IDENTITY_RECORDS);

  const scan: RunIdentityScan = { total: found.length, examined: names.length, unreadable: 0, matched: 0 };
  for (const name of names) {
    const record = await readRunIdentitySidecar(fs, path.join(directory, name));
    if (record === undefined) {
      scan.unreadable += 1;
      continue;
    }
    if (
      record.schemaVersion === SUPPORTED_RUN_IDENTITY_SCHEMA_VERSION &&
      record.compressionConfig.state === "read" &&
      record.compressionConfig.source === COMPRESSION_CONFIG_SOURCE &&
      record.compressionConfig.digest === digest
    ) {
      scan.matched += 1;
    }
  }
  return scan;
}

/**
 * Vienas sidecar'as arba `undefined`, kai jis nėra toks, kokį šis build'as gali skaityti.
 *
 * `statPath` (lstat semantika — symlink'as yra `other`) ir dydžio lubos PRIEŠ skaitymą:
 * tai generuotas git'o ignoruojamas output'as, ir niekas nelaiduoja, kas guli jo vardu.
 */
async function readRunIdentitySidecar(
  fs: CompressionQualityFsPort,
  filePath: string,
): Promise<RunIdentitySidecar | undefined> {
  try {
    const stats = await fs.statPath(filePath);
    if (stats.kind !== "file" || stats.size > MAX_RUN_IDENTITY_BYTES) return undefined;
    const parsed: unknown = JSON.parse(await fs.readTextFile(filePath));
    const validated = runIdentitySidecarSchema.safeParse(parsed);
    return validated.success ? validated.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Ar kiekviena įjungta feature kada nors buvo stebėta gyvame canary arm'e.
 *
 * `canary_features` telemetrijoje yra per-feature gyvo arm'o žymė ir vienintelis šaltinis,
 * galintis atsakyti: sidecar'o view sako, kas buvo SUKONFIGŪRUOTA kaip canary, bet
 * sukonfigūruotas rollout'as nėra stebėtas — tik telemetrija sako, kad canary arm'as bėgo.
 */
export async function checkCanaryEvidence(
  fs: CompressionQualityFsPort,
  runtimeRoot: string,
  enabled: readonly ContextCompressionFeature[],
): Promise<CompressionQualityFinding[]> {
  let records: Awaited<ReturnType<typeof readContextSizeMetrics>>;
  try {
    records = await readContextSizeMetrics(fs, runtimeRoot);
  } catch {
    // Fiksuotas sakinys tyčia: reader'is meta V8 parse klaidą, cituojančią žurnalo gabalą,
    // o vartų eilutė nėra vieta perspausdinti logintus baitus.
    return [
      {
        reason: "no-canary-evidence",
        text:
          `${CONTEXT_SIZE_LOG_LABEL} could not be read as canary telemetry, so no enabled feature ` +
          "can be shown to have run in a canary arm; repair or rotate the log and measure again",
      },
    ];
  }

  return enabled
    .filter((feature) => !records.some((record) => record.canary_features?.includes(feature)))
    .map((feature) => ({
      reason: "no-canary-evidence" as const,
      text:
        `no record in ${CONTEXT_SIZE_LOG_LABEL} marks ${feature} as a canary feature, so this ` +
        "repository holds no live evidence from the arm the flag was promoted out of",
    }));
}

/** Arrest markerio etiketė operatoriaus eilutėms (realus kelias — iš runtimeRoot). */
const ARREST_STATE_LABEL = "vq/state/context-compression-arrest.json";

/**
 * Ką gyva canary daro, nepriklausomai nuo jokio promotion teiginio (task 0008).
 *
 * Klausiama KIEKVIENO repo, įskaitant tą, kurio visos vėliavos stovi `"canary"` — būsena,
 * kurioje šie vartai anksčiau neskaitydavo nieko.
 */
export async function checkCanaryGuardrails(
  fs: CompressionQualityFsPort,
  runtimeRoot: string,
  config: ContextCompressionConfig,
  canary: readonly ContextCompressionFeature[],
  arrestView: ContextCompressionArrestView,
): Promise<CompressionQualityFinding[]> {
  const findings: CompressionQualityFinding[] = [];
  const arrested = arrestedContextCompressionFeatures(arrestView);

  if (arrestView.unreadable) {
    findings.push({
      reason: "canary-arrested",
      text:
        `${ARREST_STATE_LABEL} exists but cannot be read as an arrest state ` +
        `(${arrestView.unreadableReason ?? "unreadable"}), so every dispatch is treating every compression ` +
        "feature as off; repair or delete the marker",
    });
  } else {
    for (const arrest of arrestView.state.arrests) {
      findings.push({
        reason: "canary-arrested",
        text:
          `${arrest.feature} was arrested at ${arrest.arrested_at} by the ${arrest.trigger} guardrail ` +
          `(${arrest.observed}/${arrest.threshold}): ${arrest.reason}. Dispatches send the raw task until an ` +
          `operator lifts it in ${ARREST_STATE_LABEL}`,
      });
    }
  }

  // Arrest'inta feature nebeklausiama, ar buvo stebėta: ji sustabdyta tyčia, ir antra
  // eilutė apie plonus jos įrodymus skaitytųsi kaip atskira problema.
  const watched = canary.filter((feature) => !arrested.includes(feature));
  if (watched.length === 0) return findings;

  let records: Awaited<ReturnType<typeof readContextSizeMetrics>>;
  try {
    records = await readContextSizeMetrics(fs, runtimeRoot);
  } catch {
    // Enabled kelias neperskaitomą telemetriją jau praneša kaip blokuojantį
    // `no-canary-evidence`; kartoti čia canary vardu būtų tas pats faktas dukart.
    return findings;
  }

  // Kohortos narystė perskaičiuojama TA PAČIA funkcija, kurią naudojo dispatch'as, tad
  // "canary turėjo savo progas" reiškia progas po dabar galiojančiu percent ir salt.
  // Pakeitus salt skaičius teisėtai startuoja iš naujo: tai kita kohorta.
  const cohortObservations = records.filter((record) => isTaskInContextCompressionCanary(config, record.task_id)).length;
  if (cohortObservations < CONTEXT_COMPRESSION_ARREST_DEFAULTS.silentCanaryObservations) {
    return findings;
  }

  for (const feature of watched) {
    if (records.some((record) => record.canary_features?.includes(feature))) continue;
    findings.push({
      reason: "canary-not-observed",
      severity: "warn",
      text:
        `${feature} stands at "${CONTEXT_COMPRESSION_CANARY}" and the cohort has produced ${cohortObservations} ` +
        `context pack(s), but no record in ${CONTEXT_SIZE_LOG_LABEL} marks it as a canary feature — ` +
        "the flag is configured and never applied, so no promotion evidence can come from it",
    });
  }

  return findings;
}

/** `sha256:` plius dvylika hex ženklų — pakankamai digest'o atpažinti, pakankamai trumpai skaityti. */
export function abbreviateDigest(digest: string): string {
  if (digest === "") return "<none>";
  return digest.startsWith("sha256:") ? digest.slice(0, "sha256:".length + 12) : digest.slice(0, 12);
}
