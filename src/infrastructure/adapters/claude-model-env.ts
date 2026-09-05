// Claude PROVIDER ADAPTERIS (etalono task 1109; orchestrator/runtime/claude.ts +
// core/config.ts models pusė). Maršrutavimo sprendimą priima provider-neutralus sluoksnis
// (domain/tokens/routing-tier + application/token-governance/route-model); šis failas yra
// vienintelė vieta, kur neutrali pakopa virsta konkrečiu Claude modeliu. Kol mapping'as
// gyvena tik čia, modelių kartos keitimas (ar antras provideris) nereikalauja liesti nė
// vienos maršrutavimo taisyklės. Konfigo failas: `vq/config/models.env`.

import path from "node:path";
import {
  AUTO_ESCALATION_CEILING,
  escalateRoutingTier,
  type RoutingTier,
} from "../../domain/tokens/routing-tier.js";
import { classifyTaskRiskTier } from "../../application/token-governance/route-model.js";
import { nodeFsAdapter } from "../fs/node-fs-adapter.js";

// Modelio pakopos nuo žemiausios iki aukščiausios. Eskalacija juda tik aukštyn
// ir užsifiksuoja ties ESCALATION_TIER_CEILING (opus).
export const modelTiers = ["haiku", "sonnet", "opus", "fable"] as const;

export type ModelTier = (typeof modelTiers)[number];

// Provider mapping'as: neutrali pakopa <-> Claude pakopa. Abi lentelės laikomos
// šalia viena kitos, kad nesutapimas būtų matomas iš karto.
const ROUTING_TIER_BY_MODEL_TIER: Record<ModelTier, RoutingTier> = {
  haiku: "routine",
  sonnet: "standard",
  opus: "advanced",
  fable: "critical",
};

const MODEL_TIER_BY_ROUTING_TIER: Record<RoutingTier, ModelTier> = {
  routine: "haiku",
  standard: "sonnet",
  advanced: "opus",
  critical: "fable",
};

export function routingTierOfModelTier(tier: ModelTier): RoutingTier {
  return ROUTING_TIER_BY_MODEL_TIER[tier];
}

export function modelTierOfRoutingTier(tier: RoutingTier): ModelTier {
  return MODEL_TIER_BY_ROUTING_TIER[tier];
}

// Retry eskalacijos lubos. fable NĖRA pasiekiamas per automatinę eskalaciją —
// etalono 2026-07-22 incidentas: opus task'as po vienos nesėkmės gavo fable dispatch'ą
// už ~$19 be jokių vartų. fable naudojamas tik kai supervisor/žmogus jį parenka
// EXPLICIT (selected_model="fable"); tada bazinė pakopa išlaikoma, bet eskalacija
// jos niekada neįveda pati. Reikšmė išvedama iš neutralių lubų, kad abu sluoksniai
// negalėtų išsiskirti.
export const ESCALATION_TIER_CEILING: ModelTier = modelTierOfRoutingTier(AUTO_ESCALATION_CEILING);

export function normalizeModelTier(selected: string): ModelTier {
  for (const tier of modelTiers) {
    if (selected === tier || selected.startsWith(`claude-${tier}`)) {
      return tier;
    }
  }

  return "haiku";
}

/** Supervisor parinkimas (`selected_model`) → neutrali pakopa maršrutizatoriui. */
export function routingTierOfSelection(selected: string): RoutingTier {
  return routingTierOfModelTier(normalizeModelTier(selected));
}

// Kiekvienas nepavykęs bandymas pakelia modelį viena pakopa virš supervisor
// parinkties: žemesnio lygio modeliui suklydus, taisymą perima aukštesnis.
// Lubos — ESCALATION_TIER_CEILING (opus); aukščiau bazinės pakopos nekeliama,
// nebent pati bazė jau yra virš lubų (explicit fable parinktis išlaikoma).
// Aritmetika gyvena neutraliame domene (escalateRoutingTier) — čia lieka tik
// provider vertimas.
export function escalateModelTier(selected: string, failedAttempts: number): ModelTier {
  return modelTierOfRoutingTier(escalateRoutingTier(routingTierOfSelection(selected), failedAttempts));
}

// Modelio ID gali ateiti iš vq/config/models.env, o vėliau įterpiamas į
// PowerShell/shell paleidiklius (claude-headless, claude-launcher). Validuojame
// formatą prieš naudojimą, kad kompromituotas config negalėtų injektuoti komandų
// (pvz. reikšmė "x'; calc; '" išeitų iš string literalo).
const SAFE_MODEL_ID = /^[A-Za-z0-9._:-]+$/;

export function assertSafeModelId(model: string): string {
  if (!SAFE_MODEL_ID.test(model)) {
    throw new Error(
      `Nesaugus modelio ID (leidžiami tik raidės, skaičiai ir '.', '_', ':', '-'): ${JSON.stringify(model)}`,
    );
  }
  return model;
}

