// Task 0041: deterministinis, task-lokalus MCP įrankių šaltinis `dispatch_tool_schema`
// kandidatams. Behaviour etalon: AG_loop application/context-pack/mcp-capability-registry.ts;
// FS — per ContextPackFileSystemPort, registro kelias — VERQESTRA `vq/config`.
//
// Iki šio žingsnio dinaminiai `mcp__<server>__<tool>` vardai buvo skaitomi iš PRAEITOS
// sesijos log'o — einamojo task'o optimizacijos sprendimą lemdavo svetimas artefaktas, o
// lygiagrečiame loop'e tai dar ir cross-worker kontaminacija. Šis modulis pakeičia įvestį,
// o NE politiką: tool-budget profilis lieka vienintelis sprendėjas, KAS gali būti šalinama.
//
// Pirmenybės tvarka (normatyvi): 1) REGISTRAS (statinis, git-peržiūrimas, identiškas
// kiekvienam worker'iui) → 2) ŠIOS sesijos aplinkos snapshot'as → 3) FAIL-OPEN (dinaminės
// MCP schemos NEkompresuojamos, priežastis įvardijama `source` eilutėje).

import path from "node:path";
import { z } from "zod";
import { parseWithSchema } from "../../shared/schema.js";
import type { ContextPackFileSystemPort } from "./ports.js";

/**
 * Šio dispatch'o MCP įrankių pjūvis. Tipas gyvena čia, nes jo PRASMĘ apibrėžia šio
 * modulio pirmenybės tvarka; žemesni sluoksniai priima tik struktūrinį minimumą.
 */
export type DispatchMcpCapabilities = {
  /** Ar šaltinis autoritetingas. `false` = NEŽINOME → dinaminės MCP schemos nekompresuojamos. */
  known: boolean;
  /** Pilni MCP įrankių vardai (`mcp__<server>__<tool>`); prasminga tik kai `known`. */
  tools: readonly string[];
  /** Žmogui skaitoma šaltinio (arba jo nebuvimo) priežastis — eina į dispatch log'ą. */
  source: string;
};

/** Registro failas config kataloge. Nebuvimas yra galiojantis atsakymas, ne klaida. */
export const MCP_CAPABILITY_REGISTRY_FILE = "mcp-capabilities.json";

/**
 * Registro forma. Įrankiai deklaruojami PER SERVERĮ, be prefikso: pilnas vardas
 * (`mcp__<server>__<tool>`) išvedamas čia, kad ranka įrašytas prefiksas negalėtų tyliai
 * prasilenkti su realiu vykdytojo vardu.
 */
const mcpCapabilityRegistrySchema = z.object({
  version: z.literal(1),
  servers: z.record(z.string().trim().min(1), z.object({ tools: z.array(z.string().trim().min(1)) })),
});

export type McpCapabilityRegistry = z.infer<typeof mcpCapabilityRegistrySchema>;

