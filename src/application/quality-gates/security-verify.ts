// quality-gates use case (etalono application/quality-gates/security-verify.ts, WBR VQ-305):
// skenuoja eksplicitinius arba pakeistus failus prieš security politiką (blokuojami kelio
// šablonai + pavojingi kodo šablonai) ir persistuoja rezultatą
// (`vq/state/security-verify-result.json`) per portą. CLI rendinimas/exit — E5; failų
// skaitymas, changed-files surinkimas ir politikos load'as — per `SecurityVerifyPorts`.
// Vartoja milestone-check use case'as (release-readiness, VQ-305 3/3).
import path from "node:path";
import { isErrnoCode } from "../../shared/errors.js";
import { resolveProjectPath, toComparablePosixPath as normalizePath } from "../../shared/paths.js";
import type { SecurityPolicy } from "../policy-governance/security-spec-policies.js";

export type SecurityVerifyStatus = "ok" | "warning" | "blocked";

export type SecurityPathFinding = {
  file: string;
  pattern: string;
};

export type SecurityTextFinding = {
  file: string;
  line: number;
  pattern: string;
  text: string;
};

export type SecurityVerifyResult = {
  status: SecurityVerifyStatus;
  files: string[];
  blocked_paths: SecurityPathFinding[];
  text_findings: SecurityTextFinding[];
  warnings: string[];
  result_path: string;
};

export type SecurityVerifyPorts = {
  loadPolicy(): Promise<SecurityPolicy>;
  /** Pakeistų failų sąrašas (git status + changes.log sąjunga — E4 adapteris). */
  changedFiles(): Promise<string[]>;
  /**
   * Failo tekstas; meta klaidą, kai failo perskaityti negalima. Klaida turi NEŠTI `errno`
   * kodą (`ENOENT`, `EACCES`, …) — būtent iš jo `securityVerify` sprendžia, ar failo nebėra,
   * ar jis tebeegzistuoja ir liko nenuskenuotas (žr. `isProvablyAbsent`).
   */
  readTextFile(absolutePath: string): Promise<string>;
  /**
   * Kelio rūšis — ANTRAS parašas prie `readTextFile` errno kodo, ne pirmas sprendėjas:
   * `ENOENT` skaitymą patvirtina tik tada, kai kelio ir dabar nėra.
   *
   * Ta pati forma kaip `PreflightPorts.statPathKind`, `CodeIntelligenceFileSystemPort.statKind`
   * ir `nodeFsAdapter.statKind` — ketvirtos taisyklės tam pačiam klausimui neatsiranda.
   * Realizacija gali klaidas ryti į `"absent"` (taip daro `nodeFsAdapter.statKind`) arba mesti;
   * abi baigtys čia saugios, nes „nebėra" jau įrodyta skaitymo errno kodu.
   */
  statPathKind(absolutePath: string): Promise<"file" | "directory" | "absent">;
  writeResult(result: SecurityVerifyResult): Promise<void>;
};

/** `vq/state/security-verify-result.json` — rezultato failas (rašo adapteris). */
export function securityVerifyResultPath(runtimeRoot: string): string {
  return path.join(runtimeRoot, "state", "security-verify-result.json");
}

export async function securityVerify(
  ports: SecurityVerifyPorts,
  args: string[],
  projectRoot = process.cwd(),
): Promise<SecurityVerifyResult> {
  const root = path.resolve(projectRoot);
  const policy = await ports.loadPolicy();
  const explicitArgs = args.filter((arg) => !arg.startsWith("--"));
  const warnings: string[] = [];
  const blockedPaths: SecurityPathFinding[] = [];
  const textFindings: SecurityTextFinding[] = [];
  const explicitEntries = resolveSecurityFileEntries(root, explicitArgs, true, warnings, blockedPaths);
  const entries =
    explicitArgs.length > 0
      ? explicitEntries
      : resolveSecurityFileEntries(root, await ports.changedFiles(), false, warnings, blockedPaths);
  const files = entries.map((entry) => entry.file);

  if (explicitArgs.length === 0 && files.length === 0 && blockedPaths.length === 0) {
    warnings.push("no files provided and no changed files detected");
  }

  for (const file of files) {
    for (const pattern of policy.blocked_file_patterns) {
      if (matchesBlockedPathPattern(file, pattern)) {
        blockedPaths.push({ file, pattern });
      }
    }
  }

  for (const entry of entries.filter((candidate) => !blockedPaths.some((finding) => finding.file === candidate.file))) {
    const { file, resolved, explicit } = entry;
    let content: string;
    try {
      content = await ports.readTextFile(resolved);
    } catch (error: unknown) {
      warnings.push(`could not read ${file}: ${(error as Error).message}`);
      // 2026-08-24 auditas: „neperskaitėme" turi DVI skirtingas priežastis, ir jos negali gauti to
      // paties atsakymo. IŠTRINTAS pakeistas failas neperskaitomas natūraliai, ir blokuoti už tai
      // būtų neteisinga — jo turinio nebėra. Bet failas, kuris TEBEEGZISTUOJA (teisės, katalogas,
      // laikina FS klaida), lieka NENUSKENUOTAS dėl pavojingų šablonų, o `warning` grąžina exit 0
      // (`interfaces/cli/audit/security-verify`: `blocked ? 1 : 0`) — t. y. nežinia virsdavo
      // leidimu. Iki tol blokuota tik `explicit` atveju, nors rizika nuo to nepriklauso.
      if (explicit || !(await isProvablyAbsent(ports, resolved, error))) {
        blockedPaths.push({ file, pattern: "unreadable" });
      }
      continue;
    }

    if (isTestOrFixtureFile(file)) continue;

    const lines = content.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      for (const pattern of policy.dangerous_code_patterns) {
        if (matchesDangerousPattern(line, pattern)) {
          textFindings.push({ file, line: index + 1, pattern, text: line.trim() });
        }
      }
    }
  }

  const status: SecurityVerifyStatus =
    blockedPaths.length > 0 || textFindings.length > 0 || files.length === 0
      ? "blocked"
      : warnings.length > 0
        ? "warning"
        : "ok";
  const resultPath = securityVerifyResultPath(path.join(root, "vq"));
  const result: SecurityVerifyResult = {
    status,
    files,
    blocked_paths: blockedPaths,
    text_findings: textFindings,
    warnings,
    result_path: path.relative(root, resultPath).replace(/\\/g, "/"),
  };

  await ports.writeResult(result);
  return result;
}

