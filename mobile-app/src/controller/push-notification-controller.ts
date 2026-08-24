import type {
  PushNotificationDeliveryPort,
  PushNotificationUnsubscribe,
} from "../model/ports.js";
import type { PushNotificationInbox } from "./presentation/push-notification-presenter.js";
import type { PushNotificationViewState } from "../view/push-notification-view-state.js";

export type PushNotificationObserver = (notifications: readonly PushNotificationViewState[]) => void;

/**
 * Binds the platform's delivery port to the notification feed.
 *
 * Everything here is written to survive a platform that behaves badly: the
 * registration may throw, a callback may arrive after the subscription was
 * cancelled, and the shell's observer may itself fail. None of those may reach
 * the OS callback as an exception, because a throw on that boundary is a crash
 * of the app rather than a notification that was not shown.
 *
 * The concrete {@link PushNotificationDeliveryPort} is supplied by the
 * composition root, so this controller carries no transport or platform
 * knowledge, and the feed it publishes is read-only by construction: there is
 * no path from a notification back to an AG Loop or terminal mutation.
 */
export class PushNotificationController {
  private unsubscribe: PushNotificationUnsubscribe | null = null;
  /** Whether a delivery is still wanted; checked inside the platform callback. */
  private active = false;

  constructor(
    private readonly delivery: PushNotificationDeliveryPort,
    private readonly inbox: PushNotificationInbox,
    private readonly observe: PushNotificationObserver,
  ) {}

  /** Idempotent: a second start keeps the first subscription, never opens two. */
  start(): void {
    if (this.active) return;
    this.active = true;
    try {
      this.unsubscribe = this.delivery.subscribe((delivered) => {
        this.deliver(delivered);
      });
    } catch {
      // A platform that refuses to register leaves the controller stopped, so a
      // later start can try again and no observer is told about a feed that has
      // no source.
      this.active = false;
      this.unsubscribe = null;
    }
  }

  /** Idempotent, and safe after a start that never registered. */
  stop(): void {
    this.active = false;
    const cancel = this.unsubscribe;
    this.unsubscribe = null;
    if (cancel === null) return;
    try {
      cancel();
    } catch {
      // Cancelling twice, or after the platform already tore the subscription
      // down, is not a failure the operator can act on.
    }
  }

  /** Empties the feed and publishes it, so a cleared screen cannot show stale rows. */
  clear(): void {
    this.inbox.clear();
    this.publish();
  }

  private deliver(delivered: unknown): void {
    // A callback that was already in flight when `stop()` ran must publish
    // nothing: the operator has left this screen behind.
    if (!this.active) return;
    if (this.inbox.receive(delivered) === null) return;
    this.publish();
  }

  private publish(): void {
    try {
      this.observe(this.inbox.list());
    } catch {
      // A failing observer is the shell's problem, not the platform's: the
      // notification stays in the inbox and the next publish shows it.
    }
  }
}
