// Vieno queue task failo renderis iš spec task eilutės. Elgesio etalonas: AG_loop
// application/task-planning/queue-task.ts. Grynas — klasifikacija ir grandinė iš
// domain/policies; enforcement politiką paduoda kvietėjas.

import { serializeAgentChain } from "../../domain/policies/agent-selection.js";
import { classifyTask } from "../../domain/policies/task-classification.js";
import { defaultTaskClassificationPolicy } from "../../domain/policies/task-classification-defaults.js";
import type { EnforcementPolicy } from "../policy-governance/architecture-policies.js";
import type { SpecTaskLine } from "./spec-task-lines.js";

// Parenka agentų grandinę pagal task'o klasifikaciją (readme-guard visada pirmas gate'as).
// Taip ## Agentai laukas atspindi tikrą rizikos/atsakomybės tipą, ne visada „coder".
export function agentChainForTitle(title: string): string[] {
  const { categories } = classifyTask(title, ["AG/**"], defaultTaskClassificationPolicy);
  if (categories.includes("architecture")) return ["readme-guard", "architect", "coder", "reviewer"];
  if (categories.includes("policy-sensitive")) return ["readme-guard", "architect", "security", "coder", "reviewer"];
  if (categories.includes("data")) return ["readme-guard", "data-model", "coder", "reviewer"];
  return ["readme-guard", "coder", "reviewer"];
}

export function inferAllowedPaths(title: string): { paths: string[]; isBroad: boolean } {
  const classification = classifyTask(title, ["AG/**"], defaultTaskClassificationPolicy);
  if (classification.reasons.includes("routine: default classification")) {
    return { paths: ["AG/orchestrator/**"], isBroad: true };
  }
  const paths: string[] = [];
  for (const category of classification.categories) {
    const rule = defaultTaskClassificationPolicy.categories[category];
    for (const p of rule.pathIncludes) {
      if (!p.includes("/")) continue;
      const clean = p.replace(/\/+$/, "");
      paths.push(clean.startsWith("AG/") ? `${clean}/**` : `AG/orchestrator/${clean}/**`);
    }
  }
  const unique = [...new Set(paths)];
  return unique.length > 0 ? { paths: unique, isBroad: false } : { paths: ["AG/orchestrator/**"], isBroad: true };
}

export function renderQueueTask(
  taskLine: SpecTaskLine,
  specPath: string,
  tasksPath: string,
  enforcement: EnforcementPolicy,
): string {
  const title = taskLine.title.replace(/^[-*]\s+/, "").trim();
  const chainTokens = agentChainForTitle(title);
  if (enforcement.require_tests_for_code_changes && !chainTokens.includes("tester")) {
    chainTokens.push("tester");
  }
  if (enforcement.require_interface_contract_for_public_changes && !chainTokens.includes("supervisor")) {
    chainTokens.push("supervisor");
  }
  const chain = serializeAgentChain(chainTokens);
  const { paths, isBroad } = inferAllowedPaths(title);
  const allowedPathsBlock = paths.map((p) => `- \`${p}\``).join("\n");
  const broadWarningBlock =
    enforcement.broad_scope_requires_human_review && isBroad
      ? `\n> BROAD SCOPE: generated allowed paths include ${paths.join(", ")}; review before execution.\n`
      : "";
  return `# Task\n\n## Spec source\n${specPath}\n${tasksPath.replace(/\\/g, "/")}\n\n## Tikslas\n${title}.\n\n## Agentai\n${chain}\n\n## Failai\nLeidžiama:\n${allowedPathsBlock}\n${broadWarningBlock}\nDraudžiama:\n- \`.env\`\n- \`.env.*\`\n- \`node_modules/**\`\n- \`dist/**\`\n\n## Veiksmas\n- Įgyvendinti: ${title}.\n\n## Patikra\n- \`pnpm build\`\n- \`pnpm test\`\n\n## Stop\nSustoti, kai patikros praeina ir pakeitimai lieka šiame task scope.\n\n## Neįtraukta\n- LLM kvietimai.\n- Queue loop vykdymas.\n- Naršyklės, scraper, MCP ar vector DB integracijos.\n`;
}
