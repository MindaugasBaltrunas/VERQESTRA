// Bendras per-failą eilučių guard'ų skeletas (etalonas: AG_loop hooks/file-line-guard.ts):
// nuskenuoja pakeistus failus, pritaiko eilučių taisykles, įrašo guard'o žurnalą ir išsišakoja
// į skip / block / ok. Konkretaus guard'o specifika (klasifikatorius, taisyklės, papildomos
// patikros) ateina per `config`, tad orkestracija apibrėžta VIENĄ kartą, o ne dubliuojama
// frontend/backend/mobile guard'uose.
//
// „Nieko nerasta" NĖRA tuščias žurnalas: tokiu atveju rašoma `skipped: <priežastis>`, kad
// skaitytojas (ir sesijos santrauka) atskirtų „guard'as praleistas — nėra jo apimties failų"
// nuo „guard'as bėgo ir radinių nerado".

import path from "node:path";
import { scanLineRules, type LineRule } from "../../domain/policies/index.js";
import { consoleHookIo, type HookFsPort, type HookIo } from "./protocol.js";

export type FileLineGuardPorts = {
  fs: HookFsPort;
  collectChangedFiles(projectRoot: string): Promise<string[]>;
  now?: () => Date;
};

export type FileLineGuardFileContext = {
  file: string;
  content: string;
  lines: string[];
  push: (line: string) => void;
};

export type FileLineGuardConfig = {
  /** Žurnalo failo vardas po `vq/logs/`, pvz. "frontend-guard.log". */
  guardLog: string;
  /** `true`, kai pakeistas failas patenka į šio guard'o apimtį. */
  classify: (file: string) => boolean;
  rules: LineRule[];
  /** Papildomos per-failo patikros (pvz. 300 eilučių įspėjimas). */
  perFile?: (context: FileLineGuardFileContext) => void;
  /**
   * Pakeistas failas, kurio klasifikatorius NEATPAŽINO (pvz. mobile `app.json`).
   * `true` reiškia, kad failas vis tiek reikšmingas — guard'as skaitosi „kažkas pasikeitė".
   */
  extraFile?: (file: string, fullPath: string, push: (line: string) => void) => Promise<boolean>;
  /** Projekto lygio patikros po skeno, tik kai kažkas pasikeitė. */
  postScan?: (projectRoot: string, push: (line: string) => void) => Promise<void>;
  /**
   * Stop režimo tęsinys (lint/typecheck). Bėga TIK kai `mode === "stop"`, kažkas pasikeitė ir
   * niekas dar neblokuoja. `true` — jis pats blokavo ir pats susitvarkė su žurnalu.
   */
  stopStep?: (projectRoot: string, hooksLogPath: string) => Promise<boolean>;
  messages: {
    skip: string;
    blocked: string;
    blockedConsole: string[];
    ok: string;
  };
};

export type FileLineGuardDeps = {
  ports: FileLineGuardPorts;
  projectRoot: string;
  /** vq runtime šaknis (`<root>/vq`). */
  runtimeRoot?: string;
  io?: HookIo;
};

export async function runFileLineGuard(
  deps: FileLineGuardDeps,
  mode: string,
  config: FileLineGuardConfig,
): Promise<number> {
  const io = deps.io ?? consoleHookIo;
  const root = path.resolve(deps.projectRoot);
  const runtimeRoot = deps.runtimeRoot ?? path.join(root, "vq");
  const logDir = path.join(runtimeRoot, "logs");
  const hooksLog = path.join(logDir, "hooks.log");
  const guardLogPath = path.join(logDir, config.guardLog);
  const stamp = (): string => (deps.ports.now?.() ?? new Date()).toISOString();

  await deps.ports.fs.makeDirectory(logDir);

  const guardLines: string[] = [];
  const push = (line: string): void => void guardLines.push(line);
  let changed = false;
  let blocked = false;

  for (const file of await deps.ports.collectChangedFiles(root)) {
    if (!file) continue;
    const fullPath = path.join(root, file);

    if (config.classify(file)) {
      const content = await deps.ports.fs.readTextFileIfExists(fullPath);
      if (content === undefined) continue;
      changed = true;
      push(`scan: ${file}`);
      const scan = scanLineRules(file, content, config.rules);
      guardLines.push(...scan.findings);
      blocked ||= scan.blocked;
      config.perFile?.({ file, content, lines: content.split(/\r?\n/), push });
    } else if (config.extraFile && (await deps.ports.fs.exists(fullPath))) {
      if (await config.extraFile(file, fullPath, push)) changed = true;
    }
  }

  if (!changed) {
    await deps.ports.fs.writeTextFile(guardLogPath, `skipped: ${config.messages.skip}\n`);
    await deps.ports.fs.appendTextFile(hooksLog, `[${stamp()}] ${config.messages.skip}\n`);
    return 0;
  }

  await config.postScan?.(root, push);
  await deps.ports.fs.writeTextFile(guardLogPath, `${guardLines.join("\n")}${guardLines.length ? "\n" : ""}`);

  if (blocked) {
    await deps.ports.fs.appendTextFile(hooksLog, `[${stamp()}] ${config.messages.blocked}\n`);
    for (const line of config.messages.blockedConsole) io.error(line);
    return 1;
  }

  if (mode === "stop" && config.stopStep && (await config.stopStep(root, hooksLog))) return 1;

  await deps.ports.fs.appendTextFile(hooksLog, `[${stamp()}] ${config.messages.ok}\n`);
  return 0;
}
