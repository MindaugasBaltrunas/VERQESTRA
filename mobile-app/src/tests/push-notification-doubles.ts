import assert from "node:assert/strict";
import { parsePushNotification } from "../adapters/push-notification-adapter.js";
import { presentPushNotification } from "../controller/presentation/push-notification-presenter.js";
import type {
  PushNotificationDeliveryPort,
  PushNotificationUnsubscribe,
} from "../model/ports.js";
import type { PushNotificationViewState } from "../view/push-notification-view-state.js";

/**
 * Shared doubles for the push-notification suites.
 *
 * SKAIDYMAS (VERQESTRA ≤500 eil. vartas; etalone `push-notification-adapter.test.ts` buvo 645
 * eilučių). `delivery()` čia yra vienintelis apibrėžimas, kaip atrodo PRIIMTINAS pristatymas —
 * visi atmetimo atvejai keičia jame po vieną lauką. Dvi kopijos leistų vienai nutolti, ir
 * dalis „atmesta dėl X" testų atmestų dėl Y.
 */

export type Delivery = Record<string, unknown>;

export function delivery(overrides: Delivery = {}): Delivery {
  return {
    type: "failed",
    source: "ag-loop-read",
    subjectId: "1155",
    occurredAt: "2026-08-11T09:30:00Z",
    ...overrides,
  };
}

/** Models the OS push channel: it hands over listeners and cancels them. */
export class FakeDeliveryPort implements PushNotificationDeliveryPort {
  readonly listeners: ((delivered: unknown) => void)[] = [];
  subscribeCalls = 0;
  unsubscribeCalls = 0;
  /** A platform that refuses to register at all — no permission, no token. */
  subscribeFails = false;
  /** A platform that fails while tearing the subscription down. */
  unsubscribeFails = false;

  subscribe(listener: (delivered: unknown) => void): PushNotificationUnsubscribe {
    this.subscribeCalls += 1;
    if (this.subscribeFails) throw new Error("push registration refused");
    this.listeners.push(listener);
    return () => {
      this.unsubscribeCalls += 1;
      if (this.unsubscribeFails) throw new Error("push teardown failed");
    };
  }

  /** Delivers to every listener, including ones the controller has cancelled. */
  deliver(payload: unknown): void {
    for (const listener of this.listeners) listener(payload);
  }
}

export function accepted(overrides: Delivery = {}): PushNotificationViewState {
  const payload = parsePushNotification(delivery(overrides));
  if (payload === null) assert.fail(`a well-formed delivery was refused: ${JSON.stringify(overrides)}`);
  return presentPushNotification(payload);
}

/**
 * Deliveries that fail while they are being inspected. The platform hands over an
 * object, not JSON: a native shell is free to make its properties lazy, and a
 * hostile one can make reading them fail. Shared because both suites have to
 * answer for the same delivery — the parser with `null`, the feed with silence.
 */
export function unreadableDeliveries(): unknown[] {
  return [
    {
      get type(): string {
        throw new Error("payload read failed");
      },
      source: "ag-loop-read",
      subjectId: "1155",
      occurredAt: "2026-08-11T09:30:00Z",
    },
    new Proxy({}, {
      ownKeys(): string[] {
        throw new Error("enumeration refused");
      },
    }),
  ];
}
