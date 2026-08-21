// `optimization-benchmark` CLI adapteris (etalonas: interfaces/cli/optimization-benchmark/
// index.ts). TIK argumentų parsinimas ir exit kodų žemėlapis; kiekviena metrikos taisyklė
// gyvena domain/metrics, o kiekvienas IO žingsnis — application/benchmark. Domain čia
// neimportuojamas: application use-case'as re-eksportuoja tai, ką adapteriui leista matyti.
//
// VERQESTRA skirtumas nuo etalono: failų sistema ateina per `BenchmarkCaptureFsPort`, o keliai
// skaičiuojami nuo vq runtime šaknies (`benchmarkPaths(runtimeRoot)`), ne nuo projekto šaknies.

import {
  benchmarkPaths,
  captureBenchmarkReport,
  compareWithBaseline,
  loadOptimizationBenchmarkConfig,
  renderBenchmarkReportText,
  renderComparisonText,
  writeBenchmarkBaseline,
  writeBenchmarkComparison,
  type BenchmarkCaptureFsPort,
  type CaptureBenchmarkOptions,
} from "../../../application/benchmark/index.js";
import { consoleCliIo, type CliIo } from "../registry.js";

export type OptimizationBenchmarkMode = "report" | "baseline" | "compare-baseline" | "print-hash";

export type OptimizationBenchmarkArgs = {
  mode: OptimizationBenchmarkMode;
  json: boolean;
  configPath?: string;
  usageLogPath?: string;
  eventsLogPath?: string;
  baselinePath?: string;
  outPath?: string;
};

const MODE_FLAGS: Record<string, OptimizationBenchmarkMode> = {
  "--baseline": "baseline",
  "--compare-baseline": "compare-baseline",
  "--print-hash": "print-hash",
};

const VALUE_FLAGS = {
  "--config": "configPath",
  "--usage-log": "usageLogPath",
  "--events-log": "eventsLogPath",
  "--baseline-report": "baselinePath",
  "--out": "outPath",
} as const satisfies Record<string, keyof OptimizationBenchmarkArgs>;

export function parseOptimizationBenchmarkArgs(args: string[]): OptimizationBenchmarkArgs {
  const parsed: OptimizationBenchmarkArgs = { mode: "report", json: false };
  let modeSelected = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";

    if (arg === "--json") {
      parsed.json = true;
      continue;
    }

    const mode = MODE_FLAGS[arg];
    if (mode) {
      if (modeSelected) {
        throw new Error("optimization-benchmark: --baseline, --compare-baseline and --print-hash are mutually exclusive");
      }
      parsed.mode = mode;
      modeSelected = true;
      continue;
    }

    const valueFlag = Object.keys(VALUE_FLAGS).find((flag) => arg === flag || arg.startsWith(`${flag}=`)) as
      | keyof typeof VALUE_FLAGS
      | undefined;
    if (valueFlag) {
      let value: string | undefined;
      if (arg === valueFlag) {
        const next = args[index + 1];
        value = next === undefined || next.startsWith("--") ? undefined : next;
        if (value !== undefined) index += 1;
      } else {
        value = arg.slice(valueFlag.length + 1);
      }
      if (!value) {
        throw new Error(`optimization-benchmark: ${valueFlag} requires a value`);
      }
      parsed[VALUE_FLAGS[valueFlag]] = value;
      continue;
    }

    throw new Error(`Unknown optimization-benchmark argument: ${arg}`);
  }

  return parsed;
}

export type OptimizationBenchmarkDeps = {
  fs: BenchmarkCaptureFsPort;
  /** vq runtime šaknis (`<root>/vq`) — konfigo, žurnalų ir baseline keliai. */
  runtimeRoot: string;
  /** Fiksuotas laikas raporto antspaudui (testams); numatytai — realus laikrodis. */
  now?: Date;
  io?: CliIo;
};

export async function optimizationBenchmarkCommand(
  deps: OptimizationBenchmarkDeps,
  args: string[] = [],
): Promise<number> {
  const io = deps.io ?? consoleCliIo;
  try {
    const parsed = parseOptimizationBenchmarkArgs(args);
    const defaults = benchmarkPaths(deps.runtimeRoot);
    const captureOptions: CaptureBenchmarkOptions = {
      runtimeRoot: deps.runtimeRoot,
      ...(parsed.configPath === undefined ? {} : { configPath: parsed.configPath }),
      ...(parsed.usageLogPath === undefined ? {} : { usageLogPath: parsed.usageLogPath }),
      ...(parsed.eventsLogPath === undefined ? {} : { eventsLogPath: parsed.eventsLogPath }),
      ...(deps.now === undefined ? {} : { now: deps.now }),
    };

    if (parsed.mode === "print-hash") {
      const configPath = parsed.configPath ?? defaults.configPath;
      const { config, hash } = await loadOptimizationBenchmarkConfig(deps.fs, configPath);
      io.out(
        parsed.json
          ? JSON.stringify(
              { config_path: configPath, config_version: config.version, frozen_at: config.frozen_at, config_hash: hash },
              null,
              2,
            )
          : `${hash}\nconfig: ${configPath} (version ${config.version}, frozen ${config.frozen_at})`,
      );
      return 0;
    }

    if (parsed.mode === "compare-baseline") {
      const comparison = await compareWithBaseline(deps.fs, {
        ...captureOptions,
        ...(parsed.baselinePath === undefined ? {} : { baselinePath: parsed.baselinePath }),
      });
      const written = parsed.outPath ? await writeBenchmarkComparison(deps.fs, comparison, parsed.outPath) : undefined;
      if (parsed.json) {
        io.out(JSON.stringify(comparison, null, 2));
      } else {
        io.out(renderComparisonText(comparison));
        if (written) io.out(`Comparison written: ${written}`);
      }
      return comparison.success_declaration.allowed ? 0 : 1;
    }

    const report = await captureBenchmarkReport(deps.fs, captureOptions);
    const written =
      parsed.mode === "baseline"
        ? await writeBenchmarkBaseline(deps.fs, report, parsed.outPath ?? defaults.baselinePath)
        : undefined;
    if (parsed.json) {
      io.out(JSON.stringify(report, null, 2));
    } else {
      io.out(renderBenchmarkReportText(report));
      if (written) io.out(`Baseline written: ${written}`);
    }
    return report.tokens_per_verified_accepted_change.status === "computed" && report.integrity.ok ? 0 : 1;
  } catch (error: unknown) {
    io.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}
