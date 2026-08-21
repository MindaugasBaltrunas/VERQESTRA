// `smoke` CLI adapteris (etalonas: interfaces/cli/smoke/index.ts): diegimo sveikatos patikra
// prieš paleidžiant kilpą — ar yra reikiamos komandos, konfigai, taisyklių failai, bucket'ai,
// git repo ir galiojantis stable-ref. Nieko netaiso ir nieko nerašo, išskyrus ensureDirs.
//
// Ataskaita baigiama mašinai skirta žyme AG_SMOKE_OK / AG_SMOKE_FAILED — tai kontraktas su
// skriptais, todėl žymos tekstas laikomas 1:1 su etalonu, nors produktas pervadintas.
//
// VERQESTRA keliai: konfigai ir būsena — vq/ (etalone AG/), task bucket'ai lieka AG/tasks,
// `.claude/**` ir CLAUDE.md — projekto šaknyje.
//
// SĄMONINGAS NUKRYPIMAS nuo etalono: praleista besąlyginė eilutė
// „OK   TypeScript hook commands configured". Etalone ji spausdinama visada, nieko
// nepatikrinusi — smoke patikroje tai žalias atsakymas be įrodymo. Exit kontraktas
// (0/1 ir AG_SMOKE_* žymė) nesikeičia, tad VQ-50A parity fixture'ai lieka galioti.

import path from "node:path";
import { consoleCliIo, type CliIo } from "../registry.js";

export type SmokePorts = {
  ensureDirs(): Promise<void>;
  /** Ar vykdomasis failas randamas PATH'e. */
  commandExists(command: string): Promise<boolean>;
  exists(absolutePath: string): Promise<boolean>;
  readTextFileIfExists(absolutePath: string): Promise<string | undefined>;
  countMarkdownFiles(absoluteDir: string): Promise<number>;
  isGitRepository(projectRoot: string): Promise<boolean>;
  gitCommitExists(ref: string, projectRoot: string): Promise<boolean>;
};

export type SmokeCommandDeps = {
  ports: SmokePorts;
  projectRoot: string;
  /** vq runtime šaknis (`<root>/vq`). */
  runtimeRoot?: string;
  /** Absoliutus šio diegimo CLI įėjimas (`dist/cli.js`) — jo buvimas irgi tikrinamas. */
  cliEntry: string;
  io?: CliIo;
};

const REQUIRED_COMMANDS = ["claude", "git"] as const;

export async function smokeCommand(deps: SmokeCommandDeps): Promise<number> {
  const io = deps.io ?? consoleCliIo;
  const root = path.resolve(deps.projectRoot);
  const runtimeRoot = deps.runtimeRoot ?? path.join(root, "vq");
  const agRoot = path.join(root, "AG");

  await deps.ports.ensureDirs();
  let failed = false;

  const requiredFiles = [
    path.join(runtimeRoot, "config", "commands.env"),
    path.join(runtimeRoot, "config", "models.env"),
    deps.cliEntry,
    path.join(root, "CLAUDE.md"),
    path.join(root, ".claude", "settings.json"),
    path.join(root, ".claude", "rules", "agents.md"),
    path.join(root, ".claude", "rules", "workflow.md"),
    path.join(root, ".claude", "rules", "constraints.md"),
  ];
  const requiredDirs = [
    path.join(agRoot, "tasks", "queue"),
    path.join(agRoot, "tasks", "active"),
    path.join(agRoot, "tasks", "done"),
    path.join(agRoot, "tasks", "human-review"),
    path.join(runtimeRoot, "supervisor"),
    path.join(runtimeRoot, "logs"),
    path.join(runtimeRoot, "state"),
    path.join(root, ".claude", "agents"),
  ];

  for (const command of REQUIRED_COMMANDS) {
    const ok = await deps.ports.commandExists(command);
    io.out(`${ok ? "OK  " : "FAIL"} command: ${command}`);
    failed ||= !ok;
  }

  for (const file of requiredFiles) {
    const ok = await deps.ports.exists(file);
    io.out(`${ok ? "OK  " : "FAIL"} file: ${path.relative(root, file)}`);
    failed ||= !ok;
  }

  for (const dir of requiredDirs) {
    const ok = await deps.ports.exists(dir);
    io.out(`${ok ? "OK  " : "FAIL"} dir: ${path.relative(root, dir)}`);
    failed ||= !ok;
  }

  // Netuščias `active` nėra klaida: kilpa gali būti tiesiog nutraukta viduryje task'o.
  const activeCount = await deps.ports.countMarkdownFiles(path.join(agRoot, "tasks", "active"));
  io.out(
    activeCount === 0
      ? "OK   active task directory is empty"
      : `WARN active task directory contains ${activeCount} task file(s)`,
  );

  if (await deps.ports.isGitRepository(root)) {
    io.out("OK   git repository");
  } else {
    io.out("FAIL git repository: run from the product repository root");
    failed = true;
  }

  const settings = await deps.ports.readTextFileIfExists(path.join(root, ".claude", "settings.json"));
  if (isParsableJson(settings)) {
    io.out("OK   .claude/settings.json syntax");
  } else {
    io.out("FAIL .claude/settings.json syntax");
    failed = true;
  }

  failed = (await reportStableRef(deps, io, runtimeRoot, root)) || failed;

  io.out(failed ? "AG_SMOKE_FAILED" : "AG_SMOKE_OK");
  return failed ? 1 : 0;
}

function isParsableJson(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  try {
    JSON.parse(raw);
    return true;
  } catch {
    return false;
  }
}

/** `true` — patikra nepavyko. Trūkstamas stable-ref yra WARN, o negaliojantis — FAIL. */
async function reportStableRef(
  deps: SmokeCommandDeps,
  io: CliIo,
  runtimeRoot: string,
  root: string,
): Promise<boolean> {
  const raw = await deps.ports.readTextFileIfExists(path.join(runtimeRoot, "state", "stable-ref"));
  const ref = (raw ?? "").trim();
  if (ref === "") {
    io.out("WARN stable-ref missing");
    return false;
  }
  if (await deps.ports.gitCommitExists(ref, root)) {
    io.out("OK   stable-ref");
    return false;
  }
  io.out("FAIL stable-ref is not a valid commit");
  return true;
}
