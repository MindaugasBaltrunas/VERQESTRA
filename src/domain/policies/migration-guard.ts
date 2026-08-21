// DB migracijų guard'o GRYNAS sprendimas (etalonas: AG_loop hooks/migration-guard.ts).
// Etalone skenas ir verdiktas gyvena hook'o kūne; čia jie atskirti, kad SQL taisyklės būtų
// testuojamos be failų sistemos ir be git.
//
// Guard'o pozicija: destruktyvus migracijos pakeitimas NĖRA draudžiamas — jis reikalauja
// EKSPLICITINIO žmogaus patvirtinimo commit žinutėje. Todėl leistas destruktyvus pakeitimas
// vis tiek paliekamas atskirai pažymėtas žurnale: tai audito pėdsakas, kurio be patvirtinimo
// nebūtų kaip atsekti.

import type { ChangedFile } from "../git/changes.js";
import { isMigrationFile } from "./file-classification.js";
import type { GuardBlock } from "./package-guard.js";

/** Migracijos patvirtinimo žyma. Riba 15 simbolių — ilgesnė nei package-guard'o (12). */
const MIGRATION_APPROVED_PATTERN = /^Migration approved:\s*.{15,}/im;

const DESTRUCTIVE_SQL_PATTERN = /\bDROP\s+TABLE\b|\bTRUNCATE\b/i;
const DELETE_WITHOUT_WHERE = { delete: /DELETE\s+FROM/i, where: /WHERE/i };
const SCHEMA_CHANGING_SQL_PATTERN = /\bALTER\s+TABLE\b|\bCREATE\s+INDEX\b|\bADD\s+COLUMN\b|\bCREATE\s+TABLE\b/i;
/** Staged migracijos failo trynimas ar pervadinimas — istorijos praradimas. */
const STAGED_MIGRATION_RISK_PATTERN = /^[DR].*migrations\//;
const KNEX_ROLLBACK_PATTERN = /^[+-].*knex migrate rollback/;

export type MigrationGuardEvidence = {
  changed: readonly ChangedFile[];
  /** Migracijos failų turinys pagal kelią; adapteris įdeda tik realiai egzistuojančius. */
  contents: Readonly<Record<string, string>>;
  /** `git diff --cached --name-status` eilutės; tuščia, kai ne git repo. */
  stagedNameStatusLines: readonly string[];
  /** `git diff` eilutės šakniniam ir workspace `package.json` failams. */
  packageDiffLines: readonly string[];
  commitMessage: string;
};

export type MigrationGuardVerdict = {
  lines: string[];
  /** Ar apskritai buvo migracijų pakeitimų (kitaip guard'as praleidžiamas). */
  migrationChanged: boolean;
  /** Ar rasta destruktyvių signalų. */
  destructive: boolean;
  approved: boolean;
  block?: GuardBlock;
};

export function evaluateMigrationGuard(evidence: MigrationGuardEvidence): MigrationGuardVerdict {
  const lines: string[] = [];
  let migrationChanged = false;
  let destructive = false;

  for (const { status, file } of evidence.changed) {
    if (!file || !isMigrationFile(file)) continue;
    migrationChanged = true;
    lines.push(`scan: ${status} ${file}`);

    if (status.includes("D")) {
      lines.push(`BLOCK: migration/schema file deleted: ${file}`);
      destructive = true;
      continue;
    }

    const content = evidence.contents[file];
    if (content === undefined) continue;

    content.split(/\r?\n/).forEach((line, index) => {
      if (DESTRUCTIVE_SQL_PATTERN.test(line)) {
        lines.push(`${index + 1}:${line}`);
        lines.push(`BLOCK: ${file} contains destructive SQL requiring explicit migration approval`);
        destructive = true;
      }
      if (DELETE_WITHOUT_WHERE.delete.test(line) && !DELETE_WITHOUT_WHERE.where.test(line)) {
        lines.push(`${index + 1}:${line}`);
        lines.push(`BLOCK: ${file} contains DELETE FROM without WHERE requiring explicit migration approval`);
        destructive = true;
      }
      // SENSITIVE nėra blokas: schemos keitimas yra normalus darbas, bet jo rollback/duomenų
      // poveikį recenzentas turi pamatyti žurnale.
      if (SCHEMA_CHANGING_SQL_PATTERN.test(line)) {
        lines.push(`${index + 1}:${line}`);
        lines.push(`SENSITIVE: ${file} contains schema-changing SQL; review rollback/data impact carefully`);
      }
    });
  }

  const stagedRisk = evidence.stagedNameStatusLines.filter((line) => STAGED_MIGRATION_RISK_PATTERN.test(line));
  if (stagedRisk.length > 0) {
    migrationChanged = true;
    destructive = true;
    lines.push(...stagedRisk, "BLOCK: staged migration file deletion or rename detected");
  }

  const rollbackScripts = evidence.packageDiffLines.filter((line) => KNEX_ROLLBACK_PATTERN.test(line));
  if (rollbackScripts.length > 0) {
    migrationChanged = true;
    destructive = true;
    lines.push(...rollbackScripts, "BLOCK: knex migrate rollback detected in package scripts");
  }

  const approved = MIGRATION_APPROVED_PATTERN.test(evidence.commitMessage);
  const verdict: MigrationGuardVerdict = { lines, migrationChanged, destructive, approved };

  if (migrationChanged && destructive && !approved) {
    return {
      ...verdict,
      block: {
        reason: "MIGRATION GUARD BLOKUOTAS — destruktyvus migracijos pakeitimas be patvirtinimo",
        stderr: "Migration guard rado destruktyvu DB migracijos pakeitima.",
      },
    };
  }

  return verdict;
}
