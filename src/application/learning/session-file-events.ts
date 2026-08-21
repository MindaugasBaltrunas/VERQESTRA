// Write-time įvykių žodynas (etalonas: AG_loop core/schema session-file-events blokas).
//
// Kodėl APPLICATION, o ne infrastructure: gamintojas yra `interfaces/hooks` (PostToolUse
// rašymo hook'as), o vartotojas — `application/learning` analitika. Interfaces sluoksniui
// infrastructure importas UŽDRAUSTAS, tad bendra forma privalo gyventi ten, kur ją mato abu.
// IO pusė (keliai, skaitymas) lieka `infrastructure/state/session-activity`, kuri šiuos
// simbolius re-eksportuoja — esamiems skaitytojams niekas nesikeičia.
//
// `unknown` yra pilnavertė rūšis, ne spraga: neklasifikuotas rašymas skaičiuojasi kaip
// touched ir NIEKO daugiau. Spėti „modified" draudžiama — klaidingas skaičius blogesnis nei
// sąžiningas nulis.

import { z } from "zod";

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
