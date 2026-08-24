import { SessionReviewReadError } from "../model/session-review-read.js";
import type {
  SessionReviewFailureCode,
  SessionReviewReadPort,
} from "../model/session-review-read.js";
import type { AppEvent } from "../model/reducer.js";

function failureCode(error: unknown): SessionReviewFailureCode {
  return error instanceof SessionReviewReadError ? error.code : "transport_failed";
}

/**
 * Drives the read-only session review channel: it turns port results and port
 * failures into Model events and never rejects at its caller, because a failed
 * background read is a screen state (`degraded` / `offline`), not a command
 * failure.
 *
 * The concrete {@link SessionReviewReadPort} implementation is supplied by the
 * composition root, so this controller carries no transport knowledge and the
 * mobile client keeps no path of its own to the reviewed repository.
 */
export class SessionReviewController {
  constructor(
    private readonly reads: SessionReviewReadPort,
    private readonly dispatch: (event: AppEvent) => void,
  ) {}

  /** Selects a session and reads its review; the previous review is dropped first. */
  async open(input: Readonly<{ projectId: string; sessionId: string }>): Promise<void> {
    this.dispatch({ type: "session-review.selected", sessionId: input.sessionId });
    await this.read(input);
  }

  /**
   * Re-reads the selected session. It deliberately dispatches no selection: a
   * refresh must not clear the very pane it is refreshing.
   */
  async refresh(input: Readonly<{ projectId: string; sessionId: string }>): Promise<void> {
    await this.read(input);
  }

  private async read(input: Readonly<{ projectId: string; sessionId: string }>): Promise<void> {
    this.dispatch({ type: "session-review.read-started" });
    try {
      const snapshot = await this.reads.readSessionReview(input);
      this.dispatch({ type: "session-review.snapshot", snapshot });
    } catch (error) {
      this.dispatch({ type: "session-review.read-failed", failure: failureCode(error) });
    } finally {
      this.dispatch({ type: "session-review.read-settled" });
    }
  }
}
