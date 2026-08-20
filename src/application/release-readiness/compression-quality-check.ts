// release-readiness use-case: compression rollout vartai (task 1206, rollout plano 4
// žingsnis; task 0008 canary guardrails). Elgesio etalonas: AG_loop
// application/release-readiness/compression-quality-check.ts. VERQESTRA skirtumai: visas
// IO per CompressionQualityFsPort; konfigas/arrest/telemetrija — vq runtime šaknyje,
// benchmark artefaktai — repo šaknyje (AG/benchmark, kaip suite-report-view).
//
// Vartai atsako lygiai į vieną klausimą: *ar kompresijos vėliava gali DABAR stovėti
// `true` vq/config/context-compression.json faile?* Vėliava `true` keičia, kas duodama
// kiekvienam dispatch'ui, o kopėčios `false -> "canary" -> true` egzistuoja tam, kad
// paskutinis žingsnis būtų žengtas ant išmatuotų įrodymų, ne ant optimizmo. Šie vartai
// atsisako sėkmės deklaracijos, kai įrodymų nėra, jie neatributuojami arba apie kitą
// konfigūraciją. Jokios benchmark metrikos neperskaičiuojama ir joks savas verdiktas
// nevedamas (BENCH-11 palieka generuotą raportą autoritetu) — skaitomi artefaktai ir
// lyginamos eilutės.
//
// Kurie laukai riša įrodymus: skaitomas `compressionConfig.digest` iš run-identity
// sidecar'o (`<ledger>.identity.json`), NE `identity.configHash` — pastarasis yra suite
// konfigo hash'as, dokumentuotai be kompresijos digest'o, o raporto generatorius šiandien
// rašo `configHash: ""`, tad jo lyginimas būtų amžinas false-fail, ne patikra.
//
// Kas niekada nevartuojama ir du canary faktai, kurie vartuojami (task 0008):
// `"canary"` stovinti vėliava NEvartuojama dėl įrodymų — canary yra stadija, kuri tuos
// įrodymus GAMINA, tad reikalauti jų būtų padaryti kopėčias neįlipamas. Bet du faktai
// apie gyvą canary skaitomi, ir nė vienas nėra įrodymų reikalavimas:
//   * `canary-arrested` (BLOKUOJA) — loop'o kill switch'as sustabdė šią feature; repo
//     negali būti skelbiamas užbaigtu, kol jo paties suveikęs guardrail'as tebestovi.
//   * `canary-not-observed` (ĮSPĖJA) — kohorta apdorojo bent `silentCanaryObservations`
//     context pack'ų ir nė vienas šios feature nežymi: matavimas, kuris niekada neateis.
//
// `stale-identity` čia reiškia: "įrodymų tapatybė nėra dabartinės kompresijos
// konfigūracijos" — nesama, neperskaitoma arba kitokia. Vienas kodas vienam faktui.
//
// Įvardintos ribos: (1) AG/benchmark/reports/**, results/** ir telemetrija yra gitignored
// lokalūs artefaktai, tad šviežiame checkout'e įjungta vėliava blokuoja — tyčinė
// fail-closed kryptis. (2) Raporto<->sidecar'o susiejimas neįrodomas: įrodoma "priimtas
// verdiktas egzistuoja" ir "run'as po šia konfigūracija egzistuoja", ne kad tai tas pats
// run'as. (3) Hook profilis nevertinamas: varianto `hookProfile` skaitomas raportavimui
// ir niekada sprendimui. Nukrypimas nuo projektinės lentelės: kai AG/benchmark
// neinstaliuotas, emituojamas TAS VIENAS issue ir sustojama — visi kiti šaltiniai gyvena
// tame pakete ir tik perfrazuotų tą patį nebuvimą.

