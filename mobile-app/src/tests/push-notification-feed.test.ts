import assert from "node:assert/strict";
import test from "node:test";
import { parsePushNotification } from "../adapters/push-notification-adapter.js";
import {
  PushNotificationInbox,
  maxRetainedPushNotifications,
} from "../controller/presentation/push-notification-presenter.js";
import { PushNotificationController } from "../controller/push-notification-controller.js";
import type { PushNotificationViewState } from "../view/push-notification-view-state.js";
import { accepted, delivery, FakeDeliveryPort, unreadableDeliveries } from "./push-notification-doubles.js";

/**
 * SKAIDYMAS (VERQESTRA ≤500 eil. vartas; žr. `push-notification-doubles.ts`). Čia — PRESENTERIS
 * ir PLUOŠTAS: kokiais žodžiais įvykis pasirodo ekrane, kas lieka atmintyje ir kas atsitinka,
 * kai platforma elgiasi blogai. Ką parseris apskritai priima — `push-notification-adapter.test.ts`;
 * `occurredAt` kalendorius — `push-notification-payload.test.ts`.
 */

test("every event a notification may report has its own fixed wording", () => {
  const cases = [
    {
      source: "ag-loop-read",
      type: "failed",
      title: "AG Loop task failed",
      severity: "failure",
      subjectLabel: "AG Loop task",
    },
    {
      source: "ag-loop-read",
      type: "completed",
      title: "AG Loop task completed",
      severity: "completion",
      subjectLabel: "AG Loop task",
    },
    {
      source: "mobile-terminal",
      type: "failed",
      title: "Terminal session failed",
      severity: "failure",
      subjectLabel: "Terminal session",
    },
    {
      source: "mobile-terminal",
      type: "completed",
      title: "Terminal session completed",
      severity: "completion",
      subjectLabel: "Terminal session",
    },
  ] as const;

  for (const expected of cases) {
    const view = accepted({
      source: expected.source,
      type: expected.type,
      subjectId: "task-0042",
      occurredAt: "2026-08-11T09:30:00.250Z",
    });
    assert.equal(view.title, expected.title);
    assert.equal(view.severity, expected.severity);
    assert.equal(view.subjectLabel, expected.subjectLabel);
    // Structural, not a flag: there is no field a screen could read as an action.
    assert.equal(view.readOnly, true);
    assert.deepEqual(Object.keys(view).filter((key) => /action|command|url|deep|link/i.test(key)), []);
    assert.equal(view.subjectId, "task-0042");
    // Delivered instant, unrounded and unformatted: the shell localises it.
    assert.equal(view.occurredAtLabel, "2026-08-11T09:30:00.250Z");
    assert.equal(view.accessibilityLabel, `${expected.title}, task-0042`);
    assert.equal(Object.isFrozen(view), true);
  }
});

test("an unreadable delivery reaches neither the feed nor the screen", () => {
  const deliveries = unreadableDeliveries();
  for (const delivered of deliveries) {
    assert.equal(new PushNotificationInbox().receive(delivered), null);
  }

  const port = new FakeDeliveryPort();
  const inbox = new PushNotificationInbox();
  const published: (readonly PushNotificationViewState[])[] = [];
  const controller = new PushNotificationController(port, inbox, (feed) => {
    published.push(feed);
  });
  controller.start();
  for (const delivered of deliveries) {
    assert.doesNotThrow(() => {
      port.deliver(delivered);
    });
  }
  assert.equal(published.length, 0, "an unreadable delivery reached the screen");
  assert.deepEqual(inbox.list(), []);
  controller.stop();
});

