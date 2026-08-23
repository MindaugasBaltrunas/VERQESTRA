// Audito, politiku ir ataskaitu komandu registro pjuvis (VQ-504).
//
// Bendra tema -- ar produktas tvarkingas: backlog, saugumo patikra, release notes,
// konvergencija, pasirengimo auditas, politikos, agentai ir dvi ataskaitos.

import type { CliCommand } from "../../interfaces/cli/registry.js";
import type { CliRegistryDeps } from "./registry-types.js";
import { agentCommand } from "../../interfaces/cli/admin/agent.js";
import { policyCommand } from "../../interfaces/cli/admin/policy.js";
import { auditDirectorCommand } from "../../interfaces/cli/audit/audit-director.js";
import { backlogAuditCommand } from "../../interfaces/cli/audit/backlog-audit.js";
import { convergeCommand } from "../../interfaces/cli/audit/converge.js";
import { qualityGatesCommand } from "../../interfaces/cli/audit/quality-gates.js";
import { qualityGatesPorts } from "../quality/adapters.js";
import { finalAuditCommand } from "../../interfaces/cli/audit/final-audit.js";
import { preflightCommand } from "../../interfaces/cli/bootstrap/preflight.js";
import { readinessAuditCommand } from "../../interfaces/cli/audit/readiness-audit.js";
import { releaseNotesCommand } from "../../interfaces/cli/audit/release-notes.js";
import { securityVerifyCommand } from "../../interfaces/cli/audit/security-verify.js";
import { projectStatusCommand } from "../../interfaces/cli/reports/project-status.js";
import { reportCommand } from "../../interfaces/cli/reports/report.js";
import { agentCommandPorts, gitHeadForProject, policyCommandPorts } from "../runtime/node-adapters.js";
import { buildGateCommand } from "../../interfaces/cli/audit/build-gate.js";
import { milestoneCheckCommand } from "../../interfaces/cli/audit/milestone-check.js";
import { releaseCheckCommand } from "../../interfaces/cli/audit/release-check.js";
import {
  buildGatePorts,
  milestoneCheckPorts,
  milestoneCheckRunners,
  releaseCheckPorts,
  releaseCheckRunners,
  RELEASE_SOURCE_STATE_INPUTS,
} from "../quality/release-check-adapters.js";
import { packageRoot } from "../runtime/context.js";
import { finalAuditPorts } from "../quality/final-audit-adapters.js";
import { auditDirectorPorts, preflightPorts } from "../quality/adapters.js";
import {
  adapterCapabilityViews,
  backlogAuditPorts,
  contextPackFs,
  convergePorts,
  projectStatusFs,
  readinessPorts,
  readinessRequirements,
  releaseNotesPorts,
  releaseProofPorts,
  securityVerifyPorts,
  writeReadinessResult,
} from "../quality/readiness-adapters.js";

export function auditCommands(deps: CliRegistryDeps): CliCommand[] {
  const io = deps.io;
  return [
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
      name: "quality-gates",
      usage: "[scope] [--json] [--no-memo]",
      description: "Sukonfigūruoti lint/typecheck/test/build vartai su statusu ir log'u",
      run: (args) =>
        qualityGatesCommand(
          {
            ports: qualityGatesPorts(deps.roots.runtimeRoot, deps.roots.projectRoot),
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
      name: "audit-director",
      usage: "",
      description: "Kokybės patikros ciklu su taisančiu agentu (iki 3 iteracijų)",
      run: () =>
        auditDirectorCommand({
          ports: auditDirectorPorts(deps.roots.projectRoot, deps.roots.runtimeRoot, deps.roots.agRoot),
          projectRoot: deps.roots.projectRoot,
          runtimeRoot: deps.roots.runtimeRoot,
          ...(io === undefined ? {} : { io }),
        }),
    },
    {
      name: "final-audit",
      usage: "[--json]",
      description: "Galutinis išleidimo verdiktas iš visų vartų ir įrodymo artefaktų",
      run: (args) =>
        finalAuditCommand(
          {
            ports: finalAuditPorts(deps.roots.projectRoot, deps.roots.runtimeRoot, deps.roots.agRoot),
            projectRoot: deps.roots.projectRoot,
            runtimeRoot: deps.roots.runtimeRoot,
            sourceStateInputs: RELEASE_SOURCE_STATE_INPUTS,
            ...(io === undefined ? {} : { io }),
          },
          args,
        ),
    },
    {
      name: "preflight",
      usage: "<task-file> [--json]",
      description: "Vartai prieš dispatch'ą: dydis, spec šaltiniai, biudžetas, agentai",
      run: (args) =>
        preflightCommand(
          {
            ports: preflightPorts(deps.roots.projectRoot, deps.roots.runtimeRoot),
            projectRoot: deps.roots.projectRoot,
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
      name: "build-gate",
      usage: "",
      description: "Ar sugeneruotas dist atitinka src (hook'ai ir loop vykdo dist)",
      run: (args) =>
        buildGateCommand(
          {
            ports: buildGatePorts,
            packageRoot: packageRoot(),
            ...(io === undefined ? {} : { io }),
          },
          args,
        ),
    },
    {
      name: "milestone-check",
      usage: "",
      description: "Milestone vartai: kokybė, spec derėjimas, saugumo politika",
      run: (args) =>
        milestoneCheckCommand(
          {
            ports: milestoneCheckPorts(deps.roots.projectRoot, deps.roots.runtimeRoot),
            runners: milestoneCheckRunners(deps.roots.projectRoot, deps.roots.runtimeRoot),
            ...(io === undefined ? {} : { io }),
          },
          args,
        ),
    },
    {
      name: "release-check",
      usage: "",
      description: "Išleidimo vartai: build, testai, milestone, dokumentai, paketo forma",
      run: (args) =>
        releaseCheckCommand(
          {
            ports: releaseCheckPorts(deps.roots.runtimeRoot),
            runners: releaseCheckRunners(deps.roots.projectRoot, deps.roots.runtimeRoot),
            projectRoot: deps.roots.projectRoot,
            sourceStateInputs: RELEASE_SOURCE_STATE_INPUTS,
            ...(io === undefined ? {} : { io }),
          },
          args,
        ),
    },
  ];
}
