// `verqestra` komandų registras (etalonas: AG_loop orchestrator/runtime/command-registry.ts).
//
// Registras yra VIENINTELIS komandų sąrašo šaltinis: iš jo statoma ir dispatch'o lentelė, ir
// `help` išvestis. Du sąrašai ilgainiui prasilenktų, ir `help` imtų meluoti apie tai, kas realiai
// veikia.
//
// Handler'iai čia surišami su portais (manual DI). Verslo logikos šiame faile nėra — kiekviena
// komanda tik gauna savo priklausomybes ir grąžina exit kodą.

import { hookPostBash, hookPostBashSync, hookPostRead } from "../interfaces/hooks/post-hooks.js";
import { hookPostWrite } from "../interfaces/hooks/post-write.js";
import { backlogAuditCommand } from "../interfaces/cli/audit/backlog-audit.js";
import { learningCommand } from "../interfaces/cli/audit/learning.js";
import { releaseNotesCommand } from "../interfaces/cli/audit/release-notes.js";
import { securityVerifyCommand } from "../interfaces/cli/audit/security-verify.js";
import { exportApiContractCommand } from "../interfaces/cli/spec/export-api-contract.js";
import { exportJsonSchemaCommand } from "../interfaces/cli/spec/export-json-schema.js";
import { openSpecReconcileCommand } from "../interfaces/cli/spec/openspec-reconcile.js";
import { agentCommand } from "../interfaces/cli/admin/agent.js";
import { policyCommand } from "../interfaces/cli/admin/policy.js";
import { statusCommand } from "../interfaces/cli/admin/status.js";
import { convergeCommand } from "../interfaces/cli/audit/converge.js";
import { installCommand } from "../interfaces/cli/bootstrap/install.js";
import { projectModeCommand } from "../interfaces/cli/bootstrap/project-mode.js";
import { restoreStableCommand } from "../interfaces/cli/bootstrap/restore-stable.js";
import { smokeCommand } from "../interfaces/cli/bootstrap/smoke.js";
import { projectStatusCommand } from "../interfaces/cli/reports/project-status.js";
import { reportCommand } from "../interfaces/cli/reports/report.js";
import { printTaskDependencies } from "../interfaces/cli/task-queue/task-dependencies.js";
import { readinessAuditCommand } from "../interfaces/cli/audit/readiness-audit.js";
import { planCommand } from "../interfaces/cli/spec/plan.js";
import { specDriftCommand } from "../interfaces/cli/spec/spec-drift.js";
import { printTaskGenerate } from "../interfaces/cli/task-queue/task-generate.js";
import { requeueTask } from "../interfaces/cli/task-queue/requeue.js";
import { moveTask } from "../interfaces/cli/task-queue/task-move.js";
import { taskLedgerSyncCommand } from "../interfaces/cli/task-queue/task-ledger-sync.js";
import { renderCliCommandList, type CliCommand, type CliIo } from "../interfaces/cli/registry.js";
import {
  apiContractExportPorts,
  jsonSchemaExportPorts,
  learningFs,
  openSpecReconcileFs,
  agentCommandPorts,
  blockedTaskRoutingPorts,
  gitHeadForProject,
  isFile,
  planPorts,
  policyCommandPorts,
  specDriftPorts,
  statusPorts,
  taskGeneratePorts,
  taskLedgerStore,
  taskStateStore,
  tokenBudgetPorts,
} from "./node-adapters.js";
import {
  adapterCapabilityViews,
  backlogAuditPorts,
  contextPackFs,
  convergePorts,
  projectStatusFs,
  releaseProofPorts,
  readinessPorts,
  readinessRequirements,
  releaseNotesPorts,
  securityVerifyPorts,
  writeReadinessResult,
} from "./readiness-adapters.js";
import { installPorts, projectModePorts, restoreStablePorts, smokePorts } from "./bootstrap-adapters.js";
import { nodeFsAdapter } from "../infrastructure/fs/node-fs-adapter.js";
import { postHookPorts } from "./hook-adapters.js";
import { cliEntryPath, templatesRoot, type RuntimeRoots } from "./runtime-context.js";

const nodeListFiles = (absoluteDir: string): Promise<string[]> => nodeFsAdapter.listFiles(absoluteDir);

export type CliRegistryDeps = {
  roots: RuntimeRoots;
  io?: CliIo;
};