import path from "node:path";
import {
  arrestedContextCompressionFeatures,
  type ContextCompressionArrestView,
} from "../../domain/policies/compression/arrest.js";
import { enabledContextCompressionFeatures } from "../../domain/policies/compression/canary.js";
import {
  CONTEXT_COMPRESSION_CANARY,
  CONTEXT_COMPRESSION_FEATURES,
  defaultContextCompressionConfig,
  parseContextCompressionConfig,
  type ContextCompressionConfig,
  type ContextCompressionFeature,
} from "../../domain/policies/compression/features.js";
import { BENCHMARK_PACKAGE_RELATIVE_PATH } from "../benchmark/suite-report-view.js";
import {
  contextCompressionConfigPath,
  readContextCompressionArrestState,
} from "../context-pack/effective-compression-policy.js";
import { computeCompressionConfigDigest } from "./compression-config-digest.js";
import {
  COMPRESSION_QUALITY_REASONS,
  type CheckCompressionQualityOptions,
  type CompressionQualityCheckResult,
  type CompressionQualityFinding,
  type CompressionQualityFsPort,
} from "./compression-quality-model.js";
import {
  abbreviateDigest,
  acceptedVariantFor,
  canonicalFeatureSet,
  checkCanaryEvidence,
  checkCanaryGuardrails,
  describeRunIdentityCap,
  describeVariants,
  readCompressionSection,
  scanRunIdentitySidecars,
  RUN_IDENTITY_RELATIVE_DIRECTORY,
} from "./compression-quality-evidence.js";

/**
 * Ar įjungtos kompresijos vėliavos yra paremtos įrodymais.
 *
 * Niekada nemeta: klaida vartų viduje raportuojama kaip blocked vartai — ta pati laikysena
 * kaip `checkBenchmarkEvidence` — tad ji negali nuversti visos final-audit kompozicijos.
 */
export async function checkCompressionQuality(
  fs: CompressionQualityFsPort,
  options: CheckCompressionQualityOptions = {},
): Promise<CompressionQualityCheckResult> {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const runtimeRoot = options.runtimeRoot ?? path.join(projectRoot, "vq");
  try {
    return await evaluate(fs, projectRoot, runtimeRoot, options);
  } catch (error: unknown) {
    return {
      ok: false,
      status: "blocked",
      enabled_features: [],
      canary_features: [],
      arrested_features: [],
      config_digest: "",
      reasons: [],
      issues: [`compression-quality-check:${error instanceof Error ? error.message : String(error)}`],
      warnings: [],
    };
  }
}

