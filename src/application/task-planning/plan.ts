// `plan` use case (etalonas: interfaces/cli/plan/index.ts plan() pusė, WBR VQ-501 3/5-b):
// aktyvi spec (AG/spec/changes — FQC-12 per spec-source findActiveSpec) validuojama dėl
// privalomų failų, o architektūros kontraktas generuojamas/validuojamas
// `vq/project/architecture-contract.json` (etalone — AG/project/). Kontrakto TURINYS —
// etalono šablonas 1:1 kaip DUOMENYS (dependency_direction eilutės aprašo etalono commands/
// core layout'ą — tai užšaldyta šablono forma, ne VERQESTRA sluoksnių deklaracija; keisti
// tik su atskiru kontrakto sprendimu). CLI rendinimas/exit — E5 interfaces.

import path from "node:path";
import {
  loadArchitectureContract,
  parseArchitectureContract,
  type ArchitectureContract,
} from "../policy-governance/architecture-contract.js";
import { findActiveSpec, type TaskPlanningFsPort } from "./spec-source.js";

export type PlanResult = {
  specId: string;
  specPath: string;
  contractPath: string;
  contract: ArchitectureContract;
  state: "created" | "overwritten" | "validated";
};

export type PlanPorts = {
  fs: TaskPlanningFsPort;
  /** Sukuria tėvinius katalogus ir įrašo tekstą (etalono writeTextIfMissing rašymo pusė). */
  writeTextFile(absolutePath: string, text: string): Promise<void>;
};

const requiredSpecFiles = ["proposal.md", "requirements.md", "design.md", "tasks.md", "acceptance.md", "risks.md"];

export async function plan(ports: PlanPorts, args: string[], projectRoot: string): Promise<PlanResult> {
  const force = args.includes("--force");
  const root = path.resolve(projectRoot);
  const activeSpec = await findActiveSpec(ports.fs, root);
  await assertRequiredSpecFiles(ports.fs, activeSpec.changeDir);

  const contractPath = path.join(root, "vq", "project", "architecture-contract.json");
  const contract = architectureContractFromSpec(activeSpec.relativeSpecPath);

  const contractExists = await ports.fs.exists(contractPath);
  if (contractExists && !force) {
    const existing = await loadArchitectureContract(ports.fs, contractPath);
    return {
      specId: activeSpec.id,
      specPath: activeSpec.relativeSpecPath,
      contractPath,
      contract: existing,
      state: "validated",
    };
  }

  await ports.writeTextFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`);
  return {
    specId: activeSpec.id,
    specPath: activeSpec.relativeSpecPath,
    contractPath,
    contract: parseArchitectureContract(contract, contractPath),
    state: contractExists ? "overwritten" : "created",
  };
}

async function assertRequiredSpecFiles(fs: TaskPlanningFsPort, changeDir: string): Promise<void> {
  const missing: string[] = [];
  for (const fileName of requiredSpecFiles) {
    const filePath = path.join(changeDir, fileName);
    const content = await fs.readTextFileIfExists(filePath);
    if (content === undefined || content.trim().length === 0) {
      missing.push(filePath);
    }
  }

  if (missing.length > 0) {
    throw new Error(`Required spec files missing or empty: ${missing.join(", ")}`);
  }
}

function architectureContractFromSpec(relativeSpecPath: string): ArchitectureContract {
  return parseArchitectureContract(
    {
      version: "1.0.0",
      generated_from: relativeSpecPath.replace(/\\/g, "/"),
      boundaries: {
        ag_core_is_deterministic: true,
        execution_agent_gets_one_bounded_task: true,
        context_pack_is_task_specific: true,
        no_browser_scraper_mcp_by_default: true,
        tests_required_for_new_behavior: true,
      },
      // VQ-703: kryptys aprašo VERQESTRA sluoksnius, o ne etalono `AG/orchestrator` išdėstymą.
      // Sugeneruotas kontraktas, vardijantis katalogus, kurių projekte nėra, yra blogesnis už
      // tuščią: jis atrodo autoritetingas ir siunčia agentą į neegzistuojančias ribas.
      dependency_direction: [
        "src/domain -> src/domain, src/shared",
        "src/application -> src/application, src/domain, src/shared",
        "src/infrastructure -> src/infrastructure, src/application, src/domain, src/shared",
        "src/interfaces -> src/interfaces, src/application, src/domain, src/shared (NOT infrastructure)",
        "src/composition -> everything; nothing imports composition",
        "vq/config -> read-only policy input, validated by application loaders",
        "AG/spec -> read-only unless task scope allows writes",
      ],
      security_rules: {
        no_secrets_in_repo: true,
        no_env_files_created_by_commands: true,
        dangerous_shell_execution_blocked: true,
        non_core_tools_disabled_by_default: true,
      },
      checks: ["pnpm build", "pnpm test"],
    },
    "architecture contract",
  );
}
