// The effective compression policy — one composition, three call sites (task 0038).
// Behaviour etalon: AG_loop application/context-pack/effective-compression-policy.ts.
// VERQESTRA skirtumas (WBR VQ-302): grynasis branduolys (dependency lentelė, resolve,
// describe, arrestDecision) jau gyvena domain/policies/compression (VQ-203, pin'inta
// compression-policy fixture) — čia lieka TIK IO kompozicija per portus.
//
// "Authored config + arrest marker -> the config a run may actually act on" buvo išrašyta
// ranka trijose vietose; trys vienos kompozicijos kopijos yra būtent tai, kaip arrest'ą
// pagerbia dvi iš jų ir pamiršta trečia. Šis modulis yra ta kompozicija, vieną kartą.
//
// It deliberately does NOT import the cluster barrel: assemble -> policy -> barrel ->
// assemble would close an import cycle. Callers deep-import this file.

import path from "node:path";
import {
  applyContextCompressionArrest,
  defaultContextCompressionArrestState,
  parseContextCompressionArrestState,
  type ContextCompressionArrestView,
} from "../../domain/policies/compression/arrest.js";
import { canaryContextCompressionFeatures } from "../../domain/policies/compression/canary.js";
import {
  defaultContextCompressionConfig,
  parseContextCompressionConfig,
  type ContextCompressionConfig,
  type ContextCompressionFeature,
} from "../../domain/policies/compression/features.js";
import {
  describeCompressionDependencyNotice,
  resolveCompressionFeatureDependencies,
  type CompressionDependencyNotice,
} from "../../domain/policies/compression/dependencies.js";
import type { ClockPort, ContextPackFileSystemPort } from "./ports.js";

/** Konfigo ir arrest markerio vietos VERQESTRA runtime šaknyje. */
export function contextCompressionConfigPath(runtimeRoot: string): string {
  return path.join(runtimeRoot, "config", "context-compression.json");
}

export function contextCompressionArrestStatePath(runtimeRoot: string): string {
  return path.join(runtimeRoot, "state", "context-compression-arrest.json");
}

/**
 * Autorinis konfigas: nesamas/tuščias failas → default'ai; nevalidus — META
 * (vienintelis šios kompozicijos throw šaltinis, kaip etalone).
 */
export async function loadContextCompressionConfig(
  fs: ContextPackFileSystemPort,
  runtimeRoot: string,
): Promise<ContextCompressionConfig> {
  const raw = (await fs.readTextFileIfExists(contextCompressionConfigPath(runtimeRoot))) ?? "";
  if (!raw.trim()) {
    return defaultContextCompressionConfig();
  }
  return parseContextCompressionConfig(JSON.parse(raw));
}

/**
 * Arrest markeris: niekada nemeta — nesamas/tuščias failas yra default view, o
 * neperskaitomas turinys (metantis skaitymas arba nevalidus JSON) yra skaitomas atsakymas
 * `unreadable` (arrests everything).
 */
