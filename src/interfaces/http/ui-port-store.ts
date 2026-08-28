// UI porto pasirinkimas ir jo persistavimas (etalonas: AG_loop ui/ui-port.ts IO pusė, task 0065).
// Taisyklės — `ui-port-rules.ts`; čia tik šaltiniai, įrašas ir sprendimo eiga.
//
// Pirmenybė sąmoningai tokia: aplinkos kintamasis > `vq/config/commands.env` > persistuotas
// `vq/state/ui-server.json` įrašas > išvestas kandidatas. Aplinka laimi, nes ją nustato procesą
// PALEIDĘS operatorius vienkartiniam paleidimui; konfigas yra ilgalaikis to paties operatoriaus
// pasirinkimas. Abu jie yra AIŠKŪS nurodymai, tad tikrinami fail-fast.
//
// Įrašas gyvena `vq/state`, o ne `vq/config`: runtime prefiksas nepalieka purvino produkto medžio
// (ta pati taisyklė kaip `worker-request.json` ir `loop-control.json`).

import path from "node:path";
import { z } from "zod";
import { toPrettyJson } from "../../shared/json.js";
import {
  InvalidUiPortError,
  UI_PORT_ENV,
  UI_PORT_RANGE_END,
  UI_PORT_RANGE_START,
  isBindableUiPort,
  parseUiPortOverride,
  projectFingerprint,
  uiPortCandidates,
  uiUrl,
  type UiPortProbeResult,
  type UiPortResolution,
  type UiPortSource,
} from "./ui-port-rules.js";

export const UI_SERVER_RECORD_SCHEMA_VERSION = 1;

export const uiServerRecordSchema = z.strictObject({
  schema_version: z.literal(UI_SERVER_RECORD_SCHEMA_VERSION),
  port: z.number().int().min(1).max(65535),
  url: z.string().min(1),
  project_fingerprint: z.string().min(1),
  pid: z.number().int().min(1),
  updated_at: z.string().min(1),
});
export type UiServerRecord = z.infer<typeof uiServerRecordSchema>;

export type UiPortFsPort = {
  /** Failo tekstas arba `undefined`, kai failo nėra. */
  readTextFileIfExists(absolutePath: string): Promise<string | undefined>;
  writeTextFileAtomic(absolutePath: string, content: string): Promise<void>;
  makeDirectory(absoluteDir: string): Promise<void>;
};

export type UiPortPorts = {
  fs: UiPortFsPort;
  env(name: string): string | undefined;
  /** Vienas kandidato zondas; jo fail-closed semantika aprašyta `UiPortProbeResult`. */
  probe(port: number): Promise<UiPortProbeResult>;
  now?: () => Date;
  platform?: NodeJS.Platform;
};

export function uiServerRecordFile(stateDir: string): string {
  return path.join(stateDir, "ui-server.json");
}

export const UI_REBUILD_RECORD_SCHEMA_VERSION = 1;

/**
 * `/api/ui/rebuild` būsenos įrašas (task 058-3). `running` gyvumą įrodo tik kartu su
 * `processIsAlive(pid)` patikra — pats įrašas liudija tik paskutinę ŽINOMĄ būseną.
 */
export const uiRebuildRecordSchema = z.strictObject({
  schema_version: z.literal(UI_REBUILD_RECORD_SCHEMA_VERSION),
  pid: z.number().int().min(1),
  status: z.enum(["running", "ok", "failed"]),
  started_at: z.string().min(1),
  finished_at: z.string().min(1).optional(),
  /** Tik `failed` baigtyje: operatoriui reikia matyti KODĖL, o ne vien tai, kad nepavyko. */
  output_tail: z.string().optional(),
});
export type UiRebuildRecord = z.infer<typeof uiRebuildRecordSchema>;

export function uiRebuildRecordFile(stateDir: string): string {
  return path.join(stateDir, "ui-rebuild.json");
}

/** Tas pats „niekada nemeta" elgesys kaip `readUiServerRecord`: sugadintas įrašas = „nežinome". */
export async function readUiRebuildRecord(
  fs: UiPortFsPort,
  stateDir: string,
): Promise<UiRebuildRecord | undefined> {
  let raw: string | undefined;
  try {
    raw = await fs.readTextFileIfExists(uiRebuildRecordFile(stateDir));
  } catch {
    return undefined;
  }
  if (!raw?.trim()) return undefined;

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return undefined;
  }

  const result = uiRebuildRecordSchema.safeParse(payload);
  return result.success ? result.data : undefined;
}

