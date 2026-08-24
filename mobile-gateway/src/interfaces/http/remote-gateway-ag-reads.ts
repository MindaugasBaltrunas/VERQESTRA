import type { AccessTokenClaims } from "../../application/device-auth-service.js";
import {
  AG_LOOP_LOG_LINE_DEFAULT,
  AG_LOOP_LOG_LINE_LIMIT,
  AG_LOOP_LOG_NAMES,
  AG_LOOP_TOKEN_USAGE_DEFAULT,
  AG_LOOP_TOKEN_USAGE_LIMIT,
  type AgLoopLogName,
  type AgLoopStreamMessage,
} from "../../application/ports/ag-loop-ui-read-port.js";
import type { ProjectReadService } from "../../application/project-read-service.js";
import {
  InvalidHttpRequestError,
  RateLimitedError,
  eventStreamHeaders,
  readResponse,
  type GatewayHttpResponse,
} from "./remote-gateway-contract.js";
import { allowQueryParameters, boundedQueryInteger } from "./remote-gateway-dto.js";

/**
 * AG Loop UI SKAITYMO šeima ir jos aktyvumo srautų biudžetas.
 *
 * SKAIDYMAS (VERQESTRA ≤500 eil. vartas). Pjūvis ne mechaninis: `activityStreams` skaitiklis
 * yra vienintelė maršrutizatoriaus būsena, kurios neliečia nė vienas kitas maršrutas, tad ji
 * keliauja kartu su ta šeima, kuriai priklauso. Autentikacija ir projekto matomumas lieka
 * kviečiančiajam — čia nesprendžiama, ar skambintojas gali matyti projektą.
 */

const TASK_BUCKETS = new Set(["queue", "active", "delegated", "done", "error", "failed", "human-review"]);

/**
 * The AG Loop UI read family. One matcher for all of it, so a new read cannot be
 * added without also appearing in `GATEWAY_ROUTE_SURFACE` and in the contract:
 * the resource names below are the same strings the route templates end with.
 */
const AG_READ_ROUTE =
  /^\/v1\/projects\/([^/]+)\/ag-loop\/ui\/(dashboard|tasks|logs|events|policy-controls|learning|token-usage|token-analytics)$/;

/**
 * The same resource names the alternation above lists, in a form the type system can check
 * a string against. The one thing it cannot check — that this list and the regex name the
 * same set — fails as „no such route", ne kaip skaitymas be resurso.
 */
const AG_READ_RESOURCES = Object.freeze([
  "dashboard",
  "tasks",
  "logs",
  "events",
  "policy-controls",
  "learning",
  "token-usage",
  "token-analytics",
] as const);

export type AgReadResource = (typeof AG_READ_RESOURCES)[number];

/** Raw project id plus the resource named by an AG Loop UI read path. */
export type AgReadTarget = Readonly<{
  /** Still unvalidated: the caller decides what an invalid project id answers. */
  projectId: string;
  resource: AgReadResource;
}>;

/**
 * Concurrent activity streams one device may hold open.
 *
 * An SSE read is not a request that ends: each one pins a gateway connection and
 * an upstream AG Loop UI connection for as long as the phone keeps it. Two is
 * enough for a foreground screen plus an in-flight reconnect, and it bounds what
 * a single compromised device can hold.
 */
const MAX_ACTIVITY_STREAMS_PER_DEVICE = 2;
/** SSE `retry:` hint: how long a phone should wait before reconnecting. */
const ACTIVITY_STREAM_RECONNECT_HINT_MS = 3_000;
/** `Retry-After` on the 429 a device gets when its stream budget is full. */
const ACTIVITY_STREAM_BUDGET_RETRY_AFTER_SECONDS = 5;

/** The segment as a member of {@link AG_READ_RESOURCES}, or `undefined` if it is none. */
function agReadResource(value: string): AgReadResource | undefined {
  return AG_READ_RESOURCES.find((resource) => resource === value);
}

/**
 * Which AG Loop UI read a path names, or `undefined` when it names none.
 *
 * NUKRYPIMAS (formos, ne elgesio): `noUncheckedIndexedAccess` daro regex grupes
 * `string | undefined`, nors abi šiame šablone yra privalomos. Susiaurinimas atliekamas čia
 * vieną kartą ir per membership patikrą, o ne `as` operatoriumi kvietimo vietoje: `as` būtų
 * tik tylus melas tipų sistemai.
 */
export function matchAgRead(pathname: string): AgReadTarget | undefined {
  const match = AG_READ_ROUTE.exec(pathname);
  if (!match) return undefined;
  const [, projectId, segment] = match;
  if (projectId === undefined || segment === undefined) return undefined;
  const resource = agReadResource(segment);
  if (resource === undefined) return undefined;
  return Object.freeze({ projectId, resource });
}

export class AgLoopReadRoutes {
  /** Open activity streams per device, the live half of the concurrency bound. */
  readonly #activityStreams = new Map<string, number>();

