// Compression rollout vartų kontraktai: rezultato tipai, priežasčių kodai, portas ir
// vienos eilutės aprašas release proof'ui. Elgesio etalonas: AG_loop
// application/release-readiness/compression-quality-check.ts (task 1206 + task 0008).
// Logika gyvena compression-quality-check.ts / compression-quality-evidence.ts — čia tik
// bendri tipai, kad tarp tų dviejų failų nebūtų ciklo.

import type { ContextCompressionFeature } from "../../domain/policies/compression/features.js";
import type { BenchmarkFsPort } from "../benchmark/suite-report-view.js";
import type { ContextPackFileSystemPort } from "../context-pack/ports.js";

/**
 * Kodėl kompresijos vėliava negali stovėti ten, kur stovi.
 *
 * - `missing-verdict`: joks priimtas varianto verdiktas nedengia įjungtos feature.
 * - `stale-identity`: įrodymų tapatybė nėra dabartinės kompresijos konfigūracijos.
 * - `feature-set-mismatch`: įrodymai dengia kitą vėliavų aibę (arba registrą) nei įjungta.
 * - `no-canary-evidence`: niekas šiame repo nerodo, kad ĮJUNGTA feature kada nors bėgo canary arm'e.
 * - `canary-arrested`: loop'o kill switch'as sustabdė šią feature ir operatorius jo nenuėmė.
 * - `canary-not-observed`: canary, turėjusi savo progas ir nė karto nepritaikyta (warning).
 *
 * Nauji kodai APPENDINAMI, ne įterpiami: `reasons` renderinamas šia tvarka ir release
 * proof įrašo tą eilutę.
 */
export const COMPRESSION_QUALITY_REASONS = [
  "missing-verdict",
  "stale-identity",
  "feature-set-mismatch",
  "no-canary-evidence",
  "canary-arrested",
  "canary-not-observed",
] as const;

export type CompressionQualityReason = (typeof COMPRESSION_QUALITY_REASONS)[number];

/**
 * `warning` yra PASS: `ok` lieka `true` ir final audit dėl jo neblokuojamas.
 *
 * Skirtis reikalinga, nes du canary faktai, kuriuos šie vartai skaito, turi skirtingus
 * atsakymus — arrest'ui reikia operatoriaus PRIEŠ release, niekad nepritaikytai canary —
 * kada nors; juos suplojus arba blokuotume nekenksmingą, arba paslėptume kitą.
 */
export type CompressionQualityStatus = "ok" | "warning" | "blocked";

export type CompressionQualityCheckResult = {
  ok: boolean;
  status: CompressionQualityStatus;
  /** Vėliavos, stovinčios `true`, registro kanonine tvarka. */
  enabled_features: ContextCompressionFeature[];
  /** Vėliavos, stovinčios `"canary"`. Įrodymų iš jų nereikalaujama; žr. check failo antraštę. */
  canary_features: ContextCompressionFeature[];
  /** Features, kurias loop'o kill switch'as sustabdė, registro kanonine tvarka. */
  arrested_features: ContextCompressionFeature[];
  /** Dokumento, iš kurio perskaitytos vėliavos, digest'as; `""` kai dokumento nėra. */
  config_digest: string;
  /** Skirtingi BLOKUOJANTYS kodai {@link COMPRESSION_QUALITY_REASONS} tvarka. */
  reasons: CompressionQualityReason[];
  /** Po vieną `"<reason>: <sakinys>"` kiekvienam blokuojančiam radiniui, įrodymų tvarka. */
  issues: string[];
  /** Po vieną `"<reason>: <sakinys>"` kiekvienam neblokuojančiam radiniui. Niekada neliečia `ok`. */
  warnings: string[];
};

/**
 * Vartų IO portas: context-pack skaitymo pusė (konfigas, arrest markeris, telemetrija) +
 * benchmark'o gynybinis statPath/readTextFile (raportas, sidecar'ai) + katalogo sąrašas
 * run-identity skenavimui. Struktūriškai vienas E4 fs adapteris dengia visus tris.
 */
export type CompressionQualityFsPort = ContextPackFileSystemPort &
  BenchmarkFsPort & {
    /** Katalogo įrašų vardai; `[]` kai katalogo nėra (nebuvimas — atsakymas, ne klaida). */
    listDirectory(absoluteDir: string): Promise<string[]>;
  };

export type CheckCompressionQualityOptions = {
  /** Repo šaknis — čia gyvena AG/benchmark artefaktai. Default: process.cwd(). */
  projectRoot?: string;
  /** VERQESTRA runtime šaknis (vq/…): konfigas, arrest markeris, telemetrija. Default: <projectRoot>/vq. */
  runtimeRoot?: string;
  /** Testuose injektuojama, kad vartus būtų galima varyti be git repo (raporto freshness). */
  currentAgCommit?: (projectRoot: string) => Promise<string | undefined>;
};

/**
 * `severity` default'as kiekvienoje jį praleidžiančioje kvietimo vietoje yra blokuojantis —
 * saugusis default'as.
 */
export type CompressionQualityFinding = {
  reason: CompressionQualityReason;
  text: string;
  severity?: "block" | "warn";
};

/** Vienos eilutės statusas, kurį committed release proof įrašo šiems vartams. */
export function describeCompressionQuality(result: CompressionQualityCheckResult): string {
  // `ok` klausiamas pirmas, kad vidinė klaida — kuri nieko neįjungia ir nieko nepraneša —
  // niekada nebūtų aprašyta kaip vakuuminis pass.
  if (!result.ok) {
    return `blocked: ${result.reasons.length > 0 ? result.reasons.join(", ") : result.issues[0] ?? "unknown"}`;
  }
  const enabled =
    result.enabled_features.length === 0
      ? "ok (no compression feature enabled)"
      : `ok (${result.enabled_features.join(", ")})`;
  // Pridedama, ne pakeičiama: warning'as negali paversti pass'o kažkuo, ko skaitytojas,
  // skenuojantis dėl "ok", nepamatytų, o tylus warning'as būtų joks warning'as.
  return result.warnings.length === 0 ? enabled : `${enabled}; ${result.warnings.length} warning(s)`;
}