export async function writeUiRebuildRecord(
  fs: UiPortFsPort,
  stateDir: string,
  record: UiRebuildRecord,
): Promise<void> {
  await fs.makeDirectory(stateDir);
  await fs.writeTextFileAtomic(uiRebuildRecordFile(stateDir), toPrettyJson(record));
}

/** `KEY=value` eilučių skaitymas iš konfigo failo; komentarai ir tuščios eilutės praleidžiamos. */
export function parseEnvFile(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    values[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
  }
  return values;
}

/**
 * Aiškus operatoriaus nurodymas, jei jis yra. Aplinka tikrinama PIRMA ir, skirtingai nei workerių
 * prašymo kelyje, netinkama reikšmė čia NEKRENTA į kitą šaltinį: workerių atveju blogiausia, kas
 * nutinka, yra vienu workeriu mažiau, o čia — operatorius siunčiamas ne tuo adresu.
 */
export async function readUiPortOverride(
  ports: UiPortPorts,
  runtimeRoot: string,
): Promise<{ port: number; source: "env" | "config" } | undefined> {
  const fromEnv = ports.env(UI_PORT_ENV)?.trim();
  if (fromEnv) {
    return { port: parseUiPortOverride(fromEnv, UI_PORT_ENV), source: "env" };
  }

  const commandsEnv = await ports.fs
    .readTextFileIfExists(path.join(runtimeRoot, "config", "commands.env"))
    .catch(() => undefined);
  const fromConfig = parseEnvFile(commandsEnv ?? "")[UI_PORT_ENV]?.trim();
  if (fromConfig) {
    return { port: parseUiPortOverride(fromConfig, `${UI_PORT_ENV} in vq/config/commands.env`), source: "config" };
  }

  return undefined;
}

/**
 * Paskutinis žinomas įrašas. NIEKADA nemeta: kelias kviečiamas kiekvieno loop starto metu, tad
 * sugadintas ar dingęs failas privalo reikšti „įrašo nežinome" ir nuvesti į išvestą kandidatą, o ne
 * nutraukti startą. Įrašo ŠVIEŽUMO jis NEĮRODINĖJA — tai daro tik zondavimas.
 */
export async function readUiServerRecord(ports: UiPortPorts, stateDir: string): Promise<UiServerRecord | undefined> {
  let raw: string | undefined;
  try {
    raw = await ports.fs.readTextFileIfExists(uiServerRecordFile(stateDir));
  } catch {
    return undefined;
  }
  if (!raw?.trim()) return undefined;

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return undefined;
  }

  const result = uiServerRecordSchema.safeParse(payload);
  return result.success ? result.data : undefined;
}

/**
 * Įrašo pasirinktą portą. Rašytojai du — paleidėjas iš karto po spawn'o (kad pasenęs įrašas
 * nepergyventų starto net kai vaikas dar nepakilo) ir pats serveris po `listen` (autoritetas: tik
 * jis žino REALŲ portą, kai buvo prašyta `0`). Abu rašo atomiškai, tad lenktynės gali pakeisti tik
 * tvarką, bet ne turinį į pusiau įrašytą JSON.
 */
export async function writeUiServerRecord(
  ports: UiPortPorts,
  stateDir: string,
  record: { port: number; fingerprint: string; pid: number },
): Promise<UiServerRecord> {
  const payload: UiServerRecord = {
    schema_version: UI_SERVER_RECORD_SCHEMA_VERSION,
    port: record.port,
    url: uiUrl(record.port),
    project_fingerprint: record.fingerprint,
    pid: record.pid,
    updated_at: (ports.now?.() ?? new Date()).toISOString(),
  };
  await ports.fs.makeDirectory(stateDir);
  await ports.fs.writeTextFileAtomic(uiServerRecordFile(stateDir), toPrettyJson(payload));
  return payload;
}

/**
 * Kandidatas ir tai, ar juo galima UŽIMTI portą.
 *
 * Skirtumas svarbus persistuotam įrašui, kurio portas iškrito iš diapazono (paprastai — likutis po
 * kadaise galiojusio override'o). Jei tokiame porte gyvas MŪSŲ serveris, teisinga jį pripažinti ir
 * antro nekelti. Bet naujai prisirišti prie tokio porto negalima — todėl toks kandidatas gali duoti
 * tik `already-running`, niekada `available`.
 */
type UiPortCandidate = { port: number; source: UiPortSource; bindable: boolean };

