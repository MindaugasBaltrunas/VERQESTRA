// Sesijos rašymo evidencijos tiekėjai (etalonai: AG_loop core/schema session-file-events
// blokas + reliability-analytics session skaitymai). ReliabilityPorts kontrakto pusė:
// sessionWrites (ledger'is) ir sessionFileKinds (write-time įvykių žurnalas). Žodynas
// gyvena čia, nes gamintojas (hooks, E5) ir vartotojas (learning analitika) negali
// importuoti vienas kito. `unknown` yra pilnavertė rūšis, ne spraga: neklasifikuotas
// rašymas skaičiuojasi kaip touched ir NIEKO daugiau.

import path from "node:path";
import { z } from "zod";
import { parseJsonlObjects } from "../../application/learning/usage-view.js";
import type { SessionFileKind } from "../../application/learning/reliability-report.js";
import { nodeFsAdapter } from "../fs/node-fs-adapter.js";

export function sessionWritesPath(runtimeRoot: string): string {
  return path.join(runtimeRoot, "state", "session-writes.json");
}

export function sessionFileEventsPath(runtimeRoot: string): string {
  return path.join(runtimeRoot, "state", "session-file-events.jsonl");
}

export const SESSION_FILE_EVENT_KINDS = ["created", "modified", "deleted", "unknown"] as const;
export const sessionFileEventKindSchema = z.enum(SESSION_FILE_EVENT_KINDS);
export type SessionFileEventKind = z.infer<typeof sessionFileEventKindSchema>;

export const sessionFileEventSchema = z.looseObject({
  /** Repo-relative, forward-slash kelias — baitas į baitą session-writes ledger įrašas. */
  path: z.string().min(1),
  kind: sessionFileEventKindSchema,
  /** ISO rašymo žyma — tvarkai ir skaitomumui ranka. */
  ts: z.string().min(1),
});
export type SessionFileEvent = z.infer<typeof sessionFileEventSchema>;

/**
 * Vienas dekoduotas įvykis arba `undefined`, kai įrašas netinkamas. Tolerancija yra visa
 * esmė: žurnalas maitina read-only dashboard'ą, tad nužudyto hook proceso nutrūkęs append
 * kainuoja tik savo eilutę.
 */
export function parseSessionFileEvent(value: unknown): SessionFileEvent | undefined {
  const parsed = sessionFileEventSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Kind'as, su kuriuo kelias baigia sesiją. PIRMAS įvykis laimi (jis arčiausiai jį
 * pagimdžiusio rašymo): sukurtas ir vėliau redaguotas failas sesijai yra `created`.
 * Vienintelė išimtis — `deleted`, kuris visada perrašo: nebeegzistuojantis kelias negali
 * būti raportuojamas kaip sukurtas ar modifikuotas.
 */
export function resolveSessionFileKinds(events: readonly SessionFileEvent[]): Map<string, SessionFileEventKind> {
  const kinds = new Map<string, SessionFileEventKind>();
  for (const event of events) {
    if (event.kind === "deleted" || !kinds.has(event.path)) {
      kinds.set(event.path, event.kind);
    }
  }
  return kinds;
}

/** ReliabilityPorts.sessionWrites tiekėjas: trūkstamas/sugadintas ledger'is — tuščias sąrašas. */
export async function readSessionWrites(runtimeRoot: string): Promise<string[]> {
  const raw = await nodeFsAdapter.readTextFileIfExists(sessionWritesPath(runtimeRoot));
  if (raw === undefined) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

/** ReliabilityPorts.sessionFileKinds tiekėjas: tuščias Map — žurnalo nėra (legacy kelias). */
export async function readSessionFileKinds(runtimeRoot: string): Promise<Map<string, SessionFileKind>> {
  const raw = await nodeFsAdapter.readTextFileIfExists(sessionFileEventsPath(runtimeRoot));
  const events = parseJsonlObjects(raw).flatMap((row) => {
    const event = parseSessionFileEvent(row);
    return event ? [event] : [];
  });
  return resolveSessionFileKinds(events);
}
