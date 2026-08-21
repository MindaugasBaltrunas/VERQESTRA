// `agent` CLI adapteris (etalonas: interfaces/cli/agent/index.ts): agentų registro
// (`vq/config/agents.json`) ir jų personų (`.claude/agents/<name>.md`) valdymas.
//
// Registras ir persona keičiami KARTU: įregistruotas agentas be personos failo yra
// vaidmuo, kurio niekas negali atlikti, o persona be registro — failas, kurio niekas
// nemaršrutizuos. Todėl `add` rašo abu, `enable` atsisako, kai personos nėra, o `remove`
// šalina abu (nebent `--keep-file`).
//
// Numatytojo vaidmens apsauga: jo negalima nei išjungti, nei pašalinti — be jo maršrutizacija
// neturėtų į ką kristi.

import path from "node:path";
import {
  ADAPTERS,
  MODEL_HINTS,
  type AgentAdapterKind,
  type AgentModelHint,
  type AgentPolicy,
} from "../../../domain/policies/agent-selection.js";
import {
  agentPolicyConfigPath,
  agentRoleIdSchema,
  loadAgentPolicy,
  parseAgentPolicy,
} from "../../../application/policy-governance/agent-policy.js";
import type { PolicyConfigFileSystemPort } from "../../../application/policy-governance/ports.js";
import { consoleCliIo, type CliIo } from "../registry.js";

export type AgentCommandPorts = {
  policyFs: PolicyConfigFileSystemPort;
  /** `.claude/agents` failų vardai; nesamas katalogas — []. */
  listPersonaFiles(absoluteDir: string): Promise<string[]>;
  /** Personos šaltinio turinys (`--from`); meta klaidą, kai failo nėra. */
  readTextFile(absolutePath: string): Promise<string>;
  writeTextFile(absolutePath: string, content: string): Promise<void>;
  /** Atominis JSON rašymas (registras niekada nelieka pusiau įrašytas). */
  writeJsonFile(absolutePath: string, value: unknown): Promise<void>;
  /** Trynimas be klaidos, kai failo nėra. */
  removeFile(absolutePath: string): Promise<void>;
  exists(absolutePath: string): Promise<boolean>;
};

export type AgentCommandDeps = {
  ports: AgentCommandPorts;
  projectRoot: string;
  /** vq runtime šaknis (`<root>/vq`) — agentų registras. */
  runtimeRoot?: string;
  io?: CliIo;
};

export type AgentRow = {
  name: string;
  enabled: boolean;
  registered: boolean;
  persona: boolean;
  adapters: string[];
  model: string | null;
  can_write_code: boolean | null;
};

const USAGE =
  "Usage: verqestra agent [list [--json]|add <name> [--from <file>] [--adapter <list>] [--model <tier>] [--read-only] [--force]|enable <name>|disable <name>|remove <name> [--keep-file]]";

function option(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(`--${name}`);
}

function roleName(value: string | undefined): string {
  const parsed = agentRoleIdSchema.safeParse(value ?? "");
  if (!parsed.success) {
    throw new Error(`Invalid agent name '${value ?? ""}': use lowercase letters, digits, and hyphens`);
  }
  return parsed.data;
}

function clonePolicy(policy: AgentPolicy): AgentPolicy {
  return {
    ...policy,
    roles: Object.fromEntries(
      Object.entries(policy.roles).map(([name, config]) => [
        name,
        { ...config, allowed_adapters: [...config.allowed_adapters] },
      ]),
    ),
  };
}

function personaTemplate(name: string): string {
  return [
    "---",
    `name: ${name}`,
    `description: Project-local ${name} agent. Replace this description with its routing purpose.`,
    "tools: Read, Glob, Grep, Write, Edit, Bash",
    "---",
    "",
    `# ${name}`,
    "",
    "Read the project README, AGENTS.md when present, and the active task before changing files.",
    "",
    "## Responsibility",
    "",
    "Describe the project-specific responsibility, boundaries, required checks, and stop conditions for this agent.",
    "",
  ].join("\n");
}

/** Frontmatter vardas privalo sutapti su registruojamu — kitaip Claude paleistų kitą agentą. */
function validatePersonaName(content: string, expected: string): void {
  const frontmatterName = content.match(/^---\s*[\s\S]*?^name:\s*([^\r\n]+)\s*$/m)?.[1]?.trim();
  if (frontmatterName && frontmatterName !== expected) {
    throw new Error(`Agent file frontmatter name '${frontmatterName}' must match '${expected}'`);
  }
}

function personaPath(deps: AgentCommandDeps, name: string): string {
  return path.join(deps.projectRoot, ".claude", "agents", `${name}.md`);
}

function registryPath(deps: AgentCommandDeps): string {
  return agentPolicyConfigPath(deps.runtimeRoot ?? path.join(deps.projectRoot, "vq"));
}

async function currentPolicy(deps: AgentCommandDeps): Promise<AgentPolicy> {
  return await loadAgentPolicy(deps.ports.policyFs, deps.runtimeRoot ?? path.join(deps.projectRoot, "vq"));
}

async function savePolicy(deps: AgentCommandDeps, policy: AgentPolicy): Promise<void> {
  const file = registryPath(deps);
  // Validuojam PRIEŠ rašant: sugadintas registras nutildytų maršrutizaciją visiems agentams.
  await deps.ports.writeJsonFile(file, parseAgentPolicy(policy, file));
}