/**
 * Migruotos ir surištos komandos. Sąrašas auga kartu su VQ-504 dalimis — kol komanda čia
 * neįrašyta, ji CLI neegzistuoja ir `help` jos nerodo. Tai sąmoninga: rodyti komandą, kurios
 * dispatch'as nepasiekia, reikštų meluoti operatoriui.
 */
export function buildCliCommands(deps: CliRegistryDeps): CliCommand[] {
  const io = deps.io;
  return [
    {
      name: "export-json-schema",
      usage: "[--out <dir>]",
      description: "Eksportuoja politikų JSON schemas į katalogą",
      run: (args) =>
        exportJsonSchemaCommand(
          { ports: jsonSchemaExportPorts, projectRoot: deps.roots.projectRoot, ...(io === undefined ? {} : { io }) },
          args,
        ),
    },
    {
      name: "export-api-contract",
      usage: "[--out <file>]",
      description: "Eksportuoja aktyvaus spec pakeitimo API kontraktą",
      run: (args) =>
        exportApiContractCommand(
          { ports: apiContractExportPorts, projectRoot: deps.roots.projectRoot, ...(io === undefined ? {} : { io }) },
          args,
        ),
    },
    {
      name: "learning",
      usage: "<list|approve|reject> [id]",
      description: "Learning atminties įrašai ir rekomendacijų sprendimai",
      run: (args) =>
        learningCommand({ fs: learningFs, runtimeRoot: deps.roots.runtimeRoot, ...(io === undefined ? {} : { io }) }, args),
    },
    {
      name: "task-ledger-sync",
      description: "Sutikrina task ledger'į su realiais bucket'ų failais",
      run: () =>
        taskLedgerSyncCommand({
          ledger: taskLedgerStore(deps.roots.runtimeRoot),
          listFiles: (absoluteDir) => nodeListFiles(absoluteDir),
          agRoot: deps.roots.agRoot,
          ...(io === undefined ? {} : { io }),
        }),
    },
    {
      name: "backlog-audit",
      usage: "[--json]",
      description: "Eilės backlog'o auditas (dublikatai, superseded, tuščios užduotys)",
      run: (args) =>
        backlogAuditCommand(
          { ports: backlogAuditPorts, projectRoot: deps.roots.projectRoot, ...(io === undefined ? {} : { io }) },
          args,
        ),
    },
    {
      name: "security-verify",
      usage: "[--json]",
      description: "Saugumo politikos patikra pakeistiems failams",
      run: (args) =>
        securityVerifyCommand(
          {
            ports: securityVerifyPorts(deps.roots.projectRoot, deps.roots.runtimeRoot),
            projectRoot: deps.roots.projectRoot,
            ...(io === undefined ? {} : { io }),
          },
          args,
        ),
    },
    {
      name: "release-notes",
      usage: "[--json]",
      description: "Generuoja release notes iš ledger'io ir būsenos",
      run: (args) =>
        releaseNotesCommand(
          {
            ports: releaseNotesPorts(deps.roots.projectRoot, deps.roots.runtimeRoot),
            ...(io === undefined ? {} : { io }),
          },
          args,
        ),
    },
    {
      name: "task-move",
      usage: "<task-file> <target-dir>",
      description: "Perkelia užduoties failą į kitą bucket'ą",
      run: (args) =>
        moveTask(args, {
          store: taskStateStore(deps.roots.agRoot, deps.roots.runtimeRoot),
          isFile,
          projectRoot: deps.roots.projectRoot,
          ...(io === undefined ? {} : { io }),
        }),
    },
    {
      name: "requeue",
      usage: "<task-file-or-name>",
      description: "Grąžina užduotį į eilę (ledger + biudžeto atstatymas)",
      run: (args) =>
        requeueTask(args, {
          store: taskStateStore(deps.roots.agRoot, deps.roots.runtimeRoot),
          ledger: taskLedgerStore(deps.roots.runtimeRoot),
          budget: tokenBudgetPorts(deps.roots.runtimeRoot),
          isFile,
          projectRoot: deps.roots.projectRoot,
          ...(io === undefined ? {} : { io }),
        }),
    },
    {
      name: "status",
      usage: "",
      description: "Eilės, einamojo task'o, tokenų ir stop įrodymo santrauka",
      run: () =>
        statusCommand({
          ports: statusPorts(deps.roots.projectRoot, deps.roots.runtimeRoot, deps.roots.agRoot),
          projectRoot: deps.roots.projectRoot,
          runtimeRoot: deps.roots.runtimeRoot,
          ...(io === undefined ? {} : { io }),
        }),
    },
    {
      name: "plan",
      usage: "[--force]",
      description: "Sukuria architektūros kontraktą iš aktyvios spec'ifikacijos",
      run: (args) =>
        planCommand(
          { ports: planPorts, projectRoot: deps.roots.projectRoot, ...(io === undefined ? {} : { io }) },
          args,
        ),
    },
    {
      name: "task-generate",
      usage: "[--change <id>] [--start <n>]",
      description: "Generuoja eilės užduotis iš spec plano",
      run: (args) =>
        printTaskGenerate(args, {
          ports: taskGeneratePorts,
          projectRoot: deps.roots.projectRoot,
          runtimeRoot: deps.roots.runtimeRoot,
          ...(io === undefined ? {} : { io }),
        }),
    },
    {
      name: "spec-drift",
      usage: "<change-id>",
      description: "Lygina pakeistus failus su spec change scope",
      run: (args) =>
        specDriftCommand(
          {
            ports: specDriftPorts(deps.roots.projectRoot, deps.roots.runtimeRoot),
            projectRoot: deps.roots.projectRoot,
            ...(io === undefined ? {} : { io }),
          },
          args,
        ),
    },
    {
      name: "converge",
      usage: "",
      description: "Sutikrina spec planus su eilės failais",
      run: (args) =>
        convergeCommand(
          {
            ports: convergePorts,
            projectRoot: deps.roots.projectRoot,
            runtimeRoot: deps.roots.runtimeRoot,
            ...(io === undefined ? {} : { io }),
          },
          args,
        ),
    },
    {
      name: "readiness-audit",
      usage: "[--json]",
      description: "Produkto pasirengimo auditas (aplankai, konfigai, komandos, testai, docs)",
      run: (args) =>
        readinessAuditCommand(
          {
            ports: readinessPorts,
            requirements: readinessRequirements,
            projectRoot: deps.roots.projectRoot,
            writeResult: writeReadinessResult(deps.roots.runtimeRoot),
            ...(io === undefined ? {} : { io }),
          },
          args,
        ),
    },
    {
      name: "policy",
      usage: "[list|propose ...]",
      description: "Politikų peržiūra ir pasiūlymų žurnalas",
      run: (args) =>
        policyCommand(
          { ports: policyCommandPorts, runtimeRoot: deps.roots.runtimeRoot, ...(io === undefined ? {} : { io }) },
          args,
        ),
    },
    {
      name: "agent",
      usage: "[list|add|remove ...]",
      description: "Agentų personų registras",
      run: (args) =>
        agentCommand(
          {
            ports: agentCommandPorts,
            projectRoot: deps.roots.projectRoot,
            runtimeRoot: deps.roots.runtimeRoot,
            ...(io === undefined ? {} : { io }),
          },
          args,
        ),
    },
    {
      name: "project-status",
      usage: "",
      description: "Projekto būsenos dokumentas iš spec, eilės ir release įrodymo",
      run: () =>
        projectStatusCommand({
          fs: projectStatusFs(),
          releaseProof: releaseProofPorts(deps.roots.projectRoot, deps.roots.runtimeRoot, deps.roots.agRoot),
          gitHead: () => gitHeadForProject(deps.roots.projectRoot),
          projectRoot: deps.roots.projectRoot,
          runtimeRoot: deps.roots.runtimeRoot,
          ...(io === undefined ? {} : { io }),
        }),
    },
    {
      name: "report",
      usage: "[--json] [--recent <n>]",
      description: "Vietinė telemetrijos ataskaita (užduotys, tokenai, kompresija, adapteriai)",
      run: (args) =>
        reportCommand(
          {
            fs: projectStatusFs(),
            contextFs: contextPackFs,
            adapterCapabilities: adapterCapabilityViews,
            projectRoot: deps.roots.projectRoot,
            runtimeRoot: deps.roots.runtimeRoot,
            ...(io === undefined ? {} : { io }),
          },
          args,
        ),
    },
    {
      name: "task-dependencies",
      usage: "[list|route-blocked <task-id>] [--json]",
      description: "Užduočių priklausomybės ir blokuotų užduočių maršrutizavimas",
      run: (args) =>
        printTaskDependencies(args, {
          ports: blockedTaskRoutingPorts(deps.roots.projectRoot, deps.roots.agRoot, deps.roots.runtimeRoot),
          ...(io === undefined ? {} : { io }),
        }),
    },
    {
      name: "project-mode",
      usage: "[--json]",
      description: "Nustato projekto režimą (naujas, tęsiamas, nutrūkęs)",
      run: (args) =>
        projectModeCommand(
          {
            ports: projectModePorts,
            projectRoot: deps.roots.projectRoot,
            runtimeRoot: deps.roots.runtimeRoot,
            ...(io === undefined ? {} : { io }),
          },
          args,
        ),
    },
    {
      name: "install",
      usage: "[--dry-run]",
      description: "Įdiegia šablonus į projektą (esamų failų neperrašo)",
      run: (args) =>
        installCommand(
          { ports: installPorts, templatesRoot: templatesRoot(), ...(io === undefined ? {} : { io }) },
          args,
        ),
    },
    {
      name: "smoke",
      usage: "",
      description: "Aplinkos ir eilės smoke patikra (nieko nekeičia)",
      run: () =>
        smokeCommand({
          ports: smokePorts(deps.roots.agRoot, deps.roots.runtimeRoot),
          projectRoot: deps.roots.projectRoot,
          runtimeRoot: deps.roots.runtimeRoot,
          cliEntry: cliEntryPath(),
          ...(io === undefined ? {} : { io }),
        }),
    },
    {
      name: "restore-stable",
      usage: "[--execute]",
      description: "Atkuria medį iš stable-ref (be --execute tik parodo planą)",
      run: (args) =>
        restoreStableCommand(
          {
            ports: restoreStablePorts,
            projectRoot: deps.roots.projectRoot,
            runtimeRoot: deps.roots.runtimeRoot,
            ...(io === undefined ? {} : { io }),
          },
          args,
        ),
    },
    // --- PostToolUse hook'ai (VQ-502) --------------------------------------------------
    // Jie NIEKADA neblokuoja: handler'iai grąžina 0, o dispatch'as tą kodą tik perduoda.
    ...postToolUseCommands(deps),
    {
      name: "openspec-reconcile",
      usage: "[--apply]",
      description: "Sutikrina OpenSpec pakeitimus su užduočių būsena",
      run: (args) =>
        openSpecReconcileCommand(
          { fs: openSpecReconcileFs, agRoot: deps.roots.agRoot, ...(io === undefined ? {} : { io }) },
          args,
        ),
    },
  ];
}

