// `benchmark-drive` CLI adapteris (etalonas: interfaces/cli/benchmark-drive/index.ts):
// ribotas, vieno scenarijaus ag-loop ciklas, kurį benchmark paketo „ag-loop" vykdymo režimas
// varo kaip procesą. Ši komanda NEGALI importuoti benchmark paketo (BENCH-1: vidinis modulis
// nėra public API), tad spausdinamas telemetrijos envelope yra antras, nepriklausomas TO PATIES
// dokumentuoto ag-loop/2 kontrakto rašytojas, ne bendras importas.
//
// VERQESTRA skirtumas nuo etalono: vienintelis Claude kvietimas, laikinas runtime katalogas ir
// darbinio katalogo peradresavimas gyvena UŽ interfaces ribų — `runHeadless` portas gauna
// `cwd` ir `timeoutMs` ir pats atsako, kad prompt'o tmp failas gimtų NE `--workdir` viduje
// (kitaip jis atsirastų matuojamo scenarijaus diff'e ir būtų neatskiriamas nuo agento darbo).

import path from "node:path";
import { USAGE_ERROR_EXIT_CODE, USAGE_LIMIT_EXIT_CODE } from "../../../shared/exit-codes.js";
import { consoleCliIo, type CliIo } from "../registry.js";

/**
 * `ag-loop` režimo telemetrijos kontraktas (benchmark paketo ag-loop-execution-adapter
 * AG_LOOP_ADAPTER_VERSION / TELEMETRY_ENVELOPE_KEY). Dubliuojama literalu, o ne importuojama:
 * dvi kopijos yra du dokumentuoto kontrakto galai, ne viena bendra konstanta, į kurią šiam
 * paketui leista siekti.
 */
const TELEMETRY_ENVELOPE_KEY = "agBenchmarkTelemetry";
const TELEMETRY_ENVELOPE_VERSION = 2;

const REQUIRED_FLAGS = ["workdir", "model", "step-limit", "timeout-ms"] as const;

const USAGE =
  "Usage: verqestra benchmark-drive [--prompt-file <f>] --workdir <d> --model <m> --step-limit <n> --timeout-ms <n>\n" +
  "  Be --prompt-file promptas skaitomas iš stdin iki EOF.";

export type ParsedBenchmarkDriveArgs = {
  /** Nėra, kai promptas skaitomas iš stdin. */
  readonly promptFile: string | undefined;
  readonly workdir: string;
  readonly model: string;
  readonly stepLimit: number;
  readonly timeoutMs: number;
};

export type BenchmarkDriveArgsResult =
  | { readonly kind: "ok"; readonly args: ParsedBenchmarkDriveArgs }
  | { readonly kind: "error"; readonly message: string };

function parsePositiveInt(raw: string, flag: string): number | string {
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value <= 0 || String(value) !== raw.trim()) {
    return `--${flag} must be a positive integer, got "${raw}"`;
  }
  return value;
}

/** Grynas argv parse — testuojamas be failų sistemos ir be proceso. */
export function parseBenchmarkDriveArgs(args: readonly string[]): BenchmarkDriveArgsResult {
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i] ?? "";
    if (!token.startsWith("--")) {
      return { kind: "error", message: `${USAGE}\nUnexpected argument: ${token}` };
    }
    const name = token.slice(2);
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--")) {
      return { kind: "error", message: `${USAGE}\nMissing value for --${name}` };
    }
    flags.set(name, value);
    i += 1;
  }

  const missing = REQUIRED_FLAGS.filter((name) => !flags.has(name));
  if (missing.length > 0) {
    return {
      kind: "error",
      message: `${USAGE}\nMissing required flag(s): ${missing.map((name) => `--${name}`).join(", ")}`,
    };
  }

  const model = (flags.get("model") ?? "").trim();
  const workdir = (flags.get("workdir") ?? "").trim();
  if (model === "" || workdir === "") {
    return { kind: "error", message: `${USAGE}\n--workdir and --model must not be empty` };
  }

  let promptFile: string | undefined;
  if (flags.has("prompt-file")) {
    promptFile = (flags.get("prompt-file") ?? "").trim();
    if (promptFile === "") {
      return { kind: "error", message: `${USAGE}\n--prompt-file must not be empty` };
    }
  }

  const stepLimit = parsePositiveInt(flags.get("step-limit") ?? "", "step-limit");
  if (typeof stepLimit === "string") return { kind: "error", message: stepLimit };
  const timeoutMs = parsePositiveInt(flags.get("timeout-ms") ?? "", "timeout-ms");
  if (typeof timeoutMs === "string") return { kind: "error", message: timeoutMs };

  return { kind: "ok", args: { promptFile, workdir, model, stepLimit, timeoutMs } };
}

/** Struktūrinis usage vaizdas — infrastruktūros `ClaudeUsage` jį tenkina, importo nėra. */
export type BenchmarkDriveUsageView = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  num_turns?: number;
};

export type BenchmarkDriveRunResult = { stdout: string; stderr: string; code: number };

export type BenchmarkDriveHeadlessInput = {
  prompt: string;
  model: string;
  /** Katalogas, kuriame agentas dirba (`--workdir`). */
  cwd: string;
  timeoutMs: number;
  maxTurns: number;
};

