import {
  createPushNotificationPayload,
  type PushNotificationEventType,
  type PushNotificationPort,
} from "./ports/push-notification-port.js";
import type { AgLoopTaskBucket } from "./ports/ag-loop-ui-read-port.js";
import type { TerminalSession, TerminalSessionState } from "../domain/terminal-session.js";

/**
 * The two AG Loop task buckets that are a terminal outcome. Every other
 * bucket name (`queue`, `active`, `delegated`, `human-review`, ...) is not a
 * `failed`/`completed` event by this contract's own vocabulary, so it stays a
 * silent no-op rather than growing an unbounded event surface no one asked
 * for.
 */
const BUCKET_OUTCOME: Readonly<Record<string, PushNotificationEventType>> = Object.freeze({
  done: "completed",
  failed: "failed",
});

/**
 * Terminal session states that are a lifecycle outcome. `orphaned` is
 * deliberately excluded — `terminal-session.ts` allows it to return to
 * `live`, so it is not yet a `failed`/`completed` event.
 */
const SESSION_STATE_OUTCOME: Readonly<Partial<Record<TerminalSessionState, PushNotificationEventType>>> =
  Object.freeze({
    ended: "completed",
    failed: "failed",
  });

/**
 * Composes push notifications from read-only AG Loop status and mobile
 * terminal lifecycle, and hands the closed, validated payload to the port.
 *
 * This service never reads terminal content, a host path or a credential —
 * its two inputs are already the read-only projections (`AgLoopTaskBucket`)
 * and the local domain model (`TerminalSession`) other application services
 * use, and `createPushNotificationPayload` is the last, structural check
 * before anything reaches the port.
 */
export class PushNotificationService {
  constructor(
    private readonly port: PushNotificationPort,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /**
   * Diffs two snapshots of the same AG Loop task bucket and emits one
   * notification per task id that is newly present. `previous` is `null` on
   * the first observation of a bucket, which emits nothing — there is no
   * "newly present" without a prior snapshot to compare against.
   */
  async observeAgLoopTaskBucket(
    previous: AgLoopTaskBucket | null,
    current: AgLoopTaskBucket,
  ): Promise<void> {
    const outcome = BUCKET_OUTCOME[current.bucket];
    if (!outcome || !previous) return;
    const previousTasks = new Set(previous.tasks);
    const occurredAt = this.clock().toISOString();
    for (const taskId of current.tasks) {
      if (previousTasks.has(taskId)) continue;
      await this.port.send(
        createPushNotificationPayload({
          type: outcome,
          source: "ag-loop-read",
          subjectId: taskId,
          occurredAt,
        }),
      );
    }
  }

  /**
   * Maps a mobile terminal session's current lifecycle state to a
   * notification. Any state without a terminal outcome (`creating`,
   * `starting`, `live`, `interrupting`, `closing`, `orphaned`) is a no-op.
   */
  async observeTerminalLifecycle(session: TerminalSession): Promise<void> {
    const outcome = SESSION_STATE_OUTCOME[session.state];
    if (!outcome) return;
    await this.port.send(
      createPushNotificationPayload({
        type: outcome,
        source: "mobile-terminal",
        subjectId: session.sessionId,
        occurredAt: this.clock().toISOString(),
      }),
    );
  }
}