/** `help` tekstas: antraštė plius registro eilutės deklaravimo tvarka. */
export function renderCliHelp(commands: readonly CliCommand[]): string[] {
  return ["Usage: verqestra <command> [args]", "", "Commands:", ...renderCliCommandList(commands).map((line) => `  ${line}`)];
}

/**
 * PostToolUse hook'ų įėjimai. Visi dalijasi tais pačiais portais, tad jie sudedami vienu
 * pjūviu — kiekvienas atskirai kartotų tą patį surišimą.
 */
function postToolUseCommands(deps: CliRegistryDeps): CliCommand[] {
  const io = deps.io;
  const hookDeps = {
    ports: postHookPorts(),
    projectRoot: deps.roots.projectRoot,
    runtimeRoot: deps.roots.runtimeRoot,
    ...(io === undefined ? {} : { io }),
  };

  return [
    {
      name: "hook-post-bash",
      description: "PostToolUse: Bash žurnalas ir digest shadow telemetrija",
      run: () => hookPostBash(hookDeps),
    },
    {
      name: "hook-post-bash-sync",
      description: "PostToolUse: sinchroninis Bash išvesties digest kelias",
      run: () => hookPostBashSync(hookDeps),
    },
    {
      name: "hook-post-read",
      description: "PostToolUse: readme skaitymo įrodymas",
      run: () => hookPostRead(hookDeps),
    },
    {
      name: "hook-post-write",
      description: "PostToolUse: sesijos rašymų ledger'is ir KPI įvykiai",
      run: () => hookPostWrite(hookDeps),
    },
  ];
}
