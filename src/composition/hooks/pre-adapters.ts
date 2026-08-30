// `PreToolUse` vartų portų surišimas (VQ-504: VQ-502 paliktas wiring'as).
//
// Šie vartai yra VIENINTELIS hook'as, galintis blokuoti įrankio kvietimą, tad adapteris turi
// vieną neperžengiamą taisyklę: joks portas negali virsti `undefined` numatytuoju. Etalone
// `??` numatytieji reiškė, kad pamiršęs portą kvietėjas tyliai gaudavo produkcinį IO; čia
// portai PRIVALOMI, o testai paduoda savo.
//
// Nuosavybės sluoksnis (lease + scope lock) surišamas su tais pačiais application store'ais,
// kuriuos naudoja loop'as. Tai sąmoninga: hook'as ir planuoklis privalo matyti TĄ PATĮ lease
// registrą, kitaip vartai leistų tai, ką planuoklis laiko svetima nuosavybe.

import path from "node:path";
import { authorizeScopedWrite } from "../../application/scheduling/scope-lock-store.js";
import { authorizeWorkerRuntimeMutation } from "../../application/scheduling/worker-lease-runtime.js";
import { listWorkerLeases } from "../../application/scheduling/worker-lease-store.js";
import { processIsAlive } from "../../application/scheduling/ports.js";
import { loadQualityPolicy } from "../../application/policy-governance/quality-policy.js";
import { isLeaseActive, isLeaseOwnerProcessDead } from "../../domain/scheduling/worker-lease-rules.js";
import { EMPTY_CHECK_COMMAND_CONTEXT, type CheckCommandContext } from "../../domain/policies/index.js";
import { resolveDeepestRealPath } from "../../infrastructure/fs/project-containment.js";
import { nodeFsAdapter } from "../../infrastructure/fs/node-fs-adapter.js";
import type { PreHookPorts, PreHookProfileView } from "../../interfaces/hooks/pre-hooks.js";
import { tryParseJson } from "../../shared/json.js";
import { readStdin } from "./adapters.js";
import { schedulingFs } from "../loop/adapters.js";
import { policyConfigFs } from "../runtime/node-adapters.js";
import { checkCommandContext } from "../quality/adapters.js";

/**
 * Ar vardas UŽIMTAS — `statPath` remiasi `lstat`, todėl nulūžęs symlink'as yra UŽIMTAS.
 *
 * Skirtumas nuo `exists` čia yra saugos sprendimas: `exists` nulūžusiam symlink'ui atsakytų
 * „nėra", kelias gautų „naujo eilės failo" carve-out'ą, o `open()` sukurtų failą ten, kur rodo
 * symlink'as — už queue ribų.
 */
async function pathIsTaken(absolutePath: string): Promise<boolean> {
  return (await nodeFsAdapter.statPath(absolutePath)).kind !== "absent";
}

/**
 * Gyvų lease'ų darbo kopijų keliai realpath forma — carve-out įvestis (0014).
 *
 * Gyvas = `held`, dar nepasibaigęs IR su gyvu savininko procesu. Miręs savininkas savo kopijos
 * nebegina: kitaip vienas nukritęs workeris paliktų carve-out'ą amžinai atidarytą.
 */
async function liveLeaseWorktreePaths(projectRoot: string): Promise<string[]> {
  const now = new Date();
  const paths: string[] = [];
  for (const lease of await listWorkerLeases(schedulingFs, projectRoot)) {
    const worktreePath = lease.worktree_path;
    if (!worktreePath) continue;
    if (!isLeaseActive(lease, now)) continue;
    if (isLeaseOwnerProcessDead(lease, processIsAlive)) continue;
    paths.push(await resolveDeepestRealPath(path.resolve(projectRoot, worktreePath)));
  }
  return paths;
}

/**
 * Projekto profilis README-guard reikalavimams.
 *
 * Runtime šaknis paduodama kompozicijos, o ne vedama iš porto `projectRoot` argumento:
 * operatorius gali paleisti hook'ą su nestandartine runtime šaknimi, ir profilio kelias privalo
 * sekti TĄ PAČIĄ šaknį kaip visa kita hook'o būsena. Trūkstamas ar sugadintas profilis duoda
 * `undefined` — guard'o reikalavimai tada krenta į saugius numatytuosius, ne į praleidimą.
 */
