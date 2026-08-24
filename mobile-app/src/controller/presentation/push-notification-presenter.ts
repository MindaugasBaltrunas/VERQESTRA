import { parsePushNotification } from "../../adapters/push-notification-adapter.js";
import type {
  PushNotificationEventType,
  PushNotificationPayload,
  PushNotificationSource,
} from "../../model/ports.js";
import type {
  PushNotificationSeverity,
  PushNotificationViewState,
} from "../../view/push-notification-view-state.js";

/**
 * Projection and in-app feed for accepted push notifications.
 *
 * SKAIDYMAS (MVA → MVC): etalone tai gyveno kartu su parseriu
 * `adapters/push-notification-adapter.ts`. Parseris yra pasitikėjimo riba ir liko adapteryje;
 * tai, kas iš patvirtinto pranešimo padaro ekrano eilutę ir laiko jų pluoštą, MVC kalba yra
 * kontroleris. Elgesys nepakito nė vienu lauku.
 */

const titles: Readonly<Record<PushNotificationSource, Readonly<Record<PushNotificationEventType, string>>>> =
  Object.freeze({
    "ag-loop-read": Object.freeze({
      failed: "AG Loop task failed",
      completed: "AG Loop task completed",
    }),
    "mobile-terminal": Object.freeze({
      failed: "Terminal session failed",
      completed: "Terminal session completed",
    }),
  });

const subjectLabels: Readonly<Record<PushNotificationSource, string>> = Object.freeze({
  "ag-loop-read": "AG Loop task",
  "mobile-terminal": "Terminal session",
});

const severities: Readonly<Record<PushNotificationEventType, PushNotificationSeverity>> = Object.freeze({
  failed: "failure",
  completed: "completion",
});

export function presentPushNotification(payload: PushNotificationPayload): PushNotificationViewState {
  const title = titles[payload.source][payload.type];
  return Object.freeze({
    readOnly: true,
    severity: severities[payload.type],
    title,
    subjectLabel: subjectLabels[payload.source],
    subjectId: payload.subjectId,
    occurredAtLabel: payload.occurredAt,
    accessibilityLabel: `${title}, ${payload.subjectId}`,
  });
}

/** How many notifications the feed keeps; the rest are the OS tray's business. */
export const maxRetainedPushNotifications = 20;

type RetainedNotification = Readonly<{ key: string; view: PushNotificationViewState }>;

function identity(payload: PushNotificationPayload): string {
  return `${payload.type}|${payload.source}|${payload.subjectId}|${payload.occurredAt}`;
}

/**
 * The in-app feed of accepted notifications, newest first.
 *
 * Order is arrival order, not `occurredAt`: a device clock and a host clock
 * disagree often enough that sorting by the reported instant would reorder the
 * feed under the operator, and this class reads no clock of its own.
 *
 * The same event delivered twice — a retry, or a tap on a tray entry the OS
 * replays — is retained once. The check is a scan of the retained window, so
 * deduplication holds only for as long as an event is still retained; a
 * duplicate arriving after its original was pushed out is a new entry, which is
 * the honest answer for a feed that is bounded by design.
 */
export class PushNotificationInbox {
  private readonly capacity: number;
  private readonly retained: RetainedNotification[] = [];

  constructor(capacity: number = maxRetainedPushNotifications) {
    // A fractional or non-positive bound would silently disable retention.
    this.capacity = Number.isSafeInteger(capacity) && capacity > 0
      ? capacity
      : maxRetainedPushNotifications;
  }

  /**
   * Accepts one delivery. Answers `null` for a rejected payload, and the
   * retained view for a duplicate: the delivery was valid, it simply adds
   * nothing to the feed.
   */
  receive(delivered: unknown): PushNotificationViewState | null {
    const payload = parsePushNotification(delivered);
    if (payload === null) return null;
    const key = identity(payload);
    const known = this.retained.find((entry) => entry.key === key);
    if (known !== undefined) return known.view;
    const view = presentPushNotification(payload);
    this.retained.unshift({ key, view });
    if (this.retained.length > this.capacity) this.retained.length = this.capacity;
    return view;
  }

  /** A frozen copy: a screen cannot edit the feed by editing what it rendered. */
  list(): readonly PushNotificationViewState[] {
    return Object.freeze(this.retained.map((entry) => entry.view));
  }

  clear(): void {
    this.retained.length = 0;
  }
}