async function evaluate(
  fs: CompressionQualityFsPort,
  projectRoot: string,
  runtimeRoot: string,
  options: CheckCompressionQualityOptions,
): Promise<CompressionQualityCheckResult> {
  // Vienas skaitymas: digest'as ir vėliavų aibė privalo aprašyti tuos pačius baitus, tad
  // dokumentas parsinamas kartą ir iš tos reikšmės vedami ir validuotas view, ir digest'as.
  const raw = (await fs.readTextFileIfExists(contextCompressionConfigPath(runtimeRoot))) ?? "";
  const document: unknown = raw.trim() ? JSON.parse(raw) : undefined;
  const config: ContextCompressionConfig =
    document === undefined ? defaultContextCompressionConfig() : parseContextCompressionConfig(document);
  const digest = document === undefined ? "" : computeCompressionConfigDigest(document);

  const enabled = enabledContextCompressionFeatures(config);
  const canary = CONTEXT_COMPRESSION_FEATURES.filter(
    (feature) => config.features[feature] === CONTEXT_COMPRESSION_CANARY,
  );

  // Task 0008: skaitoma PRIEŠ vakuuminį return. Repo, kurio visos vėliavos stovi
  // `"canary"`, anksčiau palikdavo funkciją čia — būtent gyvos kohortos būsenoje.
  const arrestView = await readContextCompressionArrestState(fs, runtimeRoot);
  const canaryGuardrails = await checkCanaryGuardrails(fs, runtimeRoot, config, canary, arrestView);

  // Vakuuminis pass ĮRODYMŲ klausimams, ir joks benchmark artefaktas jam neskaitomas: be
  // `true` stovinčios vėliavos nėra promotion teiginio, kurį reikėtų paremti, o vartai,
  // reikalaujantys įrodymų niekieno nepradėtam rollout'ui, blokuotų kiekvieną repo,
  // palikusį kompresiją išjungtą.
  if (enabled.length === 0) return finalize(enabled, canary, arrestView, digest, canaryGuardrails);

  // Klausiama PRIEŠ skaitant raportą ir neišvedama iš reader'io "missing" priežasties:
  // "šioje instaliacijoje nėra benchmark'o" ir "šis repo savo benchmark'o nepaleido" —
  // skirtingi faktai su skirtingais taisymais. Kitaip nei BENCH-12 vartuose tai NĖRA
  // `not_applicable` — vėliavos įjungtos medyje, kuris negali pagaminti joms įrodymų.
  const packageInstalled = await fs
    .statPath(path.join(projectRoot, ...BENCHMARK_PACKAGE_RELATIVE_PATH.split("/")))
    .then((stats) => stats.kind === "directory")
    .catch(() => false);
  if (!packageInstalled) {
    return finalize(enabled, canary, arrestView, digest, [
      {
        reason: "missing-verdict",
        text:
          `compression features are enabled but ${BENCHMARK_PACKAGE_RELATIVE_PATH} is not part of this ` +
          "installation, so no variant verdict can exist here; turn the flags off or install the benchmark workspace.",
      },
      ...canaryGuardrails,
    ]);
  }

  const envelope: CompressionQualityFinding[] = [];
  const registry: CompressionQualityFinding[] = [];
  const perFeature: CompressionQualityFinding[] = [];
  const combination: CompressionQualityFinding[] = [];

  const section = await readCompressionSection(fs, projectRoot, options, envelope);
  if (section !== undefined) {
    if (section.registryVersion !== config.version) {
      registry.push({
        reason: "feature-set-mismatch",
        text:
          `the report's compression registry version (${section.registryVersion}) is not the ` +
          `configuration's (${config.version}), so its variants name a different flag registry than the one enabled here`,
      });
    }

    for (const feature of enabled) {
      if (acceptedVariantFor(section, [feature]) !== undefined) continue;
      perFeature.push({
        reason: "missing-verdict",
        text:
          `no accepted compression variant measures ${feature} on its own` +
          `${describeVariants(section, [feature])}`,
      });
    }

    // Tik realiai kombinacijai: su viena vėliava aibės klausimas yra jau užduotas
    // per-feature klausimas.
    if (enabled.length >= 2 && acceptedVariantFor(section, enabled) === undefined) {
      combination.push({
        reason: "feature-set-mismatch",
        text:
          `no accepted compression variant measures the enabled set (${canonicalFeatureSet(enabled).join(", ")}); ` +
          "contributions are not additive, so accepted single-feature verdicts do not establish the combination" +
          `${describeVariants(section, enabled)}`,
      });
    }
  }

  const identity = await scanRunIdentitySidecars(fs, projectRoot, digest);
  const identityFindings: CompressionQualityFinding[] =
    identity.matched > 0
      ? []
      : [
          {
            reason: "stale-identity",
            text:
              `${RUN_IDENTITY_RELATIVE_DIRECTORY} holds ${identity.total} record(s), ${identity.unreadable} ` +
              `unreadable${describeRunIdentityCap(identity)}, and none of them records the compression ` +
              `configuration digest ${abbreviateDigest(digest)} the enabled flag(s) were read from`,
          },
        ];

  const canaryFindings = await checkCanaryEvidence(fs, runtimeRoot, enabled);

  return finalize(enabled, canary, arrestView, digest, [
    ...envelope,
    ...registry,
    ...perFeature,
    ...combination,
    ...identityFindings,
    ...canaryFindings,
    ...canaryGuardrails,
  ]);
}

function finalize(
  enabled: readonly ContextCompressionFeature[],
  canary: readonly ContextCompressionFeature[],
  arrestView: ContextCompressionArrestView,
  digest: string,
  findings: readonly CompressionQualityFinding[],
): CompressionQualityCheckResult {
  const blocking = findings.filter((finding) => finding.severity !== "warn");
  const warning = findings.filter((finding) => finding.severity === "warn");
  const ok = blocking.length === 0;
  return {
    ok,
    status: ok ? (warning.length === 0 ? "ok" : "warning") : "blocked",
    enabled_features: [...enabled],
    canary_features: [...canary],
    arrested_features: arrestedContextCompressionFeatures(arrestView),
    config_digest: digest,
    // Tik blokuojantys radiniai vardija `reason`: `reasons` yra tai, ką
    // `describeCompressionQuality` renderina po žodžio "blocked", o warning kodas ten
    // aprašytų pass'ą kaip sustojimą.
    reasons: COMPRESSION_QUALITY_REASONS.filter((reason) =>
      blocking.some((finding) => finding.reason === reason),
    ),
    issues: blocking.map((finding) => `${finding.reason}: ${finding.text}`),
    warnings: warning.map((finding) => `${finding.reason}: ${finding.text}`),
  };
}