async function listAgents(deps: AgentCommandDeps, io: CliIo, json: boolean): Promise<number> {
  const policy = await currentPolicy(deps);
  const files = await deps.ports.listPersonaFiles(path.join(deps.projectRoot, ".claude", "agents"));
  const personaNames = new Set(files.filter((file) => file.endsWith(".md")).map((file) => file.slice(0, -3)));
  const names = [...new Set([...Object.keys(policy.roles), ...personaNames])].sort();

  const rows: AgentRow[] = names.map((name) => {
    const config = policy.roles[name];
    return {
      name,
      enabled: Boolean(config) && config?.enabled !== false,
      registered: Boolean(config),
      persona: personaNames.has(name),
      adapters: config?.allowed_adapters ?? [],
      model: config?.default_model_hint ?? null,
      can_write_code: config?.can_write_code ?? null,
    };
  });

  if (json) {
    io.out(JSON.stringify({ default_role: policy.default_role, agents: rows }, null, 2));
    return 0;
  }

  io.out(`Default agent: ${policy.default_role}`);
  io.out("NAME\tSTATUS\tPERSONA\tADAPTERS\tMODEL\tWRITE");
  for (const row of rows) {
    const status = !row.registered ? "unregistered" : row.enabled ? "enabled" : "disabled";
    io.out(
      `${row.name}\t${status}\t${row.persona ? "yes" : "missing"}\t${row.adapters.join(",") || "-"}\t${row.model ?? "-"}\t${row.can_write_code ?? "-"}`,
    );
  }
  return 0;
}

async function addAgent(deps: AgentCommandDeps, io: CliIo, args: string[]): Promise<number> {
  const name = roleName(args[1]);
  const policy = clonePolicy(await currentPolicy(deps));
  const persona = personaPath(deps, name);

  if (!hasFlag(args, "force") && (policy.roles[name] || (await deps.ports.exists(persona)))) {
    throw new Error(`Agent '${name}' already exists; use --force to replace its registration and persona`);
  }

  const from = option(args, "from");
  const content = from ? await deps.ports.readTextFile(path.resolve(deps.projectRoot, from)) : personaTemplate(name);
  validatePersonaName(content, name);

  const adapterValues = (option(args, "adapter") ?? "claude")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const invalidAdapters = adapterValues.filter((value) => !(ADAPTERS as string[]).includes(value));
  if (invalidAdapters.length > 0) throw new Error(`Invalid adapter(s): ${invalidAdapters.join(", ")}`);

  const model = option(args, "model") ?? "sonnet";
  if (!(MODEL_HINTS as string[]).includes(model)) {
    throw new Error(`Invalid model '${model}'; use ${MODEL_HINTS.join(", ")}`);
  }

  policy.roles[name] = {
    allowed_adapters: adapterValues as AgentAdapterKind[],
    default_model_hint: model as AgentModelHint,
    can_write_code: !hasFlag(args, "read-only"),
    enabled: true,
  };

  await deps.ports.writeTextFile(persona, content.endsWith("\n") ? content : `${content}\n`);
  await savePolicy(deps, policy);

  io.out(`Added agent '${name}'`);
  io.out(`Persona: .claude/agents/${name}.md`);
  io.out(`Registry: ${path.relative(deps.projectRoot, registryPath(deps)).split(path.sep).join("/")}`);
  return 0;
}

async function setEnabled(deps: AgentCommandDeps, io: CliIo, args: string[], enabled: boolean): Promise<number> {
  const name = roleName(args[1]);
  const policy = clonePolicy(await currentPolicy(deps));
  const config = policy.roles[name];
  if (!config) throw new Error(`Agent '${name}' is not registered`);
  if (!enabled && name === policy.default_role) throw new Error(`Cannot disable default agent '${name}'`);
  if (enabled && !(await deps.ports.exists(personaPath(deps, name)))) {
    throw new Error(`Cannot enable '${name}': .claude/agents/${name}.md is missing`);
  }

  config.enabled = enabled;
  await savePolicy(deps, policy);
  io.out(`${enabled ? "Enabled" : "Disabled"} agent '${name}'`);
  return 0;
}

async function removeAgent(deps: AgentCommandDeps, io: CliIo, args: string[]): Promise<number> {
  const name = roleName(args[1]);
  const policy = clonePolicy(await currentPolicy(deps));
  const persona = personaPath(deps, name);

  if (name === policy.default_role) throw new Error(`Cannot remove default agent '${name}'`);
  if (!policy.roles[name] && !(await deps.ports.exists(persona))) throw new Error(`Agent '${name}' does not exist`);

  delete policy.roles[name];
  await savePolicy(deps, policy);
  const keepFile = hasFlag(args, "keep-file");
  if (!keepFile) await deps.ports.removeFile(persona);

  io.out(`Removed agent '${name}'${keepFile ? " from registry (persona kept)" : ""}`);
  return 0;
}

export async function agentCommand(deps: AgentCommandDeps, args: string[] = []): Promise<number> {
  const io = deps.io ?? consoleCliIo;
  try {
    const action = args[0] ?? "list";
    if (action === "list") return await listAgents(deps, io, hasFlag(args, "json"));
    if (action === "add") return await addAgent(deps, io, args);
    if (action === "enable") return await setEnabled(deps, io, args, true);
    if (action === "disable") return await setEnabled(deps, io, args, false);
    if (action === "remove") return await removeAgent(deps, io, args);
    throw new Error(USAGE);
  } catch (error: unknown) {
    io.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}
