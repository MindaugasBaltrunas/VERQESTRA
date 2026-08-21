// `policy` CLI adapteris (etalonas: interfaces/cli/policy/index.ts): valdomų politikų
// peržiūra, pasiūlymo įrašymas ir pasiūlymų būsena.
//
// Pasiūlymas atmetamas KŪRIMO metu, jei policy failas nėra registre arba jei siūloma reikšmė
// nepraeina to failo schemos: taikymo kelias moka užkrauti/validuoti/įrašyti tik registro
// failus, tad pasiūlymas, kurio niekas negalės pritaikyti, neturi patekti į žurnalą.
//
// VERQESTRA skirtumai: politikų ir žurnalo IO — per application portus, keliai vq/….

import path from "node:path";
import {
  loadArchitectureStylePolicy,
  loadCodingPrinciplesPolicy,
  loadEnforcementPolicy,
} from "../../../application/policy-governance/architecture-policies.js";
import {
  findPolicyFileEntry,
  UnsupportedPolicyFileError,
} from "../../../application/policy-governance/policy-file-registry.js";
import {
  appendPolicyProposal,
  policyProposalsDir,
  POLICY_ROUTINGS,
  type PolicyProposal,
  type PolicyProposalsFsPort,
  type PolicyRouting,
} from "../../../application/policy-governance/policy-proposals-log.js";
import type { PolicyConfigFileSystemPort } from "../../../application/policy-governance/ports.js";
import { consoleCliIo, type CliIo } from "../registry.js";

export type PolicyCommandPorts = {
  configFs: PolicyConfigFileSystemPort;
  proposalsFs: PolicyProposalsFsPort;
};

export type PolicyCommandDeps = {
  ports: PolicyCommandPorts;
  /** vq runtime šaknis (`<root>/vq`). */
  runtimeRoot: string;
  /** Pasiūlymo laiko antspaudas (testams); numatytai — realus laikrodis. */
  now?: () => Date;
  io?: CliIo;
};

const USAGE = "Usage: policy [show|propose|status] [--json]";
const PROPOSE_USAGE =
  "Usage: policy propose <policy-file> <setting-id> <value> [--reason <text>] [--routing queue|human-review]";

export async function policyCommand(deps: PolicyCommandDeps, args: string[] = []): Promise<number> {
  const io = deps.io ?? consoleCliIo;
  const subcommand = args[0];

  if (subcommand === "show") return await showPolicies(deps, args, io);
  if (subcommand === "propose") return await proposeSetting(deps, args, io);
  if (subcommand === "status") return await showProposalStatus(deps, args, io);

  io.error(USAGE);
  return 1;
}

async function showPolicies(deps: PolicyCommandDeps, args: string[], io: CliIo): Promise<number> {
  const { configFs } = deps.ports;
  const [architectureStyle, codingPrinciples, enforcement] = await Promise.all([
    loadArchitectureStylePolicy(configFs, deps.runtimeRoot),
    loadCodingPrinciplesPolicy(configFs, deps.runtimeRoot),
    loadEnforcementPolicy(configFs, deps.runtimeRoot),
  ]);

  if (args.includes("--json")) {
    io.out(
      JSON.stringify(
        { architecture_style: architectureStyle, coding_principles: codingPrinciples, enforcement },
        null,
        2,
      ),
    );
    return 0;
  }

  io.out("=== architecture-style ===");
  io.out(JSON.stringify(architectureStyle, null, 2));
  io.out("");
  io.out("=== coding-principles ===");
  io.out(JSON.stringify(codingPrinciples, null, 2));
  io.out("");
  io.out("=== enforcement ===");
  io.out(JSON.stringify(enforcement, null, 2));
  return 0;
}

function isPolicyRouting(value: string): value is PolicyRouting {
  return (POLICY_ROUTINGS as readonly string[]).includes(value);
}

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  const value = index === -1 ? undefined : args[index + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
}

async function proposeSetting(deps: PolicyCommandDeps, args: string[], io: CliIo): Promise<number> {
  const policyFile = args[1];
  const settingId = args[2];
  const rawValue = args[3];
  if (!policyFile || !settingId || rawValue === undefined) {
    io.error(PROPOSE_USAGE);
    return 1;
  }

  const entry = findPolicyFileEntry(policyFile);
  if (!entry) {
    io.error(new UnsupportedPolicyFileError(policyFile).message);
    return 1;
  }

  // JSON reikšmė turi pirmenybę, o neparsinama lieka plika eilute: `--value true` yra
  // boolean, o `--value queue` — string, be atskiro tipo flag'o.
  let requestedValue: unknown;
  try {
    requestedValue = JSON.parse(rawValue);
  } catch {
    requestedValue = rawValue;
  }

  const current = (await entry.load(deps.ports.configFs, deps.runtimeRoot)) as Record<string, unknown>;
  try {
    entry.schema.parse({ ...current, [settingId]: requestedValue });
  } catch (error: unknown) {
    io.error(
      `Invalid value for ${settingId} in ${policyFile}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }

  // Routing tikrinamas ČIA, o ne paliekamas žurnalo schemai: klaidingas `--routing`
  // yra argumento klaida ir nusipelno savo žinutės, o ne zod stack trace'o.
  const routing = optionValue(args, "--routing") ?? "queue";
  if (!isPolicyRouting(routing)) {
    io.error(`Invalid routing '${routing}'; use ${POLICY_ROUTINGS.join(", ")}`);
    return 1;
  }

  const proposal: PolicyProposal = {
    policy_file: policyFile,
    setting_id: settingId,
    old_value: current[settingId] ?? null,
    requested_value: requestedValue,
    reason: optionValue(args, "--reason") ?? "not specified",
    timestamp: (deps.now?.() ?? new Date()).toISOString(),
    routing,
  };

  try {
    await appendPolicyProposal(deps.ports.proposalsFs, deps.runtimeRoot, proposal);
  } catch (error: unknown) {
    io.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  io.out(`Proposal saved: ${settingId} in ${policyFile} → ${routing}`);
  return 0;
}

async function showProposalStatus(deps: PolicyCommandDeps, args: string[], io: CliIo): Promise<number> {
  const jsonMode = args.includes("--json");
  const proposalsPath = path.join(policyProposalsDir(deps.runtimeRoot), "proposals.jsonl");
  const raw = await deps.ports.proposalsFs.readTextFileIfExists(proposalsPath);

  if (raw === undefined) {
    io.out(jsonMode ? "[]" : "No proposals found.");
    return 0;
  }

  const lines = raw.trim().split(/\r?\n/).filter(Boolean);
  if (!jsonMode) {
    for (const line of lines) io.out(line);
    return 0;
  }

  // Korumpuota eilutė neturi nutraukti viso `status` — praleidžiam ją, o ne metam:
  // būsenos peržiūra yra diagnostikos paviršius, o ne vartas.
  const proposals = lines.flatMap((line) => {
    try {
      return [JSON.parse(line) as unknown];
    } catch {
      return [];
    }
  });
  io.out(JSON.stringify(proposals, null, 2));
  return 0;
}