test("the feed keeps the newest notifications, bounded, and hands out a copy", () => {
  const inbox = new PushNotificationInbox(3);
  for (const subjectId of ["one", "two", "three", "four", "five"]) {
    assert.notEqual(inbox.receive(delivery({ subjectId })), null, subjectId);
  }

  const feed = inbox.list();
  assert.deepEqual(feed.map((view) => view.subjectId), ["five", "four", "three"]);
  assert.equal(Object.isFrozen(feed), true);
  assert.throws(() => (feed as PushNotificationViewState[]).push(...feed.slice(0, 1)));
  assert.equal(inbox.list().length, 3);

  inbox.clear();
  assert.deepEqual(inbox.list(), []);

  // The default bound is the published one, so a shell that supplies no
  // capacity retains exactly what the adapter documents.
  const standard = new PushNotificationInbox();
  for (let index = 0; index < maxRetainedPushNotifications + 5; index += 1) {
    standard.receive(delivery({ subjectId: `task-${index}` }));
  }
  assert.equal(standard.list().length, maxRetainedPushNotifications);
  assert.equal(standard.list()[0]?.subjectId, `task-${maxRetainedPushNotifications + 4}`);
});

test("the same event delivered twice is retained once", () => {
  const inbox = new PushNotificationInbox();
  const first = inbox.receive(delivery());
  const again = inbox.receive(delivery());
  assert.notEqual(first, null);
  // A duplicate is valid, so it answers with the retained view rather than the
  // `null` that means "this delivery was refused".
  assert.deepEqual(again, first);
  assert.equal(inbox.list().length, 1);

  // Anything the identity is made of makes it a different event.
  inbox.receive(delivery({ type: "completed" }));
  inbox.receive(delivery({ source: "mobile-terminal" }));
  inbox.receive(delivery({ subjectId: "1156" }));
  inbox.receive(delivery({ occurredAt: "2026-08-11T09:30:01Z" }));
  assert.equal(inbox.list().length, 5);
});

test("a refused delivery answers null and leaves the feed untouched", () => {
  const inbox = new PushNotificationInbox();
  assert.notEqual(inbox.receive(delivery()), null);
  const before = inbox.list();

  for (const malformed of [null, "failed", delivery({ title: "leak" }), delivery({ subjectId: "../etc" })]) {
    assert.equal(inbox.receive(malformed), null);
  }
  assert.deepEqual(inbox.list(), before);
});

test("the controller subscribes once, publishes accepted notifications and detaches", () => {
  const port = new FakeDeliveryPort();
  const inbox = new PushNotificationInbox();
  const published: (readonly PushNotificationViewState[])[] = [];
  const controller = new PushNotificationController(port, inbox, (feed) => {
    published.push(feed);
  });

  controller.start();
  controller.start();
  assert.equal(port.subscribeCalls, 1);
  assert.equal(port.listeners.length, 1);
  assert.equal(published.length, 0);

  port.deliver(delivery({ subjectId: "rejected/../path" }));
  assert.equal(published.length, 0, "a refused delivery must not reach the screen");

  port.deliver(delivery({ subjectId: "1155" }));
  assert.equal(published.length, 1);
  assert.deepEqual(published[0]?.map((view) => view.subjectId), ["1155"]);

  controller.stop();
  controller.stop();
  assert.equal(port.unsubscribeCalls, 1);

  // A callback the platform had already queued when the operator left.
  port.deliver(delivery({ subjectId: "1156" }));
  assert.equal(published.length, 1, "a late callback published after stop()");
  assert.deepEqual(inbox.list().map((view) => view.subjectId), ["1155"]);

  controller.clear();
  assert.deepEqual(published.at(-1), []);
  assert.deepEqual(inbox.list(), []);
});

test("a platform that refuses to register leaves a controller that still stops", () => {
  const port = new FakeDeliveryPort();
  port.subscribeFails = true;
  port.unsubscribeFails = true;
  const published: (readonly PushNotificationViewState[])[] = [];
  const controller = new PushNotificationController(port, new PushNotificationInbox(), (feed) => {
    published.push(feed);
  });

  assert.doesNotThrow(() => {
    controller.start();
  });
  assert.equal(published.length, 0, "a controller with no source told the screen something");
  assert.doesNotThrow(() => {
    controller.stop();
  });
  assert.equal(port.unsubscribeCalls, 0);

  // The refusal is not terminal: once the platform allows it, a later start
  // registers, and a teardown that throws is not a failure either.
  port.subscribeFails = false;
  controller.start();
  assert.equal(port.subscribeCalls, 2);
  port.deliver(delivery());
  assert.equal(published.length, 1);
  assert.doesNotThrow(() => {
    controller.stop();
  });
});

