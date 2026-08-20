// TASK 1116 (IVER-3) — tiltas tarp `ExecutionAdapter` porto ir semantinio integracijos
// reviewer'io (etalonas: AG_loop orchestrator/adapters/execution-adapter.ts tilto pusė).
// application/integration negali importuoti infrastructure, o domain/agents nieko nežino
// apie peržiūrą — šis adapteris yra vienintelė vieta, kur juodu susitinka.
//
// DVI savybės yra taisyklė:
//   1. PERŽIŪRA READ-ONLY: `allowedPaths: []` — reviewer'is grąžina verdiktą, ne
//      pakeitimus; taisymą daro atskiras integration repair.
//   2. NEPAVYKĘS KVIETIMAS NIEKADA NĖRA PATVIRTINIMAS: ne-`completed` statusas virsta
//      `escalate` — tylus approve dėl infrastruktūros gedimo būtų blogiausias elgesys.

import type { ExecutionAdapter } from "../../domain/agents/execution-port.js";
import {
  parseIntegrationReviewResponse,
  type IntegrationReviewerPort,
  type IntegrationReviewerRequest,
  type IntegrationReviewerResponse,
} from "../../application/integration/review-integration.js";

export function createExecutionAdapterIntegrationReviewer(
  adapter: ExecutionAdapter,
  options: { model?: string; cwd?: string } = {},
): IntegrationReviewerPort {
  return {
    async review(request: IntegrationReviewerRequest): Promise<IntegrationReviewerResponse> {
      const result = await adapter.execute({
        taskId: request.taskId,
        prompt: request.prompt,
        allowedPaths: [],
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      });

      if (result.status !== "completed") {
        return {
          verdict: "escalate",
          summary: `integration reviewer adapter ${result.adapter} returned ${result.status} (exit ${result.exitCode}): ${result.reason}`,
          findings: [],
          ...(options.model === undefined ? {} : { model: options.model }),
        };
      }

      const parsed = parseIntegrationReviewResponse(result.structuredOutput ?? result.stdout);
      const model = parsed.model ?? options.model;
      return { ...parsed, ...(model === undefined ? {} : { model }) };
    },
  };
}