/**
 * Ar neperskaityto failo TIKRAI nebėra — vienintelė priežastis jo neblokuoti.
 *
 * 2026-09-01 auditas (P2): sprendimą lėmė `ports.statPathKind(...).catch(() => "absent")`, o
 * `nodeFsAdapter.statKind` VISAS stat klaidas irgi ryja į `"absent"`. Taigi EPERM/EACCES ant
 * stat kelio virsdavo atsakymu „failo nėra" → tik warning → exit 0, nors failas tebeegzistavo:
 * apsauga, kurią aprašo komentaras aukščiau, buvo apeinama adapterio catch'u.
 *
 * Todėl sprendžia ne stat, o TO PATIES skaitymo `errno` kodas: tik `ENOENT`/`ENOTDIR` reiškia
 * „vardo nebėra". `EACCES`, `EPERM`, `EISDIR`, `EIO` ar klaida be kodo — failas gali egzistuoti,
 * jo turinys nepatikrintas, tad vartas blokuoja. Tai ir pigiau, ir teisingiau nei antras stat:
 * skaitymo klaida yra to paties syscall'o rezultatas, tad tarp jos ir sprendimo nėra TOCTOU lango
 * (ta pati pamoka, kaip `nodeFsAdapter.readTextFileIfExists` — vienas syscall'as lenktynių neturi).
 *
 * `statPathKind` lieka antru parašu tai vienintelei likusiai lenktynei: skaitymas gavo `ENOENT`,
 * bet kelias tuo tarpu vėl atsirado. Bet kokia kita jo baigtis — įskaitant metimą — grąžina
 * `false`, t. y. blokavimą; stat klaida daugiau niekada nėra leidimas.
 */
async function isProvablyAbsent(ports: SecurityVerifyPorts, resolved: string, readError: unknown): Promise<boolean> {
  if (!isErrnoCode(readError, "ENOENT") && !isErrnoCode(readError, "ENOTDIR")) return false;
  const kind = await ports.statPathKind(resolved).catch(() => "stat-failed" as const);
  return kind === "absent";
}

type SecurityFileEntry = {
  file: string;
  resolved: string;
  explicit: boolean;
};

function resolveSecurityFileEntries(
  root: string,
  files: string[],
  explicit: boolean,
  warnings: string[],
  blockedPaths: SecurityPathFinding[],
): SecurityFileEntry[] {
  const entries = new Map<string, SecurityFileEntry>();
  for (const candidate of files) {
    const normalizedCandidate = normalizePath(candidate);
    if (!normalizedCandidate) continue;
    try {
      const resolved = resolveProjectPath(root, candidate, { allowAbsoluteInsideRoot: true }, "security file");
      const file = normalizePath(path.relative(root, resolved));
      entries.set(file, { file, resolved, explicit });
    } catch (error) {
      warnings.push(`${normalizedCandidate}: ${error instanceof Error ? error.message : String(error)}`);
      if (explicit) {
        blockedPaths.push({ file: normalizedCandidate, pattern: "outside-project" });
      }
    }
  }
  return Array.from(entries.values()).sort((a, b) => a.file.localeCompare(b.file));
}

// Etalono PC-SEC-02: pattern'ai su didžiąja raide ("Function(") lyginami case-sensitive,
// kitaip paprastas "function(" būtų žymimas kaip pavojingas kodas. Grynai mažosiomis rašyti
// pattern'ai ("powershell -enc") lieka case-insensitive, kad gaudytų ir "PowerShell -Enc".
export function matchesDangerousPattern(line: string, pattern: string): boolean {
  if (pattern !== pattern.toLowerCase()) {
    return line.includes(pattern);
  }
  return line.toLowerCase().includes(pattern);
}

export function isTestOrFixtureFile(filePath: string): boolean {
  const file = normalizePath(filePath);
  return /(^|\/)(test|tests|fixtures|__fixtures__|__tests__)(\/|$)/.test(file) || /\.(test|spec)\.[cm]?[tj]sx?$/.test(file);
}

export function matchesBlockedPathPattern(filePath: string, pattern: string): boolean {
  const file = normalizePath(filePath);
  const normalized = normalizePath(pattern);
  if (normalized.endsWith("/**")) {
    const prefix = normalized.slice(0, -3);
    return file === prefix || file.startsWith(`${prefix}/`);
  }
  if (normalized.startsWith("*.")) {
    return file.endsWith(normalized.slice(1));
  }
  if (normalized.endsWith(".*")) {
    const prefix = normalized.slice(0, -2);
    return file === prefix || file.startsWith(`${prefix}.`) || file.endsWith(`/${prefix}`) || file.includes(`/${prefix}.`);
  }
  return file === normalized || file.endsWith(`/${normalized}`);
}
