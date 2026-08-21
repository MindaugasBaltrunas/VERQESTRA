// Slaptukų skenerio hook'as (etalonas: AG_loop hooks/secret-scan.ts). Pattern'ai ir verdiktas
// gyvena domain/policies/secret-patterns; čia — failų rinkimas, gitignore filtras, žurnalai ir
// exit kontraktas.
//
// PC-SEC-01: `security-policy.json` vėliava `no_secrets_in_repo` valdo šį hook'ą, ir kryptis
// yra FAIL-CLOSED — nesamas, neperskaitomas ar nevalidus policy failas reiškia SKENUOTI.
// Praleidžiama TIK tada, kai politika aiškiai sako `no_secrets_in_repo=false`.
//
// Gitignored failai (pvz. `vq/config/local.env`) praleidžiami: jie negali būti commit'inti, o
// jų skenavimas duotų amžiną false positive ties sankcionuota kredencialų vieta.

import path from "node:path";
import { findSecretsInText, shouldSkipSecretScan } from "../../domain/policies/index.js";
import { consoleHookIo, type HookFsPort, type HookIo } from "./protocol.js";

export type SecretScanPorts = {
  fs: HookFsPort;
  /** Pakeisti failai (changes.log + git status, runtime keliai atfiltruoti). */
  collectChangedFiles(projectRoot: string): Promise<string[]>;
  /** Kurie iš paduotų kelių yra gitignored. */
  filterGitIgnored(files: readonly string[], projectRoot: string): Promise<Set<string>>;
  /** `no_secrets_in_repo` reikšmė; klaida politikos pusėje PRIVALO virsti `true`. */
  secretScanEnabled(projectRoot: string): Promise<boolean>;
  now?: () => Date;
};

export type SecretScanDeps = {
  ports: SecretScanPorts;
  projectRoot: string;
  /** vq runtime šaknis (`<root>/vq`). */
  runtimeRoot?: string;
  io?: HookIo;
};

export async function hookSecretScan(deps: SecretScanDeps): Promise<number> {
  const io = deps.io ?? consoleHookIo;
  const root = path.resolve(deps.projectRoot);
  const runtimeRoot = deps.runtimeRoot ?? path.join(root, "vq");
  const logDir = path.join(runtimeRoot, "logs");
  const hooksLog = path.join(logDir, "hooks.log");
  const findingsLog = path.join(logDir, "secret-scan.log");
  const stamp = (): string => (deps.ports.now?.() ?? new Date()).toISOString();

  await deps.ports.fs.makeDirectory(logDir);
  // Radinių žurnalas valomas PRIEŠ skenavimą: praeito bėgimo radiniai neturi atrodyti kaip
  // šio bėgimo rezultatas, jei šis nieko nerado.
  await deps.ports.fs.writeTextFile(findingsLog, "");

  if (!(await deps.ports.secretScanEnabled(root))) {
    await deps.ports.fs.appendTextFile(
      hooksLog,
      `[${stamp()}] Secret scan SKIP — security-policy.json no_secrets_in_repo=false\n`,
    );
    return 0;
  }

  const changedFiles = await deps.ports.collectChangedFiles(root);
  const gitIgnored = await deps.ports.filterGitIgnored(changedFiles, root);
  const findings: string[] = [];

  for (const file of changedFiles) {
    if (shouldSkipSecretScan(file) || gitIgnored.has(file)) continue;
    const content = await deps.ports.fs.readTextFileIfExists(path.join(root, file));
    if (content === undefined) continue;
    findings.push(...findSecretsInText(file, content));
  }

  if (findings.length > 0) {
    await deps.ports.fs.writeTextFile(findingsLog, `${findings.join("\n")}\n`);
    await deps.ports.fs.appendTextFile(hooksLog, `[${stamp()}] SECRET SCAN BLOKUOTAS — rasti galimi slaptukai\n`);
    io.error("Secret scan rado galimu tokenu, slaptazodziu ar raktu.");
    io.error("Detalės: vq/logs/secret-scan.log");
    return 1;
  }

  await deps.ports.fs.appendTextFile(hooksLog, `[${stamp()}] Secret scan ✅ — pakeistuose failuose slaptukų nerasta\n`);
  return 0;
}