  /**
   * Serves one AG Loop UI read.
   *
   * Authentication and query validation live here; project visibility and every
   * upstream fault stay in `ProjectReadService`, which is why no branch below
   * decides whether the caller may see the project.
   */
  async read(
    reads: ProjectReadService,
    url: URL,
    resource: AgReadResource,
    projectId: string,
    claims: AccessTokenClaims,
  ): Promise<GatewayHttpResponse> {
    const principalId = claims.sub;
    switch (resource) {
      case "dashboard": {
        allowQueryParameters(url, []);
        return readResponse(await reads.dashboard(principalId, projectId));
      }
      case "tasks": {
        allowQueryParameters(url, ["bucket"]);
        const bucket = url.searchParams.get("bucket");
        if (!bucket || !TASK_BUCKETS.has(bucket)) {
          throw new InvalidHttpRequestError("Task bucket is invalid");
        }
        return readResponse(await reads.taskBucket(principalId, projectId, bucket));
      }
      case "logs": {
        allowQueryParameters(url, ["log", "lines"]);
        const log = url.searchParams.get("log");
        if (!log || !(AG_LOOP_LOG_NAMES as readonly string[]).includes(log)) {
          throw new InvalidHttpRequestError("Log name is invalid");
        }
        const lines = boundedQueryInteger(
          url,
          "lines",
          1,
          AG_LOOP_LOG_LINE_LIMIT,
          AG_LOOP_LOG_LINE_DEFAULT,
        );
        return readResponse(await reads.logs(principalId, projectId, log as AgLoopLogName, lines));
      }
      case "token-usage": {
        allowQueryParameters(url, ["limit"]);
        const limit = boundedQueryInteger(
          url,
          "limit",
          1,
          AG_LOOP_TOKEN_USAGE_LIMIT,
          AG_LOOP_TOKEN_USAGE_DEFAULT,
        );
        return readResponse(await reads.tokenUsage(principalId, projectId, limit));
      }
      case "token-analytics": {
        allowQueryParameters(url, []);
        return readResponse(await reads.tokenAnalytics(principalId, projectId));
      }
      case "policy-controls": {
        allowQueryParameters(url, []);
        return readResponse(await reads.policyControls(principalId, projectId));
      }
      case "learning": {
        allowQueryParameters(url, []);
        return readResponse(await reads.learning(principalId, projectId));
      }
      case "events": {
        allowQueryParameters(url, []);
        // Checked and taken in one synchronous step. A burst of concurrent
        // requests must not all pass a check that nothing has yet acted on, and
        // the caller that loses the race deserves a 429 it can retry rather than
        // a 200 that closes immediately.
        if (!this.#reserveActivityStream(claims.deviceId)) {
          throw new RateLimitedError(ACTIVITY_STREAM_BUDGET_RETRY_AFTER_SECONDS);
        }
        const release = this.#activityStreamRelease(claims.deviceId);
        const abort = new AbortController();
        let source: AsyncIterable<AgLoopStreamMessage>;
        try {
          // Authorization is resolved now, while a status code can still be
          // sent. Once the 200 is on the wire the only remaining error channel
          // is ending the stream.
          source = await reads.activityStream(principalId, projectId, abort.signal);
        } catch (error) {
          release();
          throw error;
        }
        return {
          status: 200,
          headers: eventStreamHeaders(),
          body: {},
          stream: this.#activityFrames(source, abort, release),
          onClose: () => {
            abort.abort();
            release();
          },
        };
      }
    }
  }

  #reserveActivityStream(deviceId: string): boolean {
    const open = this.#activityStreams.get(deviceId) ?? 0;
    if (open >= MAX_ACTIVITY_STREAMS_PER_DEVICE) {
      return false;
    }
    this.#activityStreams.set(deviceId, open + 1);
    return true;
  }

  /**
   * Single-shot release for one reserved slot.
   *
   * Both the frame generator and the transport call it — the generator when the
   * stream ends, the transport when the socket does — because neither on its own
   * covers a stream the transport never starts iterating. Releasing twice must
   * therefore be a no-op rather than a slot the gateway hands out twice.
   */
  #activityStreamRelease(deviceId: string): () => void {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const open = this.#activityStreams.get(deviceId) ?? 0;
      if (open <= 1) {
        this.#activityStreams.delete(deviceId);
      } else {
        this.#activityStreams.set(deviceId, open - 1);
      }
    };
  }

  /** Formats sanitized activity messages as SSE frames. */
  async *#activityFrames(
    source: AsyncIterable<AgLoopStreamMessage>,
    abort: AbortController,
    release: () => void,
  ): AsyncGenerator<string> {
    try {
      // Reconnect guidance for the phone. No replay accompanies it and none is
      // needed: every activity event is a complete snapshot, so a client that
      // reconnects is current as soon as the next one arrives.
      yield `retry: ${ACTIVITY_STREAM_RECONNECT_HINT_MS}\n\n`;
      let sequence = 0;
      for await (const message of source) {
        if (message.type === "keepalive") {
          yield ": keepalive\n\n";
          continue;
        }
        sequence += 1;
        yield `id: ${sequence}\nevent: activity\ndata: ${JSON.stringify(message.activity)}\n\n`;
      }
    } catch {
      // The upstream stopped answering. The status line is long gone, so the
      // gateway says so in the last frame and lets the phone reconnect.
      yield `event: end\ndata: ${JSON.stringify({ reason: "ag_loop_ui_offline" })}\n\n`;
    } finally {
      abort.abort();
      release();
    }
  }
}
