// Sesijos rašymo evidencijos tiekėjai (etalonai: AG_loop core/schema session-file-events
// blokas + reliability-analytics session skaitymai). ReliabilityPorts kontrakto pusė:
// sessionWrites (ledger'is) ir sessionFileKinds (write-time įvykių žurnalas).
//
// Žodynas nuo VQ-502 (5/6-c) gyvena `application/learning/session-file-events`: gamintojas
// (interfaces/hooks) infrastructure importuoti NEGALI, tad bendra forma privalo būti ten, kur
// ją mato ir gamintojas, ir vartotojas. Čia lieka keliai, skaitymas ir re-eksportas — esamiems
// skaitytojams importo kelias nesikeičia.

import path from "node:path";
import {
  parseSessionFileEvent,
  resolveSessionFileKinds,
} from "../../application/learning/session-file-events.js";
import { parseJsonlObjects } from "../../application/learning/usage-view.js";
import type { SessionFileKind } from "../../application/learning/reliability-report.js";
import { parseJsonStringArray } from "../../shared/json.js";
import { nodeFsAdapter } from "../fs/node-fs-adapter.js";

export {
  SESSION_FILE_EVENT_KINDS,
  parseSessionFileEvent,
  resolveSessionFileKinds,
  sessionFileEventKindSchema,
  sessionFileEventSchema,
  type SessionFileEvent,
  type SessionFileEventKind,
} from "../../application/learning/session-file-events.js";

export function sessionWritesPath(runtimeRoot: string): string {
  return path.join(runtimeRoot, "state", "session-writes.json");
}

export function sessionFileEventsPath(runtimeRoot: string): string {
  return path.join(runtimeRoot, "state", "session-file-events.jsonl");
}

/** ReliabilityPorts.sessionWrites tiekėjas: trūkstamas/sugadintas ledger'is — tuščias sąrašas. */
export async function readSessionWrites(runtimeRoot: string): Promise<string[]> {
  return parseJsonStringArray(await nodeFsAdapter.readTextFileIfExists(sessionWritesPath(runtimeRoot)));
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
