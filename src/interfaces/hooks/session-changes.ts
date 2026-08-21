// Sesijos apimties pakeitimų momentinė nuotrauka (etalonas: AG_loop hooks/session-changes.ts).
//
// Kodėl ji apskritai reikalinga: `vq/logs/changes.log` yra sesijos apimties, bet lakus —
// SessionStart jį išvalo, o Stop hook'as išvalo po KIEKVIENO sėkmingo commit'o. SessionEnd ir
// session-summary bėga pačioje pabaigoje, kai commit'inusi sesija savo `changes.log` jau turi
// tuščią, tad metrika, skaitoma tiesiai iš jo, struktūriškai visada būtų 0 (task 891).
//
// Ši nuotrauka Stop hook'o valymą pergyvena: prieš valydamas `changes.log`, Stop hook'as čia
// įrašo failus, kuriuos ketina commit'inti, o SessionStart ją atstato, tad ji lieka vienos
// sesijos apimties. Laikoma po `vq/logs/`, tad pati niekada nesiskaito produkto pakeitimu.

import path from "node:path";
import type { HookFsPort } from "./protocol.js";

export type SessionChangesPorts = {
  fs: HookFsPort;
  /** Šiuo metu nešvarūs failai (changes.log + git status, runtime keliai atfiltruoti). */
  collectChangedFiles(projectRoot: string): Promise<string[]>;
};

export function sessionChangesPath(runtimeRoot: string): string {
  return path.join(runtimeRoot, "logs", "session-changes.log");
}

/** Grynas eilučių parsinimas: apkarpymas, tuščių išmetimas. */
export function parseSessionChangeLines(content: string | undefined): string[] {
  return (content ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Grynas sąjungos sudėjimas — dedublikuota ir surikiuota (testai jį pin'ina be FS). */
export function mergeSessionChanges(existing: readonly string[], incoming: readonly string[]): string[] {
  return [...new Set([...existing, ...incoming.map((file) => file.trim()).filter(Boolean)])].sort();
}

/** Iki šiol nuotraukoje užfiksuoti failai. */
export async function readRecordedSessionChanges(fs: HookFsPort, runtimeRoot: string): Promise<string[]> {
  return parseSessionChangeLines(await fs.readTextFileIfExists(sessionChangesPath(runtimeRoot)));
}

/** Nuotraukos atstatymas naujai sesijai (kviečia SessionStart). */
export async function resetSessionChanges(fs: HookFsPort, runtimeRoot: string): Promise<void> {
  await fs.writeTextFile(sessionChangesPath(runtimeRoot), "");
}

/**
 * Įlieja `files` į nuotrauką PRIEŠ išvalant `changes.log`. Idempotentiška: kviečiama kartą per
 * Stop įvykį, o sąjunga per sesijos commit'us auga monotoniškai.
 */
export async function recordSessionChanges(
  fs: HookFsPort,
  runtimeRoot: string,
  files: readonly string[],
): Promise<void> {
  const merged = mergeSessionChanges(await readRecordedSessionChanges(fs, runtimeRoot), files);
  await fs.writeTextFile(sessionChangesPath(runtimeRoot), merged.length > 0 ? `${merged.join("\n")}\n` : "");
}

/**
 * Pilnas „pakeista šioje sesijoje" rinkinys: užfiksuota nuotrauka (commit'inti failai, kurių
 * `changes.log` įrašai jau išvalyti) sąjungoje su tuo, kas nešvaru dabar. Taip ir SessionEnd
 * skaičius, ir session-summary sąrašas rodo tikrus skaičius, kiek bebūtų buvę commit'ų.
 */
export async function sessionChangedFiles(
  ports: SessionChangesPorts,
  projectRoot: string,
  runtimeRoot: string,
): Promise<string[]> {
  const [recorded, current] = await Promise.all([
    readRecordedSessionChanges(ports.fs, runtimeRoot),
    ports.collectChangedFiles(projectRoot),
  ]);
  return [...new Set([...recorded, ...current])].sort();
}