export type ResolveUiPortInput = {
  ports: UiPortPorts;
  projectRoot: string;
  /** vq runtime šaknis (`<root>/vq`). */
  runtimeRoot: string;
  /** Bendras kandidatų skenavimo terminas milisekundėmis. */
  scanBudgetMs?: number;
};

const DEFAULT_SCAN_BUDGET_MS = 15_000;

/**
 * Galutinis porto sprendimas.
 *
 * Override'o šaka SĄMONINGAI nesirenka kito kandidato: aiškiai nurodytas portas yra visas
 * nurodymas — jei jame sėdi svetimas procesas, teisingas atsakymas yra tai pasakyti operatoriui, o
 * ne tyliai atidaryti UI kitur, nei jis liepė.
 *
 * Be override'o pirmas tikrinamas PERSISTUOTAS portas, tik paskui išvestieji. Taip projektas, kuris
 * kadaise dėl konflikto nusileido į kitą portą, jį ir išlaiko, užuot kas kartą migravęs pirmyn atgal.
 */
export async function resolveUiPort(input: ResolveUiPortInput): Promise<UiPortResolution> {
  const ports = input.ports;
  const platform = ports.platform ?? process.platform;
  const stateDir = path.join(input.runtimeRoot, "state");
  const fingerprint = projectFingerprint(input.projectRoot, platform);

  let override: Awaited<ReturnType<typeof readUiPortOverride>>;
  try {
    override = await readUiPortOverride(ports, input.runtimeRoot);
  } catch (error) {
    if (error instanceof InvalidUiPortError) return { status: "failed", reason: error.message };
    throw error;
  }

  if (override) {
    const probed = await ports.probe(override.port);
    if (probed.state === "free") {
      return { status: "available", port: override.port, url: uiUrl(override.port), source: override.source, fingerprint };
    }
    if (probed.fingerprint === fingerprint) {
      return {
        status: "already-running",
        port: override.port,
        url: uiUrl(override.port),
        source: override.source,
        fingerprint,
      };
    }
    return {
      status: "failed",
      reason: `${UI_PORT_ENV}=${override.port} (${override.source}) is taken by another process; free it or point the override elsewhere`,
    };
  }

  // Persistuotas įrašas priimamas TIK kai jis liudija apie ŠĮ projektą. Nukopijuota ar paveldėta
  // būsena (pvz. projekto klonas su visu `vq/state`) kitaip atiduotų mums svetimą portą — būtent dėl
  // to portas ir fingerprint'as įraše laikomi kartu.
  const persisted = await readUiServerRecord(ports, stateDir);
  const persistedPort = persisted?.project_fingerprint === fingerprint ? persisted.port : undefined;
  const candidates: UiPortCandidate[] = [
    ...(persistedPort === undefined
      ? []
      : [{ port: persistedPort, source: "state" as const, bindable: isBindableUiPort(persistedPort) }]),
    ...uiPortCandidates(input.projectRoot, platform)
      .filter((port) => port !== persistedPort)
      .map((port) => ({ port, source: "derived" as const, bindable: true })),
  ];

  const scanBudgetMs = input.scanBudgetMs ?? DEFAULT_SCAN_BUDGET_MS;
  const startedAt = Date.now();
  let checked = 0;

  for (const candidate of candidates) {
    // `>=`, o ne `>`: biudžetas yra riba, ne minimumas. Bent vienas kandidatas visada zonduojamas,
    // kad nulinis biudžetas nereikštų „nieko net nebandyk".
    if (checked > 0 && Date.now() - startedAt >= scanBudgetMs) {
      return {
        status: "failed",
        reason:
          `UI port scan gave up after ${checked} candidate(s) in ${scanBudgetMs} ms; ` +
          `set ${UI_PORT_ENV} to choose one explicitly`,
      };
    }
    checked += 1;

    const probed = await ports.probe(candidate.port);
    if (probed.state === "free") {
      if (!candidate.bindable) continue;
      return { status: "available", port: candidate.port, url: uiUrl(candidate.port), source: candidate.source, fingerprint };
    }
    if (probed.fingerprint === fingerprint) {
      return {
        status: "already-running",
        port: candidate.port,
        url: uiUrl(candidate.port),
        source: candidate.source,
        fingerprint,
      };
    }
  }

  return {
    status: "failed",
    reason: `no free UI port in ${UI_PORT_RANGE_START}-${UI_PORT_RANGE_END}; set ${UI_PORT_ENV} to choose one explicitly`,
  };
}
