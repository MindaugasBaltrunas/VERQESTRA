/**
 * View state of one accepted push notification. Types only — the projection that
 * fills them is `controller/presentation/push-notification-presenter.ts`; see
 * `ag-loop-view-state.ts` for why the two are separate files here.
 *
 * This module imports nothing at all, including from the Model: a notification
 * is described entirely by fixed labels and one already-proven-opaque id.
 */

export type PushNotificationSeverity = "failure" | "completion";

export type PushNotificationViewState = Readonly<{
  /** Structural, not a flag: a notification never carries an AG Loop action. */
  readOnly: true;
  severity: PushNotificationSeverity;
  /** A fixed label chosen by `(source, type)`; never text from the payload. */
  title: string;
  subjectLabel: string;
  /** The only payload-derived string, and only after the opaque checks passed. */
  subjectId: string;
  /** ISO-8601 as delivered; localisation belongs to the shell. */
  occurredAtLabel: string;
  accessibilityLabel: string;
}>;
