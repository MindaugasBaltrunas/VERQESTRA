// Package/lockfile guard'o GRYNAS sprendimas (etalonas: AG_loop hooks/package-guard.ts
// sprendimo pusė). Etalone skenas, IO ir verdiktas gyvena viename kūne; čia verdiktas
// atskirtas, kad jį būtų galima pin'inti be failų sistemos ir be git.
//
// Kertinė sąvoka — ŠIOS SESIJOS pakeitimas. Toje pačioje darbo kopijoje gali dirbti kelios
// sesijos, tad reason/approval reikalaujama TIK tada, kai package.json pakeitė ši sesija
// (įrodymas — session-writes ledger'is). Svetimas pakeitimas Stop hook'o neblokuoja: kitaip
// viena sesija galėtų amžinai laikyti kitą įkaitu.

import type { ChangedFile } from "../git/changes.js";
import type { PackageManagerName } from "./file-classification.js";
import { isForeignLockfilePath, isLockfilePath, isPackageJsonPath } from "./file-classification.js";

/** Priežasties/patvirtinimo žymos commit žinutėje. Ilgio ribos SKIRIASI ir tai sąmoninga. */
const PACKAGE_REASON_PATTERN = /^Package reason:\s*.{12,}/im;
const LARGE_DEPENDENCY_APPROVAL_PATTERN = /^Large dependency approved:\s*.{12,}/im;

/**
 * Priklausomybės, kurių įtraukimas mažai funkcijai yra brangus sprendimas (build laikas,
 * saugumo paviršius, bundle dydis). Sąrašas sąmoningai siauras: jame tik tai, kas beveik
 * visada verta atskiro žmogaus sprendimo.
 */
const LARGE_DEPENDENCY_PATTERN =
  /^\+\s*"(puppeteer|playwright|@playwright\/test|cypress|electron|next|aws-sdk|@aws-sdk\/client-s3|firebase|supabase|mongoose|prisma|@prisma\/client|three|chart\.js|recharts)"\s*:/;

export type PackageGuardEvidence = {
  /** Ar target apskritai Node projektas — kitaip lockfile taisyklės beprasmės (task 886). */
  isNodeTarget: boolean;
  targetManager?: PackageManagerName | undefined;
  changed: readonly ChangedFile[];
  /** Šios sesijos rašymų ledger'is (normalizuoti repo-santykiniai keliai). */
  sessionWrites: readonly string[];
  /** Diske realiai gulintys svetimo valdiklio lockfile'ai (adapteris patikrino). */
  foreignLockfilesOnDisk: readonly string[];
  commitMessage: string;
  /** `git diff` eilutės šakniniam ir workspace `package.json` failams; tuščia, kai ne git repo. */
  packageDiffLines: readonly string[];
};

export type GuardBlock = { reason: string; stderr: string };

export type PackageGuardVerdict = {
  /** Guard'o žurnalo eilutės (rašomos ir blokuojant, ir praleidžiant). */
  lines: string[];
  /** Ne blokuojančios pastabos į `hooks.log`. */
  notes: string[];
  block?: GuardBlock;
};

