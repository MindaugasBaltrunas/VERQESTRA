import { pathToFileURL } from "node:url";

import {
  renderOfflineSmokeReport,
  runOfflineSmoke,
  type RunOfflineSmokeOptions,
} from "./offline-smoke.js";

/**
 * `pnpm --dir AG/benchmark benchmark:smoke` (BENCH-12).
 *
 * The pull-request gate: it exits non-zero when an invocation answered something
 * other than the contract says it must, and it never reaches a paid model. The
 * exit code is deliberately a plain 1 rather than one of the benchmark's own
 * codes — this is a harness self-check, not a measurement, and nothing about the
 * measured system may be concluded from it.
 */

export interface OfflineSmokeCliOptions extends RunOfflineSmokeOptions {
  readonly out?: (line: string) => void;
}

export async function runOfflineSmokeCli(options: OfflineSmokeCliOptions = {}): Promise<number> {
  const out = options.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const report = await runOfflineSmoke(options);
  for (const line of renderOfflineSmokeReport(report)) out(line);
  return report.passed ? 0 : 1;
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && pathToFileURL(entry).href === import.meta.url;
}

if (invokedDirectly()) {
  runOfflineSmokeCli()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