test("a capacity that would disable retention falls back to the published bound", () => {
  // A shell computing the bound from a setting, a screen height or a parsed
  // string can hand over zero, a negative, a fraction or NaN. None of those may
  // silently turn the feed off: retention is what makes a missed notification
  // recoverable after the OS tray entry is gone.
  for (const capacity of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const inbox = new PushNotificationInbox(capacity);
    for (let index = 0; index < maxRetainedPushNotifications + 3; index += 1) {
      assert.notEqual(inbox.receive(delivery({ subjectId: `task-${index}` })), null);
    }
    assert.equal(
      inbox.list().length,
      maxRetainedPushNotifications,
      `capacity ${String(capacity)} did not fall back to the published bound`,
    );
    assert.equal(inbox.list()[0]?.subjectId, `task-${maxRetainedPushNotifications + 2}`);
  }

  // The fallback is not a refusal to be configured: a real bound still holds,
  // including the smallest one a shell may ask for.
  const single = new PushNotificationInbox(1);
  single.receive(delivery({ subjectId: "first" }));
  single.receive(delivery({ subjectId: "second" }));
  assert.deepEqual(single.list().map((view) => view.subjectId), ["second"]);
});

test("a delivery carrying its own __proto__ key is a different document", () => {
  // An object literal would only set the prototype; JSON.parse is how a real
  // push arrives, and it defines `__proto__` as an own enumerable key. That is
  // one key more than the contract describes, so the delivery is dropped whole
  // rather than being read past.
  const delivered: unknown = JSON.parse(
    '{"type":"failed","source":"ag-loop-read","subjectId":"1155",' +
      '"occurredAt":"2026-08-11T09:30:00Z","__proto__":{"polluted":true}}',
  );
  assert.ok(typeof delivered === "object" && delivered !== null);
  assert.equal(Object.hasOwn(delivered, "__proto__"), true, "the fixture is not an own-key delivery");
  assert.ok(Object.keys(delivered).includes("__proto__"));

  assert.equal(parsePushNotification(delivered), null);

  const port = new FakeDeliveryPort();
  const inbox = new PushNotificationInbox();
  const published: (readonly PushNotificationViewState[])[] = [];
  const controller = new PushNotificationController(port, inbox, (feed) => {
    published.push(feed);
  });
  controller.start();
  assert.doesNotThrow(() => {
    port.deliver(delivered);
  });
  assert.equal(published.length, 0);
  assert.deepEqual(inbox.list(), []);
  controller.stop();

  // Neither the parse nor the feed may leave anything behind on the prototype.
  assert.equal(Object.hasOwn(Object.prototype, "polluted"), false);
});

test("a duplicate delivered through the controller republishes an unchanged feed", () => {
  const port = new FakeDeliveryPort();
  const inbox = new PushNotificationInbox();
  const published: (readonly PushNotificationViewState[])[] = [];
  const controller = new PushNotificationController(port, inbox, (feed) => {
    published.push(feed);
  });
  controller.start();

  port.deliver(delivery({ subjectId: "1155" }));
  port.deliver(delivery({ subjectId: "1155" }));

  // Current behaviour, recorded: a duplicate is a valid delivery, so the inbox
  // answers with the retained view rather than `null`, and the controller
  // publishes again. The feed is byte-for-byte the same, so the screen shows no
  // new row — the cost is one redundant render, not a duplicated notification.
  assert.equal(published.length, 2);
  assert.deepEqual(published[0]?.map((view) => view.subjectId), ["1155"]);
  assert.deepEqual(published[1]?.map((view) => view.subjectId), ["1155"]);
  assert.deepEqual(published[1], published[0]);
  assert.equal(inbox.list().length, 1);

  controller.stop();
});