function normalizeLedgerPath(file: string): string {
  return file.replace(/\\/g, "/").replace(/^\.?\//, "");
}

export function evaluatePackageGuard(evidence: PackageGuardEvidence): PackageGuardVerdict {
  const lines: string[] = [];
  const notes: string[] = [];
  const sessionWrites = new Set(evidence.sessionWrites.map(normalizeLedgerPath));
  const writtenBySession = (file: string): boolean => sessionWrites.has(normalizeLedgerPath(file));

  lines.push(
    evidence.isNodeTarget
      ? `package-guard: target package manager = ${evidence.targetManager ?? "nenustatytas (nėra įrodymų)"}`
      : "package-guard: ne-Node projektas — lockfile taisyklės praleistos (no-op)",
  );

  let packageChanged = false;
  let packageChangedBySession = false;
  let lockChanged = false;
  let lockChangedBySession = false;
  let foreignLockChanged = false;
  let hasNewPackageJson = false;

  for (const { status, file } of evidence.changed) {
    if (!file) continue;

    if (status.trim() === "??") {
      // Naujas untracked package.json = naujas workspace paketas, kuris PATEISINA lockfile pokytį.
      if (isPackageJsonPath(file)) hasNewPackageJson = true;
      continue;
    }

    // Tuščias status = įrašas iš changes.log, bet failas šiuo metu sutampa su HEAD (revertintas
    // arba jau commit'intas). Tokiam priežastis NEreikalaujama — reason vartai kabinasi tik ant
    // realaus pending git pakeitimo; be šito revertintas package.json klaidingai blokuodavo Stop.
    const pendingInGit = status.trim() !== "";

    if (isPackageJsonPath(file)) {
      packageChanged = true;
      if (pendingInGit && writtenBySession(file)) packageChangedBySession = true;
      lines.push(
        `package.json changed: ${file}${
          pendingInGit
            ? writtenBySession(file)
              ? ""
              : " (ne šios sesijos)"
            : " (revertintas/commit'intas — be pending diff)"
        }`,
      );
    }

    if (isLockfilePath(file)) {
      lockChanged = true;
      if (pendingInGit && writtenBySession(file)) lockChangedBySession = true;
      lines.push(
        `lockfile changed: ${file}${pendingInGit ? (writtenBySession(file) ? "" : " (ne šios sesijos)") : " (be pending diff)"}`,
      );
    }

    // Svetimo lockfile'o TRYNIMAS yra teisingas veiksmas (jo šalinimas iš workspace) — nežymima.
    if (evidence.isNodeTarget && isForeignLockfilePath(file, evidence.targetManager) && status.trim() !== "D") {
      foreignLockChanged = true;
      lines.push(`foreign lockfile changed: ${file}`);
    }
  }

  // Lockfile pokytis dėl naujo workspace package.json yra teisėtas.
  if (lockChanged && !packageChanged && hasNewPackageJson) {
    lockChangedBySession = false;
  }

  for (const lockfile of evidence.foreignLockfilesOnDisk) {
    foreignLockChanged = true;
    lines.push(`foreign lockfile exists: ${lockfile}`);
  }

  if (foreignLockChanged) {
    return {
      lines,
      notes,
      block: {
        reason: "PACKAGE GUARD BLOKUOTAS — aptiktas svetimas lockfile",
        stderr: `Package guard: ${evidence.targetManager ?? "nenustatytas"} projekte negalima turėti kito package manager'io lockfile.`,
      },
    };
  }

  if (lockChangedBySession && !packageChanged) {
    return {
      lines,
      notes,
      block: {
        reason: "PACKAGE GUARD BLOKUOTAS — lockfile keistas be package.json",
        stderr: "Package guard: lockfile gali keistis tik kartu su package.json.",
      },
    };
  }

  if (packageChangedBySession && !PACKAGE_REASON_PATTERN.test(evidence.commitMessage)) {
    return {
      lines,
      notes,
      block: {
        reason: "PACKAGE GUARD BLOKUOTAS — trūksta Package reason",
        stderr: "Package guard: package.json pakeitimui reikia aiškios priežasties.",
      },
    };
  }

  if (packageChanged && !packageChangedBySession) {
    notes.push("Package guard: package.json pakeistas ne šios sesijos — reason netaikomas");
  }

  const largeDeps = evidence.packageDiffLines.filter((line) => LARGE_DEPENDENCY_PATTERN.test(line));
  if (largeDeps.length > 0 && packageChangedBySession && !LARGE_DEPENDENCY_APPROVAL_PATTERN.test(evidence.commitMessage)) {
    lines.push(...largeDeps);
    return {
      lines,
      notes,
      block: {
        reason: "PACKAGE GUARD BLOKUOTAS — didelė priklausomybė be patvirtinimo",
        stderr: "Package guard: aptikta didelė nauja priklausomybė mažai funkcijai.",
      },
    };
  }

  return { lines, notes };
}
