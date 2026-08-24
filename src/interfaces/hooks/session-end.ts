// `SessionEnd` hook'as (etalonas: AG_loop hooks/session-end.ts + lifecycle.ts).
//
// Skaičiuojama iš sesijos apimties NUOTRAUKOS, kuri pergyvena Stop hook'o `changes.log`
// valymą po kiekvieno commit'o — kitaip commit'inusi sesija struktūriškai VISADA raportuotų
// 0 pakeistų failų.

import {
  SESSION_HOOK_OK_EXIT_CODE,
  type SessionHookContext,
  type SessionHookDeps,
  isDispatchedClaudeSession,
  sessionHookContext,
  userClaudePidFile,
} from "./session-hook-context.js";
import { releaseLoopRuntimeRecord } from "./loop-runtime-store.js";
import { sessionChangedFiles } from "./session-changes.js";

/**
 * Pašalina ŠIOS sesijos runtime įrašą jai baigiantis.
 *
 * Trinama tik tada, kai įraše užfiksuotas PID sutampa su mūsiškiu: failas dalijamasis
 * (lygiagreti interaktyvi ir dispatch'inta sesija rašo į jį last-writer principu), tad svetimo
 * įrašo trynimas paslėptų dar gyvą sesiją.
 *
 * Gyvumo čia netikriname — tikrinama tik TAPATYBĖ. Sesijos procesas šiuo metu kaip tik miršta,
 * tad gyvumo atsakymas būtų lenktynių rezultatas, o ne faktas.
 */
export async function releaseUserClaudeRuntime(context: SessionHookContext): Promise<boolean> {
  const ports = context.deps.ports;
  // Dispatch'inta sesija indikatoriaus neregistruoja, tad ir valyti jai nėra ko — simetriškas
  // vartų taikymas apsaugo interaktyvios sesijos įrašą nuo svetimo SessionEnd.
  if (isDispatchedClaudeSession(ports)) return false;

  const pid = ports.parentPid();
  try {
    return await releaseLoopRuntimeRecord(
      { fs: ports.fs, processIsAlive: (pid) => ports.processIsAlive(pid), now: () => context.now() },
      userClaudePidFile(context.runtimeRoot),
      pid,
    );
  } catch (error) {
    // Best-effort: sesijos pabaiga negali lūžti dėl nepavykusio valymo — pasenusį įrašą vis
    // tiek išgelbsti gyvumo patikra (miręs PID → „sustojęs").
    await context.log(`user-claude runtime valymas nepavyko: ${String(error)}`);
    return false;
  }
}

export async function hookSessionEnd(deps: SessionHookDeps): Promise<number> {
  const context = sessionHookContext(deps);
  const ports = deps.ports;

  const modifiedCount = (
    await sessionChangedFiles(
      { fs: ports.fs, collectChangedFiles: (projectRoot) => ports.collectChangedFiles(projectRoot) },
      context.root,
      context.runtimeRoot,
    )
  ).length;

  const stamp = context.now().toISOString();
  await ports.fs.appendTextFile(
    context.logPath("history.log"),
    `[${stamp}] SESSION_END — pakeista failų: ${modifiedCount}\n`,
  );
  await context.log("session-end");
  await releaseUserClaudeRuntime(context);

  const code = await ports.runSessionSummary(context.root).catch(() => 1);
  if (code !== 0) {
    await context.log("session-summary nepavyko");
  }
  return SESSION_HOOK_OK_EXIT_CODE;
}

// `sessionOwnerPid` ištrintas 2026-08-24: apvalkalas, kurio doc'as tvirtino „diagnostikai ir
// testams", nors nė vienas testas jo nekvietė — doc'as buvo vienintelis jo pateisinimas.
// Tikroji taisyklė yra `domain/scheduling/loop-runtime#resolveSessionOwnerPid`, ji padengta
// testais ir tiesiogiai kviečiama `session-start`; čia dubliuotas tik iškvietimas.
