/**
 * Vocabulary shared by the read-only channels.
 *
 * Every read-only space — AG Loop UI, session review, host connections, project
 * directory — reports the same four link states and follows the same rule when a
 * read fails, so the rule lives here once instead of being re-derived per
 * channel:
 *
 * - `connecting`   — a read is in flight and no snapshot has been accepted yet;
 * - `connected`    — the last read succeeded;
 * - `degraded`     — the last read failed while a usable snapshot is still on
 *                    screen, read-only and stale;
 * - `offline`      — no snapshot exists, or the host is not reachable at all.
 */
export type ReadChannelLinkState = "connecting" | "connected" | "degraded" | "offline";

/**
 * Link state while a read is starting.
 *
 * A refresh over a healthy link must not flash `connecting` back at the user:
 * only a link without a usable snapshot, or one already known to be offline,
 * reports that it is dialling.
 */
export function linkAfterReadStarted(input: Readonly<{
  current: ReadChannelLinkState;
  hasSnapshot: boolean;
}>): ReadChannelLinkState {
  return !input.hasSnapshot || input.current === "offline" ? "connecting" : input.current;
}

/**
 * Link state after a failed read.
 *
 * A failure may only keep or lower the reported quality: a channel already known
 * to be offline never looks better because a retry failed as well. `degraded` is
 * reserved for a link that merely lost its last read while a usable snapshot is
 * still readable; `unreachable` marks the failures that say the host itself is
 * not answering, which is offline no matter what is still on screen.
 */
export function linkAfterReadFailed(input: Readonly<{
  current: ReadChannelLinkState;
  hasSnapshot: boolean;
  unreachable: boolean;
}>): ReadChannelLinkState {
  return !input.hasSnapshot || input.current === "offline" || input.unreachable
    ? "offline"
    : "degraded";
}
