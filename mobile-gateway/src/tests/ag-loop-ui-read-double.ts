import type {
  AgLoopStreamMessage,
  AgLoopUiReadPort,
} from "../application/ports/ag-loop-ui-read-port.js";

/**
 * Test double for the AG Loop UI read port.
 *
 * Every member answers with an empty, contract-shaped value so a test only has
 * to state the read it is actually about. Adding a member to the port breaks
 * this file alone instead of every test that composes a router.
 */
export function agLoopUiReadDouble(
  overrides: Partial<AgLoopUiReadPort> = {},
): AgLoopUiReadPort {
  const base: AgLoopUiReadPort = {
    async dashboard() {
      return {
        availability: "online",
        currentTask: { id: null, state: "none" },
        queueCounts: {},
        runtime: [],
        reviewCount: 0,
        updatedAt: "2026-07-26T10:00:00.000Z",
      };
    },
    async taskBucket(bucket) {
      return { bucket, tasks: [], totalCount: 0 };
    },
    async logs(log) {
      return { log, lines: [], truncated: false };
    },
    async tokenUsage() {
      return { records: [] };
    },
    async tokenAnalytics() {
      return { candidates: [], latestSnapshot: null };
    },
    async policyControls() {
      return { groups: [] };
    },
    async learning() {
      return {
        summary: {
          records: 0,
          byType: {},
          pendingRecommendations: 0,
          approvedRecommendations: 0,
          rejectedRecommendations: 0,
        },
        recommendations: [],
      };
    },
    activityStream(): AsyncIterable<AgLoopStreamMessage> {
      return (async function* empty() {})();
    },
  };
  return { ...base, ...overrides };
}
