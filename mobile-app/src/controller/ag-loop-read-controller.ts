import { AgLoopReadError } from "../model/ag-loop-read.js";
import type {
  AgLoopReadFailureCode,
  AgLoopTaskBucket,
  AgLoopUiReadPort,
} from "../model/ag-loop-read.js";
import type { AppEvent } from "../model/reducer.js";

function failureCode(error: unknown): AgLoopReadFailureCode {
  return error instanceof AgLoopReadError ? error.code : "transport_failed";
}

/**
 * Drives the read-only AG Loop channel: it turns port results and port failures
 * into Model events and never throws at its caller, because a failed background
 * read is a screen state (`degraded` / `offline`), not a command failure.
 *
 * The concrete {@link AgLoopUiReadPort} implementation is supplied by the
 * composition root, so this controller carries no transport knowledge and the
 * mobile client keeps no path of its own to the AG Loop UI.
 */
export class AgLoopReadController {
  constructor(
    private readonly reads: AgLoopUiReadPort,
    private readonly dispatch: (event: AppEvent) => void,
  ) {}

  /** Refreshes the dashboard and, when AG Loop is online, the selected bucket. */
  async refresh(input: Readonly<{ projectId: string; bucket: AgLoopTaskBucket }>): Promise<void> {
    this.dispatch({ type: "ag-loop.read-started" });
    try {
      const dashboard = await this.reads.readDashboard({ projectId: input.projectId });
      this.dispatch({ type: "ag-loop.dashboard", snapshot: dashboard });
      // An offline AG Loop UI has no buckets to serve; asking anyway would turn
      // a known-offline state into a second, misleading transport failure.
      if (dashboard.availability === "online") {
        const bucket = await this.reads.readTaskBucket({
          projectId: input.projectId,
          bucket: input.bucket,
        });
        this.dispatch({ type: "ag-loop.tasks", snapshot: bucket });
      }
    } catch (error) {
      this.dispatch({ type: "ag-loop.read-failed", failure: failureCode(error) });
    } finally {
      this.dispatch({ type: "ag-loop.read-settled" });
    }
  }

  /** Selects a bucket and reads it; the dashboard projection is left untouched. */
  async selectBucket(input: Readonly<{ projectId: string; bucket: AgLoopTaskBucket }>): Promise<void> {
    this.dispatch({ type: "ag-loop.bucket-selected", bucket: input.bucket });
    this.dispatch({ type: "ag-loop.read-started" });
    try {
      const bucket = await this.reads.readTaskBucket({
        projectId: input.projectId,
        bucket: input.bucket,
      });
      this.dispatch({ type: "ag-loop.tasks", snapshot: bucket });
    } catch (error) {
      this.dispatch({ type: "ag-loop.read-failed", failure: failureCode(error) });
    } finally {
      this.dispatch({ type: "ag-loop.read-settled" });
    }
  }
}