export type ModelsEnv = {
  claudeHaikuModel: string;
  claudeSonnetModel: string;
  claudeOpusModel: string;
  claudeFableModel: string;
};

export function resolveModelTier(tier: ModelTier, modelsEnv: ModelsEnv): string {
  switch (tier) {
    case "fable":
      return assertSafeModelId(modelsEnv.claudeFableModel);
    case "opus":
      return assertSafeModelId(modelsEnv.claudeOpusModel);
    case "sonnet":
      return assertSafeModelId(modelsEnv.claudeSonnetModel);
    default:
      return assertSafeModelId(modelsEnv.claudeHaikuModel);
  }
}

/** Maršrutizatoriaus sprendimas → realus modelio ID (su ta pačia ID validacija). */
export function resolveRoutedModel(tier: RoutingTier, modelsEnv: ModelsEnv): string {
  return resolveModelTier(modelTierOfRoutingTier(tier), modelsEnv);
}

export function selectClaudeModel(selected: string, modelsEnv: ModelsEnv): string {
  return resolveModelTier(normalizeModelTier(selected), modelsEnv);
}

/**
 * Parenka modelio pakopą pagal užduoties teksto sudėtingumą: opus aukštos rizikos
 * darbams (architektūra, DB, security, public API), sonnet source kodo keitimui,
 * haiku paprastoms/rutininėms užduotims. Naudojama ten, kur reikia parinkti modelį
 * dar prieš žinant tikslų scope (preflight, diagnosis bazė). Klaidingai žema pakopa
 * nėra pavojinga: retry eskalacija (escalateModelTier) nesėkmę pakelia pakopa aukščiau.
 *
 * Pačios klasifikavimo taisyklės gyvena maršrutizatoriuje (classifyTaskRiskTier) —
 * dispatch'as ir šis kelias negali klasifikuoti skirtingai.
 */
export function classifyTaskComplexity(taskText: string): ModelTier {
  return modelTierOfRoutingTier(classifyTaskRiskTier(taskText).tier);
}

/**
 * `vq/config/models.env` krautuvas (etalono core/config.ts `loadModelsEnv` 1:1, keliai —
 * vq layout). Trūkstamas failas ar raktas krenta į einamosios kartos numatytuosius ID.
 */
export async function loadModelsEnv(runtimeRoot: string): Promise<ModelsEnv> {
  const env = await nodeFsAdapter.readTextFileIfExists(path.join(runtimeRoot, "config", "models.env"));
  const values = parseEnv(env);

  return {
    claudeHaikuModel: values["CLAUDE_HAIKU_MODEL"] ?? "claude-haiku-4-5",
    claudeSonnetModel: values["CLAUDE_SONNET_MODEL"] ?? "claude-sonnet-5",
    claudeOpusModel: values["CLAUDE_OPUS_MODEL"] ?? "claude-opus-5",
    claudeFableModel: values["CLAUDE_FABLE_MODEL"] ?? "claude-fable-5",
  };
}

// Windows Notepad ir kai kurie kiti redaktoriai .env failą išsaugo su vedančiu UTF-8 BOM
// (U+FEFF). Nenuimtas jis prilimpa prie pirmo rakto vardo, ir pirma eilutė tyliai
// nebeatitinka rakto regex'o — pirmas modelio ID (pvz. CLAUDE_HAIKU_MODEL) grįžta į default.
const BOM = String.fromCharCode(0xfeff);

/** `.env` stiliaus teksto parseris (etalono core/config.ts `parseEnv` 1:1). */
export function parseEnv(env: string | undefined): Record<string, string> {
  const values: Record<string, string> = {};
  if (!env) {
    return values;
  }

  const withoutBom = env.startsWith(BOM) ? env.slice(BOM.length) : env;
  for (const rawLine of withoutBom.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) {
      continue;
    }

    const key = match[1] ?? "";
    values[key] = parseEnvScalar(match[2] ?? "");
  }

  return values;
}

function parseEnvScalar(rawValue: string): string {
  const value = rawValue.trim();
  if (value.startsWith('"')) {
    return readQuotedValue(value, '"');
  }
  if (value.startsWith("'")) {
    return readQuotedValue(value, "'");
  }

  const commentStart = value.search(/\s#/);
  return (commentStart >= 0 ? value.slice(0, commentStart) : value).trimEnd();
}

function readQuotedValue(value: string, quote: '"' | "'"): string {
  let result = "";
  let escaped = false;

  for (let index = 1; index < value.length; index += 1) {
    const char = value[index];
    if (escaped) {
      result += char;
      escaped = false;
      continue;
    }
    if (quote === '"' && char === "\\") {
      escaped = true;
      continue;
    }
    if (char === quote) {
      return result;
    }
    result += char;
  }

  return result;
}