export type BenchmarkDrivePorts = {
  /** true tik egzistuojančiam KATALOGUI (etalono `stat().isDirectory()`). */
  isDirectory(absolutePath: string): Promise<boolean>;
  /** Prompt failo turinys; meta klaidą, kai failas neįskaitomas. */
  readTextFile(absolutePath: string): Promise<string>;
  /** Standartinė įvestis iki EOF. */
  readStdin(): Promise<string>;
  /**
   * Vienas ribotas headless `claude` kvietimas. Laikino state katalogo kūrimas ir valymas bei
   * darbinio katalogo peradresavimas — adapterio atsakomybė (žr. modulio antraštę).
   */
  runHeadless(input: BenchmarkDriveHeadlessInput): Promise<BenchmarkDriveRunResult>;
  /** 429 / sesijos limito klasifikacija pagal vaiko stdout. */
  isUsageLimitOutput(stdout: string): boolean;
  extractUsage(stdout: string): BenchmarkDriveUsageView | undefined;
};

export type BenchmarkDriveDeps = {
  ports: BenchmarkDrivePorts;
  io?: CliIo;
};

function usageBlock(usage: BenchmarkDriveUsageView | undefined): Record<string, unknown> {
  if (usage === undefined) return { captured: false };
  const block: Record<string, unknown> = { captured: true };
  if (usage.cache_read_input_tokens !== undefined) block["cacheReadInputTokens"] = usage.cache_read_input_tokens;
  if (usage.cache_creation_input_tokens !== undefined) {
    block["cacheCreationInputTokens"] = usage.cache_creation_input_tokens;
  }
  if (usage.num_turns !== undefined) {
    block["numTurns"] = usage.num_turns;
    block["turnsSource"] = "recorded";
  }
  return block;
}

function nonNegativeInt(value: number | undefined): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

async function resolvePrompt(
  ports: BenchmarkDrivePorts,
  promptFile: string | undefined,
): Promise<{ kind: "ok"; text: string } | { kind: "error"; message: string }> {
  if (promptFile === undefined) {
    const text = await ports.readStdin();
    if (text.trim() === "") return { kind: "error", message: `${USAGE}\nstdin prompt is empty` };
    return { kind: "ok", text };
  }

  const promptFileAbs = path.resolve(promptFile);
  let text: string;
  try {
    text = await ports.readTextFile(promptFileAbs);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return { kind: "error", message: `Cannot read --prompt-file ${promptFileAbs}: ${detail}` };
  }
  if (text.trim() === "") return { kind: "error", message: `--prompt-file is empty: ${promptFileAbs}` };
  return { kind: "ok", text };
}

export async function benchmarkDriveCommand(deps: BenchmarkDriveDeps, args: readonly string[]): Promise<number> {
  const io = deps.io ?? consoleCliIo;
  const parsed = parseBenchmarkDriveArgs(args);
  if (parsed.kind === "error") {
    io.error(parsed.message);
    return USAGE_ERROR_EXIT_CODE;
  }
  const { promptFile, workdir, model, stepLimit, timeoutMs } = parsed.args;

  const workdirAbs = path.resolve(workdir);
  if (!(await deps.ports.isDirectory(workdirAbs))) {
    io.error(`--workdir is not an existing directory: ${workdirAbs}`);
    return USAGE_ERROR_EXIT_CODE;
  }

  const prompt = await resolvePrompt(deps.ports, promptFile);
  if (prompt.kind === "error") {
    io.error(prompt.message);
    return USAGE_ERROR_EXIT_CODE;
  }

  const result = await deps.ports.runHeadless({
    prompt: prompt.text,
    model,
    cwd: workdirAbs,
    timeoutMs,
    maxTurns: stepLimit,
  });

  if (deps.ports.isUsageLimitOutput(result.stdout)) {
    io.error("verqestra benchmark-drive: Claude API usage limit reached — no telemetry envelope produced.");
    return USAGE_LIMIT_EXIT_CODE;
  }
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim().slice(0, 2000);
    io.error(`verqestra benchmark-drive: claude exited ${result.code}${detail ? `: ${detail}` : ""}`);
    // Grąžinamas paties vaiko kodas, ne fiksuotas: kvietėjui, skiriančiam timeout nuo crash'o,
    // reikia to kodo, kurį vaikas realiai pranešė.
    return result.code;
  }

  let outer: Record<string, unknown> = {};
  try {
    outer = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
  } catch {
    outer = {};
  }
  const usage = deps.ports.extractUsage(result.stdout);
  const envelope: Record<string, unknown> = {
    [TELEMETRY_ENVELOPE_KEY]: TELEMETRY_ENVELOPE_VERSION,
    model,
    inputTokens: nonNegativeInt(usage?.input_tokens),
    outputTokens: nonNegativeInt(usage?.output_tokens),
    // Vienas `runHeadless` kvietimas yra visas šis ribotas ciklas: lygiai vienas LLM kvietimas,
    // vienas bandymas ir (vienas ciklas, be diagnose/repair) nulis remontų — būtent tai ir
    // laiko `repairs < attempts` besąlygiškai teisingą, vieną iš dviejų invariantų, kuriuos
    // `verifyLoopTelemetry` tikrina skaitydamas atgal.
    llmCalls: 1,
    attempts: 1,
    repairs: 0,
    humanReviewEvents: 0,
    claimedDone: outer["is_error"] !== true,
    usage: usageBlock(usage),
  };
  io.out(JSON.stringify(envelope));
  return 0;
}