test("a controller stopped normally subscribes again on the next start", () => {
  const port = new FakeDeliveryPort();
  const inbox = new PushNotificationInbox();
  const published: (readonly PushNotificationViewState[])[] = [];
  const controller = new PushNotificationController(port, inbox, (feed) => {
    published.push(feed);
  });

  controller.start();
  const first = port.listeners[0];
  assert.ok(first !== undefined);
  first(delivery({ subjectId: "1155" }));
  assert.equal(published.length, 1);

  controller.stop();
  assert.equal(port.unsubscribeCalls, 1);

  // Leaving the screen and coming back is the ordinary lifecycle, not the
  // failure path: a stop that succeeded must not leave the controller unable to
  // register again.
  controller.start();
  assert.equal(port.subscribeCalls, 2);
  assert.equal(port.listeners.length, 2);

  const second = port.listeners[1];
  assert.ok(second !== undefined);
  second(delivery({ subjectId: "1156" }));
  assert.equal(published.length, 2);
  assert.deepEqual(published[1]?.map((view) => view.subjectId), ["1156", "1155"]);

  controller.stop();
  assert.equal(port.unsubscribeCalls, 2);
  second(delivery({ subjectId: "1157" }));
  assert.equal(published.length, 2, "a late callback published after the second stop()");
});

test("a late callback from a replaced subscription is still accepted while active", () => {
  const port = new FakeDeliveryPort();
  const inbox = new PushNotificationInbox();
  const published: (readonly PushNotificationViewState[])[] = [];
  const controller = new PushNotificationController(port, inbox, (feed) => {
    published.push(feed);
  });

  controller.start();
  const stale = port.listeners[0];
  assert.ok(stale !== undefined);
  controller.stop();
  controller.start();

  // Recorded behaviour: the guard is "does this screen still want deliveries",
  // not "which subscription delivered". A callback the platform had queued
  // against the cancelled subscription therefore lands in the feed once the
  // controller is active again. It is the same operator, the same screen and a
  // payload that passes the same filter, so nothing unvalidated becomes
  // visible; the only observable effect is that an in-flight delivery survives
  // a restart instead of being dropped with its subscription.
  stale(delivery({ subjectId: "1155" }));
  assert.equal(published.length, 1);
  assert.deepEqual(inbox.list().map((view) => view.subjectId), ["1155"]);

  // Both subscriptions feed one inbox, so the same event arriving on each is
  // still retained once.
  const current = port.listeners[1];
  assert.ok(current !== undefined);
  current(delivery({ subjectId: "1155" }));
  assert.equal(inbox.list().length, 1);

  // And once the screen is left for good, neither subscription publishes.
  controller.stop();
  stale(delivery({ subjectId: "1156" }));
  current(delivery({ subjectId: "1157" }));
  assert.equal(published.length, 2, "a late callback published after stop()");
  assert.deepEqual(inbox.list().map((view) => view.subjectId), ["1155"]);
});

test("an observer that throws never escapes into the platform callback", () => {
  const port = new FakeDeliveryPort();
  const inbox = new PushNotificationInbox();
  let observations = 0;
  const controller = new PushNotificationController(port, inbox, () => {
    observations += 1;
    throw new Error("screen failed to render");
  });

  controller.start();
  assert.doesNotThrow(() => {
    port.deliver(delivery({ subjectId: "1155" }));
  });
  assert.equal(observations, 1);
  // The notification is not lost with the render that failed.
  assert.deepEqual(inbox.list().map((view) => view.subjectId), ["1155"]);

  assert.doesNotThrow(() => {
    controller.clear();
  });
  assert.equal(observations, 2);
  assert.deepEqual(inbox.list(), []);
});