export async function readContextCompressionArrestState(
  fs: ContextPackFileSystemPort,
  runtimeRoot: string,
): Promise<ContextCompressionArrestView> {
  const statePath = contextCompressionArrestStatePath(runtimeRoot);
  let raw: string | undefined;
  try {
    raw = await fs.readTextFileIfExists(statePath);
  } catch (error) {
    // Metantis skaitymas NĖRA „markerio nėra": to atvejo `readTextFileIfExists` niekada
    // nemeta — jis grąžina `undefined`. Čia lieka teisės, sugadinta FS, lenktynės su
    // rašytoju: marker'yje gali gulėti areštai, kurių nematome, tad vienintelis saugus
    // skaitymas yra „viskas areštuota". Tuščias stringas čia reikštų švarų default'ą ir
    // leistų observer'iui tyliai perrašyti operatoriaus markerį.
    return {
      state: defaultContextCompressionArrestState(),
      unreadable: true,
      unreadableReason: `${statePath}: read failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (raw === undefined || !raw.trim()) {
    return { state: defaultContextCompressionArrestState(), unreadable: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return parseContextCompressionArrestState("not json");
  }
  return parseContextCompressionArrestState(parsed);
}

export type EffectiveCompressionPolicy = {
  /**
   * The EFFECTIVE config: every arrested feature forced to `false`, and every feature whose
   * declared dependency is not active forced to `false` too.
   */
  config: ContextCompressionConfig;
  /** Where the narrowing came from — for operator-facing lines, never for a decision. */
  arrestView: ContextCompressionArrestView;
  /**
   * Features this load switched off because a declared dependency is not active. Always
   * present: `[]` means exactly "every declared pair is intact".
   */
  dependencyNotices: CompressionDependencyNotice[];
  /**
   * Features this task got FROM the canary arm, computed off the EFFECTIVE config.
   * Present only when a `taskId` was supplied: `[]` = kontrolinis arm'as; trūkstamas raktas
   * = kohorta apskritai neskaičiuota (task-less kvietėjas).
   */
  canaryFeatures?: ContextCompressionFeature[];
};

/**
 * Loads the config a run must actually behave as, with the arrest already applied.
 *
 * Composition order is normative and load-bearing:
 *  1. `loadContextCompressionConfig` — FIRST, and the ONLY step here that can throw.
 *  2. `readContextCompressionArrestState` — never throws.
 *  3. `applyContextCompressionArrest`.
 *  4. `resolveCompressionFeatureDependencies` — on the arrested config, so an arrest on a
 *     required feature is the reason a dependent one goes inactive.
 *
 * This function introduces NO new throw source of its own — a failure here would be labelled
 * an ENVIRONMENT-scope error by the caller's policy wrapper and take the whole loop down.
 */
export async function loadEffectiveCompressionPolicy(input: {
  fs: ContextPackFileSystemPort;
  clock: ClockPort;
  runtimeRoot: string;
  taskId?: string;
}): Promise<EffectiveCompressionPolicy> {
  const authored = await loadContextCompressionConfig(input.fs, input.runtimeRoot);
  const arrestView = await readContextCompressionArrestState(input.fs, input.runtimeRoot);
  // Arrest FIRST, dependencies second: an arrest on the required feature must be visible to
  // the dependency rule (the `cause: "arrested"` case).
  const { config, notices: dependencyNotices } = resolveCompressionFeatureDependencies(
    applyContextCompressionArrest(authored, arrestView),
    arrestView,
  );
  await announceCompressionDependencyNotices(input, dependencyNotices);
  return {
    config,
    arrestView,
    dependencyNotices,
    // From the EFFECTIVE config, not the authored one: neither an arrested feature nor one
    // held inactive by an unsatisfied dependency is a live canary arm.
    ...(input.taskId === undefined ? {} : { canaryFeatures: canaryContextCompressionFeatures(config, input.taskId) }),
  };
}

/** Where the dependency line lands: the operator's main log, beside every dispatch line. */
export const COMPRESSION_DEPENDENCY_LOG_SEGMENTS = ["logs", "orchestrator.log"] as const;

export function compressionDependencyLogPath(runtimeRoot: string): string {
  return path.join(runtimeRoot, ...COMPRESSION_DEPENDENCY_LOG_SEGMENTS);
}

/**
 * Lines already written by THIS process, so one config mistake is announced once per task.
 * Loop procesas surenka daug taskų; be šito ta pati eilutė kartotųsi, kol nustotų būti skaitoma.
 */
const announcedDependencyLines = new Set<string>();

/**
 * Writes the loud line for each notice. Best effort, and deliberately task-scoped: tik
 * `taskId` turintys kvietėjai skelbia (task-less hook'ai vieną klaidą paverstų tūkstančiais
 * identiškų eilučių). A failed write is swallowed — this composition promises no new throw.
 */
async function announceCompressionDependencyNotices(
  input: { fs: ContextPackFileSystemPort; clock: ClockPort; runtimeRoot: string; taskId?: string },
  notices: readonly CompressionDependencyNotice[],
): Promise<void> {
  if (input.taskId === undefined || notices.length === 0) return;
  for (const notice of notices) {
    const line = `${describeCompressionDependencyNotice(notice)} task=${input.taskId}`;
    const key = `${input.runtimeRoot}${line}`;
    if (announcedDependencyLines.has(key)) continue;
    announcedDependencyLines.add(key);
    try {
      await input.fs.appendTextFile(compressionDependencyLogPath(input.runtimeRoot), `[${input.clock.timestamp()}] ${line}\n`);
    } catch {
      // An operator warning that could abort a dispatch would be a worse outage than the
      // inactive feature it is warning about.
    }
  }
}