async function loadProjectProfile(runtimeRoot: string): Promise<PreHookProfileView | undefined> {
  const raw = await nodeFsAdapter.readTextFileIfExists(path.join(runtimeRoot, "project", "profile.json"));
  if (raw === undefined) return undefined;
  const parsed = tryParseJson<PreHookProfileView>(raw);
  return parsed.ok && parsed.value !== null && typeof parsed.value === "object" ? parsed.value : undefined;
}

/**
 * Komandų politikos kontekstas bash vartams.
 *
 * Neperskaitoma politika virsta TUŠČIU kontekstu, ne klaida — tuščias kontekstas gali tik
 * SUSIAURINTI leidžiamų komandų aibę (nežinomas stack'as neįgyja teisės ko nors paleisti), tad
 * fail-safe kryptis čia sutampa su fail-closed.
 */
async function preHookCheckCommandContext(runtimeRoot: string): Promise<CheckCommandContext> {
  try {
    const policy = await loadQualityPolicy(policyConfigFs, runtimeRoot).catch(() => undefined);
    return await checkCommandContext(runtimeRoot, policy);
  } catch {
    return EMPTY_CHECK_COMMAND_CONTEXT;
  }
}

/**
 * `PreToolUse` vartų portai: nuosavybė, fs, stdin, profilis ir komandų kontekstas.
 *
 * `runtimeRoot` yra PRIVALOMAS argumentas, o ne numatytasis iš `process.cwd()`: hook'ą paleidžia
 * Claude Code procesas, kurio darbinis katalogas nenuspėjamas, tad išvestas kelias rašytų
 * žurnalą ir skaitytų profilį atsitiktinėje vietoje.
 */
export function preHookPorts(runtimeRoot: string): PreHookPorts {
  return {
    resolveDeepestRealPath: (absolutePath) => resolveDeepestRealPath(absolutePath),
    pathIsTaken: (absolutePath) => pathIsTaken(absolutePath),
    liveLeaseWorktreePaths: (projectRoot) => liveLeaseWorktreePaths(projectRoot),
    authorizeWorkerRuntimeMutation: (input) =>
      authorizeWorkerRuntimeMutation({
        deps: { fs: schedulingFs },
        projectRoot: input.projectRoot,
        ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
        ...(input.guardedPath === undefined ? {} : { guardedPath: input.guardedPath }),
      }),
    authorizeScopedWrite: (input) =>
      authorizeScopedWrite({
        fs: schedulingFs,
        projectRoot: input.projectRoot,
        repoRelativePath: input.repoRelativePath,
        ...(input.leaseId === undefined ? {} : { leaseId: input.leaseId }),
      }),
    // Žurnalas nėra sprendimo dalis, tad jo klaida nurijama ČIA — kvietėjas verdikto dėl
    // nepavykusio rašymo keisti negali ir neturi.
    appendHookLog: async (line) => {
      await nodeFsAdapter.appendTextFile(path.join(runtimeRoot, "logs", "hooks.log"), `${line}\n`).catch(() => undefined);
    },
    fs: {
      exists: (absolutePath) => nodeFsAdapter.exists(absolutePath),
      readTextFileIfExists: (absolutePath) => nodeFsAdapter.readTextFileIfExists(absolutePath),
      writeTextFile: (absolutePath, text) => nodeFsAdapter.writeTextFile(absolutePath, text),
      appendTextFile: (absolutePath, text) => nodeFsAdapter.appendTextFile(absolutePath, text),
      makeDirectory: (absoluteDir) => nodeFsAdapter.makeDirectory(absoluteDir),
      listDirectoryIfExists: (absoluteDir) => nodeFsAdapter.listDirectoryIfExists(absoluteDir),
    },
    stdin: { readStdin: () => readStdin() },
    loadProjectProfile: () => loadProjectProfile(runtimeRoot),
    checkCommandContext: () => preHookCheckCommandContext(runtimeRoot),
  };
}
