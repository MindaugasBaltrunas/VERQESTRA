// Canary kohortos taisyklės. Kohorta yra TASK'O savybė, ne flag'o: visi "canary" flag'ai
// matuojami ant tos pačios task'ų dalies. Bucket'as — deterministinis sha256 be laikrodžio
// ir atsitiktinumo (pin'uotas fixture bucket lentele: hash įvesties pakeitimas tyliai
// perskirstytų visas gyvas kohortas). Behaviour etalon: AG_loop context-compression canary pusė.

import { sha256Hex } from "../../../shared/hash.js";
import {
  CONTEXT_COMPRESSION_CANARY,
  CONTEXT_COMPRESSION_FEATURES,
  type ContextCompressionConfig,
  type ContextCompressionFeature,
} from "./features.js";

/** Kiek bucket'ų dalija task'ų erdvę — `percent` yra tiesiog bucket'ų riba. */
export const CONTEXT_COMPRESSION_CANARY_BUCKETS = 100;

/**
 * Ar flag'as įjungtas VISIEMS task'ams. Sąmoningai be task konteksto, todėl `"canary"`
 * čia yra IŠJUNGTA — fail-closed atsakymas kvietėjui, kuris apie task'ą nieko nežino.
 */
export function isContextCompressionFeatureEnabled(
  config: ContextCompressionConfig,
  feature: ContextCompressionFeature,
): boolean {
  return config.features[feature] === true;
}

/**
 * Deterministinis task'o bucket'as [0, 100). Task id normalizuojamas (trim+lowercase),
 * nes kohorta skaičiuojama keliuose procesuose su skirtinga rašyba; salt neša ILGIO
 * prefiksą, kad dvi skirtingos (salt, task) poros nesudarytų tos pačios hash eilutės.
 * Separatorius tarp salt ir taskId yra NUL (istorinis kontraktas — žr. bucket pin testą).
 */
export function contextCompressionCanaryBucket(rawTaskId: string, rawSalt = ""): number {
  const taskId = rawTaskId.trim().toLowerCase();
  const salt = `${rawSalt.length}:${rawSalt}`;
  const digest = Buffer.from(sha256Hex(`${salt}${String.fromCharCode(0)}${taskId}`), "hex");
  return digest.readUInt32BE(0) % CONTEXT_COMPRESSION_CANARY_BUCKETS;
}

/** Ar šis task'as patenka į canary kohortą (bendrą visiems "canary" flag'ams). */
export function isTaskInContextCompressionCanary(config: ContextCompressionConfig, taskId: string): boolean {
  // percent: 0 yra numatytoji būsena — išjungtas canary net nehash'ina.
  if (config.canary.percent <= 0) return false;
  return contextCompressionCanaryBucket(taskId, config.canary.salt) < config.canary.percent;
}

/** Ar flag'as įjungtas ŠIAM task'ui: `true` — visada, `"canary"` — tik kohortai. */
export function isContextCompressionFeatureEnabledForTask(
  config: ContextCompressionConfig,
  feature: ContextCompressionFeature,
  taskId: string,
): boolean {
  const value = config.features[feature];
  if (value === true) return true;
  if (value !== CONTEXT_COMPRESSION_CANARY) return false;
  return isTaskInContextCompressionCanary(config, taskId);
}

/** Įjungti flag'ai kanonine tvarka — telemetrijai ir ataskaitoms. */
export function enabledContextCompressionFeatures(config: ContextCompressionConfig): ContextCompressionFeature[] {
  return CONTEXT_COMPRESSION_FEATURES.filter((feature) => isContextCompressionFeatureEnabled(config, feature));
}

/**
 * Flag'ai, kuriuos ŠIAM task'ui įjungė būtent canary — telemetrijos žymė. Tuščias sąrašas
 * reiškia „kontrolinė grupė" (arba canary nesukonfigūruotas).
 */
export function canaryContextCompressionFeatures(
  config: ContextCompressionConfig,
  taskId: string,
): ContextCompressionFeature[] {
  if (!isTaskInContextCompressionCanary(config, taskId)) return [];
  return CONTEXT_COMPRESSION_FEATURES.filter((feature) => config.features[feature] === CONTEXT_COMPRESSION_CANARY);
}