/** MCP įrankio vardo forma — viena vieta, kuri ją sudaro. */
export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server.trim()}__${tool.trim()}`;
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

/**
 * Pjūvis iš aiškaus įrankių sąrašo (pvz. šios sesijos `system`/`init` įvykio).
 *
 * `source` yra privalomas ir keliauja į log'ą: pjūvis be įvardinto šaltinio būtų lygiai
 * tokia pat nematoma įvestis, kokią šis task'as ir šalina.
 */
export function dispatchMcpCapabilitiesFromOfferedTools(
  offeredTools: readonly string[],
  source: string,
): DispatchMcpCapabilities {
  return {
    known: true,
    tools: sortedUnique(offeredTools.map((tool) => tool.trim()).filter((tool) => tool.startsWith("mcp__"))),
    source,
  };
}

/** Pjūvis iš validuoto registro turinio. Tuščias `servers` = „serverių NĖRA", ne „nežinau". */
export function dispatchMcpCapabilitiesFromRegistry(
  registry: McpCapabilityRegistry,
  source: string,
): DispatchMcpCapabilities {
  const tools: string[] = [];
  for (const [server, entry] of Object.entries(registry.servers)) {
    for (const tool of entry.tools) tools.push(mcpToolName(server, tool));
  }
  return { known: true, tools: sortedUnique(tools), source };
}

/**
 * Nežinomas pjūvis: fail-open į pilnas MCP schemas su įvardinta priežastimi.
 *
 * Eksportuota, nes tai yra ir `dispatch_tool_schema=false` kelio reikšmė — išjungtas
 * flag'as neturi daryti NĖ VIENO papildomo skaitymo, tad jam reikia tuščio pjūvio be I/O.
 */
export function unknownDispatchMcpCapabilities(reason: string): DispatchMcpCapabilities {
  return { known: false, tools: [], source: reason };
}

/**
 * Registras iš `vq/config/mcp-capabilities.json`.
 *
 * Trys baigtys ir visos trys yra ATSAKYMAS, ne klaida:
 *  - failo nėra          -> `known:false`, „registry absent";
 *  - failas nevalidus    -> `known:false`, „registry unreadable: <priežastis>";
 *  - failas validus      -> `known:true` su išvestais pilnais vardais.
 *
 * Funkcija niekada nemeta: sugadintas neprivalomas konfigas negali nutraukti dispatch'o.
 */
export async function loadMcpCapabilityRegistry(
  fs: ContextPackFileSystemPort,
  configRootDir: string,
): Promise<DispatchMcpCapabilities> {
  const configPath = path.join(configRootDir, "config", MCP_CAPABILITY_REGISTRY_FILE);
  const raw = await fs.readTextFileIfExists(configPath);
  if (raw === undefined) {
    return unknownDispatchMcpCapabilities(`registry absent: ${configPath}`);
  }
  try {
    const registry = parseWithSchema(mcpCapabilityRegistrySchema, JSON.parse(raw) as unknown, "MCP capability registry");
    return dispatchMcpCapabilitiesFromRegistry(registry, `registry: ${configPath}`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return unknownDispatchMcpCapabilities(`registry unreadable: ${configPath}: ${message}`);
  }
}

/**
 * Galutinis pjūvis pagal normatyvią pirmenybės tvarką (registras -> aplinkos snapshot'as ->
 * fail-open). Gryna funkcija: tas pats įvesties porinys visada duoda tą patį atsakymą,
 * nepriklausomai nuo dispatch istorijos, kitų worker'ių ar task'ų vykdymo tvarkos.
 */
export function selectDispatchMcpCapabilities(input: {
  registry?: DispatchMcpCapabilities;
  environment?: DispatchMcpCapabilities;
}): DispatchMcpCapabilities {
  if (input.registry?.known) return input.registry;
  if (input.environment?.known) return input.environment;
  const reasons = [input.registry?.source, input.environment?.source].filter(
    (reason): reason is string => typeof reason === "string" && reason.trim().length > 0,
  );
  return unknownDispatchMcpCapabilities(
    reasons.length > 0
      ? `no deterministic MCP capability source (${reasons.join("; ")})`
      : "no deterministic MCP capability source (no registry, no task-local environment snapshot)",
  );
}

/**
 * Vienintelis dispatch'o įėjimo taškas: „ar feature įjungtas" + config šaknis -> pjūvis.
 *
 * Išjungtas `dispatch_tool_schema` NEDARO nė vieno skaitymo — flag=false kelias privalo
 * likti nepakitęs ir elgesiu, ir I/O.
 */
export async function resolveDispatchMcpCapabilities(input: {
  enabled: boolean;
  fs: ContextPackFileSystemPort;
  configRootDir: string;
  environment?: DispatchMcpCapabilities;
}): Promise<DispatchMcpCapabilities> {
  if (!input.enabled) return unknownDispatchMcpCapabilities("dispatch_tool_schema disabled");
  return selectDispatchMcpCapabilities({
    registry: await loadMcpCapabilityRegistry(input.fs, input.configRootDir),
    ...(input.environment === undefined ? {} : { environment: input.environment }),
  });
}
