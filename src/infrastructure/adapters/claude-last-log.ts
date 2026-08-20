// Sesijos log'o dviejų kanalų rašytojas (etalonas: interfaces/cli/claude-dispatch/
// claude-last-log.ts 1:1; 2026-08-09 EBUSY incidentas). PIRMINIS — bandymo (attempt)
// kanalas su unikaliu keliu (jokios konkurencijos); globalus `vq/logs/claude-last.log`
// lieka VEIDRODIS skaitytojams už bandymo namespace'o ribų, jo gedimas nebefatalus.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export const CLAUDE_LOG_MIRROR_ATTEMPTS = 3;
/** Bazinis backoff'as tarp veidrodžio bandymų; realus laukimas — `bazė * bandymo numeris`. */
export const CLAUDE_LOG_MIRROR_BACKOFF_MS = 50;

export type ClaudeLastLogChannels = {
  /** Bandymo kanalas — pirminis. `undefined`, kai runtime namespace'o nėra. */
  attemptPath?: string;
  /** Globalus `vq/logs/claude-last.log` — best-effort veidrodis. */
  globalPath: string;
};

export type ClaudeLastLogWriteResult = {
  /** `absent` = bandymo namespace'o šiame paleidime nėra, ne klaida. */
  attempt: "written" | "failed" | "absent";
  global: "written" | "failed";
  errors: string[];
};

export type ClaudeLastLogWriteDeps = {
  write(target: string, text: string): Promise<void>;
  sleep(ms: number): Promise<void>;
  attempts: number;
  backoffMs: number;
};

async function writeLogFile(target: string, text: string): Promise<void> {
  // Bandymo kanalo `logs/` katalogo pirmasis rašytojas yra būtent šis — be mkdir jis
  // kristų ENOENT ir „gyvas" kanalas liktų negyvas.
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, text, "utf8");
}

/**
 * Įrašo sesijos log'ą į abu kanalus: bandymo kanalas — vieną kartą (kelias unikalus),
 * globalus veidrodis — su trumpu didėjančiu backoff'u (laikantis procesas paprastai
 * atsileidžia per dešimtis ms). Niekada nemeta — kvietėjas sprendžia pagal
 * {@link claudeLastLogWriteFatal}.
 */
export async function writeClaudeLastLog(
  channels: ClaudeLastLogChannels,
  text: string,
  deps: Partial<ClaudeLastLogWriteDeps> = {},
): Promise<ClaudeLastLogWriteResult> {
  const write = deps.write ?? writeLogFile;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const attempts = Math.max(1, deps.attempts ?? CLAUDE_LOG_MIRROR_ATTEMPTS);
  const backoffMs = deps.backoffMs ?? CLAUDE_LOG_MIRROR_BACKOFF_MS;
  const errors: string[] = [];

  let attemptState: ClaudeLastLogWriteResult["attempt"] = "absent";
  if (channels.attemptPath !== undefined) {
    try {
      await write(channels.attemptPath, text);
      attemptState = "written";
    } catch (error: unknown) {
      attemptState = "failed";
      errors.push(`${channels.attemptPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let globalState: ClaudeLastLogWriteResult["global"] = "failed";
  for (let round = 1; round <= attempts; round += 1) {
    try {
      await write(channels.globalPath, text);
      globalState = "written";
      break;
    } catch (error: unknown) {
      if (round === attempts) {
        errors.push(`${channels.globalPath}: ${error instanceof Error ? error.message : String(error)}`);
        break;
      }
      await sleep(backoffMs * round);
    }
  }

  return { attempt: attemptState, global: globalState, errors };
}

/**
 * Ar log rašymas paliko dispatch'ą AKLĄ — be nė vieno kanalo su sesijos srautu. Gyvas
 * bandymo kanalas daro globalaus failo gedimą nebereikšmingą (2026-08-09 EBUSY pataisa);
 * fatališka tik kai turinio neturi NĖ VIENAS kanalas.
 */
export function claudeLastLogWriteFatal(result: ClaudeLastLogWriteResult): boolean {
  return result.attempt !== "written" && result.global !== "written";
}
