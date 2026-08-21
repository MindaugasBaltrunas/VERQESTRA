// Pre-commit Stop guard'ai (etalonas: AG_loop hooks/on-stop.ts guard blokas).
//
// Skirtumas nuo PostToolUse guard'ų yra kontraktas, ne stilius: PostToolUse guard'as NIEKADA
// neblokuoja (jo nesėkmė — žurnalo eilutė), o Stop guard'as blokuoja — čia paskutinis momentas,
// kai failas jau privalo būti sveikas.
//
// Guard'ai paleidžiami LYGIAGREČIAI (nepriklausomos read-only patikros, kiekviena savo
// subprocese), bet pirmoji nesėkmė pranešama FIKSUOTA registro tvarka: blokavimo priežastis
// turi sutapti su deklaruotu prioritetu, nepriklausomai nuo užbaigimo eilės.

import type { GuardRootKey } from "../../domain/project/index.js";
import { applicableGuards, detectGuardRoots, type PostWriteGuardPorts } from "./post-write-guards.js";

export type StopGuard = {
  command: string;
  blockReason: string;
  logMessage: string;
  /** Guard'as paleidžiamas TIK kai atitinkama produkto šaknis realiai egzistuoja. */
  requiresRoot?: GuardRootKey;
};

export const PRE_COMMIT_STOP_GUARDS: readonly StopGuard[] = [
  {
    command: "hook-secret-scan",
    blockReason: "secret scan blocked stop",
    logMessage: "STOP BLOKUOTAS — secret scan rado galimų slaptukų",
  },
  {
    command: "hook-package-guard",
    blockReason: "package guard blocked stop",
    logMessage: "STOP BLOKUOTAS — package guard rado rizikingą dependency pakeitimą",
  },
  {
    command: "hook-migration-guard",
    blockReason: "migration guard blocked stop",
    logMessage: "STOP BLOKUOTAS — migration guard rado DB migracijos riziką",
  },
  {
    command: "hook-frontend-guard",
    blockReason: "frontend guard blocked stop",
    logMessage: "STOP BLOKUOTAS — frontend guard rado React problemų",
    requiresRoot: "frontend",
  },
  {
    command: "hook-backend-guard",
    blockReason: "backend guard blocked stop",
    logMessage: "STOP BLOKUOTAS — backend guard rado Express problemų",
    requiresRoot: "backend",
  },
  {
    command: "hook-mobile-guard",
    blockReason: "mobile guard blocked stop",
    logMessage: "STOP BLOKUOTAS — mobile guard rado React Native problemų",
    requiresRoot: "mobile",
  },
  {
    command: "quality-gates",
    blockReason: "quality gates blocked stop",
    logMessage: "STOP BLOKUOTAS — quality-gates nepraėjo prieš commit/push",
  },
];

/** Visas deklaruotas guard'ų sąrašas prioriteto tvarka — nepriklausomai nuo projekto formos. */
export function preCommitStopGuardCommands(): string[] {
  return PRE_COMMIT_STOP_GUARDS.map((guard) => guard.command);
}

export type StopGuardPorts = PostWriteGuardPorts & {
  /** Guard komandos paleidimas atskirame procese; grąžina exit kodą. */
  runStopGuard(command: string, projectRoot: string): Promise<number>;
};

export type StopGuardFailure = {
  guard: StopGuard;
};

/**
 * Paleidžia visus taikomus guard'us ir grąžina PIRMĄ nesėkmę registro tvarka arba `undefined`,
 * kai visi praėjo. Sprendimą, ką su nesėkme daryti (žurnalas, stop-bridge, exit 2), priima
 * kvietėjas — čia lieka tik vykdymas ir prioritetas.
 */
export async function runStopGuards(
  ports: StopGuardPorts,
  projectRoot: string,
  guards: readonly StopGuard[] = PRE_COMMIT_STOP_GUARDS,
): Promise<StopGuardFailure | undefined> {
  const roots = await detectGuardRoots(ports, projectRoot);
  const applicable = applicableGuards(guards, roots);
  const codes = await Promise.all(
    applicable.map((guard) =>
      // Nepaleistas guard'as NIEKADA nėra „praėjo": procesų klaida (nėra CLI, EACCES) yra
      // blokuojanti, nes kitaip sugedusi aplinka tyliai atidarytų visus vartus.
      ports.runStopGuard(guard.command, projectRoot).catch(() => 1),
    ),
  );

  for (const [index, guard] of applicable.entries()) {
    if (codes[index] !== 0) return { guard };
  }
  return undefined;
}
