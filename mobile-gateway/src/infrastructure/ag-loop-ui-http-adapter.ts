import {
  AG_LOOP_LOG_LINE_LIMIT,
  AG_LOOP_LOG_NAMES,
  AG_LOOP_TOKEN_USAGE_LIMIT,
  type AgLoopDashboard,
  type AgLoopLearning,
  type AgLoopLogName,
  type AgLoopLogs,
  type AgLoopPolicyControls,
  type AgLoopStreamMessage,
  type AgLoopTaskBucket,
  type AgLoopTokenAnalytics,
  type AgLoopTokenUsage,
  type AgLoopUiReadPort,
} from "../application/ports/ag-loop-ui-read-port.js";
import {
  clamp,
  projectActivityPayload,
  projectDashboardPayload,
  projectLearningPayload,
  projectLogsPayload,
  projectPolicyControlsPayload,
  projectTaskBucketPayload,
  projectTokenAnalyticsPayload,
  projectTokenUsagePayload,
  taskBuckets,
} from "./ag-loop-ui-projections.js";

/**
 * Kaip gateway kalbasi su VERQESTRA UI: loopback HTTP, per-start token'as, SSE srautas.
 *
 * SKAIDYMAS: projekcijos gyvena `ag-loop-ui-projections.ts` (žr. ten). Čia liko tik
 * transportas.
 *
 * ────────────────────────────────────────────────────────────────────────────────
 * NUKRYPIMAS NUO ETALONO — TAPATYBĖ. Šis failas yra VIENINTELĖ vieta, kur gateway liečia
 * orkestratorių, ir jo kontraktas VERQESTRA'oje pakitęs. Etalonas ieškojo `ag-ui-token` meta
 * žymos ir siuntė `x-ag-ui-token` antraštę; VERQESTRA E6 metu abu pervardyti į `vq-ui-token` ir
 * `x-vq-ui-token` (`src/interfaces/http/ui-security.ts`). Perkėlus 1:1 adapteris būtų lūžęs per
 * PIRMĄ žingsnį — token'o ištraukimą iš HTML — ir kiekviena užklausa būtų grįžusi 401.
 *
 * Ir svarbiausia: **nė vienas testas to nebūtų pagavęs.** Tai runtime protokolas, o vienintelė
 * šio adapterio danga naudoja fake'ą, kuris atsakymus deklaruoja pats. Būtent taip ta pati
 * klasė defekto ir gyvavo etalone — žr. `/api/logs` žemiau.
 *
 * DVI PAKUOTĖS, VIENAS LITERALAS. Šių eilučių negalima importuoti iš `src/interfaces/http`:
 * kietoji riba sako, kad gateway neimportuoja orkestratoriaus šaltinių, ir tos ribos šis failas
 * laužti negali. Vadinasi jos yra DUBLIKATAS pagal konstrukciją, ir nė vienas kompiliatorius
 * jų nesutikrins — sutapimą įrodo tik gyvas paleidimas. Tai užrašyta čia, o ne pamiršta.
 * ────────────────────────────────────────────────────────────────────────────────
 */

type FetchLike = typeof fetch;

/** `src/interfaces/http/ui-security.ts#UI_TOKEN_META_NAME`. Dublikatas — žr. failo antraštę. */
const UI_TOKEN_META_NAME = "vq-ui-token";

/** `src/interfaces/http/ui-security.ts#UI_TOKEN_HEADER`. Dublikatas — žr. failo antraštę. */
const UI_TOKEN_HEADER = "x-vq-ui-token";

/**
 * Stream limits. The buffer bound stops a malformed upstream — or one that never
 * terminates a frame — from growing the gateway's heap without limit; the
 * reconnect ladder keeps a restarting UI from being hammered.
 */
const MAX_STREAM_BUFFER_CHARS = 256 * 1024;
/** The bootstrap page is a small HTML shell; the JSON reads are payload-sized. */
const MAX_BOOTSTRAP_BODY_CHARS = 512 * 1024;
const MAX_READ_BODY_CHARS = 8 * 1024 * 1024;
const MAX_STREAM_RECONNECT_ATTEMPTS = 5;
const STREAM_RECONNECT_BASE_MS = 1_000;
const STREAM_RECONNECT_CEILING_MS = 15_000;

function requireLoopbackOrigin(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error("VERQESTRA UI origin must be a credential-free loopback HTTP origin");
  }
  return url;
}

function extractUiToken(html: string): string {
  const match = new RegExp(
    `<meta\\s+name=["']${UI_TOKEN_META_NAME}["']\\s+content=["']([^"']+)["']`,
    "i",
  ).exec(html);
  if (!match?.[1] || !/^[A-Za-z0-9_-]{32,128}$/.test(match[1])) {
    throw new Error("VERQESTRA UI bootstrap token was not found");
  }
  return match[1];
}

/** Blank line separating two SSE frames; non-global so `exec` always scans from 0. */
const FRAME_BOUNDARY = /\r?\n\r?\n/;

/** One `data:`-carrying SSE frame, or `null` for a comment/keepalive frame. */
function frameData(frame: string): string | null {
  const data = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n");
  return data.length === 0 ? null : data;
}

function reconnectDelayMs(baseMs: number, failures: number): number {
  return Math.min(baseMs * 2 ** Math.max(0, failures - 1), STREAM_RECONNECT_CEILING_MS);
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
  });
}

export class AgLoopUiHttpAdapter implements AgLoopUiReadPort {
  readonly #origin: URL;
  #token: string | undefined;

  constructor(
    origin: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = 5_000,
    /**
     * First rung of the stream reconnect ladder. Injectable so a test can prove
     * the give-up behaviour without spending the real backoff in wall clock.
     */
    private readonly reconnectBaseMs = STREAM_RECONNECT_BASE_MS,
  ) {
    this.#origin = requireLoopbackOrigin(origin);
  }

  /**
   * Reads a bounded response body.
   *
   * The UI is same-host and trusted to be honest, but it is not trusted to be
   * small: `token-analytics` grows with the whole run history, and a gateway
   * that buffers whatever arrives has no bound of its own. The SSE path already
   * caps its buffer; this closes the same gap for the JSON reads.
   */
  async #boundedText(response: Response, limitChars: number): Promise<string> {
    const body = response.body;
    if (!body) {
      return "";
    }
    const reader = body.getReader();
    const decoder = new TextDecoder("utf-8");
    let text = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          return text + decoder.decode();
        }
        text += decoder.decode(value, { stream: true });
        if (text.length > limitChars) {
          throw new Error("VERQESTRA UI response exceeded the gateway body limit");
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }

  async #bootstrap(): Promise<void> {
    const response = await this.fetchImpl(this.#origin, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`VERQESTRA UI bootstrap failed with status ${response.status}`);
    this.#token = extractUiToken(await this.#boundedText(response, MAX_BOOTSTRAP_BODY_CHARS));
  }

  async #get(pathname: string): Promise<unknown> {
    if (!pathname.startsWith("/api/")) throw new Error("Only allowlisted UI API reads are supported");
    if (!this.#token) await this.#bootstrap();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await this.fetchImpl(new URL(pathname, this.#origin), {
        method: "GET",
        redirect: "manual",
        headers: { [UI_TOKEN_HEADER]: this.#token ?? "" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if ((response.status === 401 || response.status === 403) && attempt === 0) {
        await this.#bootstrap();
        continue;
      }
      if (!response.ok) throw new Error(`VERQESTRA UI read failed with status ${response.status}`);
      const text = await this.#boundedText(response, MAX_READ_BODY_CHARS);
      try {
        return JSON.parse(text) as unknown;
      } catch {
        // Deliberately not the parser's message: it quotes the payload, and the
        // payload is exactly what must not travel back out of this adapter.
        throw new Error("VERQESTRA UI read returned a malformed JSON body");
      }
    }
    throw new Error("VERQESTRA UI token refresh failed");
  }

  async dashboard(): Promise<AgLoopDashboard> {
    return projectDashboardPayload(await this.#get("/api/dashboard"));
  }

  async taskBucket(bucket: string): Promise<AgLoopTaskBucket> {
    if (!taskBuckets.has(bucket)) throw new Error("Invalid AG Loop task bucket");
    return projectTaskBucketPayload(
      await this.#get(`/api/tasks?bucket=${encodeURIComponent(bucket)}`),
      bucket,
    );
  }

  /**
   * Bounded, redacted log projection.
   *
   * ETALONO SPRAGA, UŽDARYTA (2026-08-24). Etalono komentaras čia sakė, kad `/api/logs`
   * „does not exist in every AG Loop generation" ir kad nesantis maršrutas telefonui atrodo
   * kaip `ag_loop_ui_offline`. Patikrinus pasirodė blogiau: to maršruto neaptarnavo NĖ VIENA
   * karta — `/api/logs` visame AG_loop egzistavo dviejose vietose, ir abi buvo šio paketo
   * viduje (šis adapteris ir jo testas su fake'u). Vadinasi mobile pusė kalbėjo su maršrutu,
   * kurio niekas neatsakė, o vienintelė danga tą atsakymą deklaravo pati.
   *
   * Operatoriaus sprendimu (2026-08-24) maršrutas VERQESTRA'oje SUKURTAS —
   * `src/application/analytics/ui-log-query.ts` + `interfaces/http/ui-router.ts` — tad šis
   * kvietimas nuo šiol turi ką klausti. Serverio ribos (200/100/4096) sutampa su porto
   * ribomis, ir tai prikalta `src/tests/ui-log-query.test.ts`.
   */
  async logs(log: AgLoopLogName, lines: number): Promise<AgLoopLogs> {
    if (!AG_LOOP_LOG_NAMES.includes(log)) throw new Error("Invalid log name");
    const bounded = clamp(lines, 1, AG_LOOP_LOG_LINE_LIMIT);
    return projectLogsPayload(
      await this.#get(`/api/logs?log=${encodeURIComponent(log)}&lines=${bounded}`),
      log,
      bounded,
    );
  }

  async tokenUsage(limit: number): Promise<AgLoopTokenUsage> {
    const bounded = clamp(limit, 1, AG_LOOP_TOKEN_USAGE_LIMIT);
    return projectTokenUsagePayload(await this.#get(`/api/token-usage?limit=${bounded}`), bounded);
  }

  async tokenAnalytics(): Promise<AgLoopTokenAnalytics> {
    return projectTokenAnalyticsPayload(await this.#get("/api/token-analytics"));
  }

  async policyControls(): Promise<AgLoopPolicyControls> {
    return projectPolicyControlsPayload(await this.#get("/api/dashboard"));
  }

  async learning(): Promise<AgLoopLearning> {
    return projectLearningPayload(await this.#get("/api/dashboard"));
  }

  /** One upstream SSE attempt, with the same single re-bootstrap rule as `#get`. */
  async #openStream(signal: AbortSignal): Promise<Response> {
    if (!this.#token) await this.#bootstrap();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await this.fetchImpl(new URL("/api/events", this.#origin), {
        method: "GET",
        redirect: "manual",
        headers: { [UI_TOKEN_HEADER]: this.#token ?? "", accept: "text/event-stream" },
        signal,
      });
      if ((response.status === 401 || response.status === 403) && attempt === 0) {
        await response.body?.cancel();
        await this.#bootstrap();
        continue;
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error(`VERQESTRA UI stream failed with status ${response.status}`);
      }
      return response;
    }
    throw new Error("VERQESTRA UI token refresh failed");
  }

  async *#readStream(signal: AbortSignal): AsyncGenerator<AgLoopStreamMessage> {
    const response = await this.#openStream(signal);
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > MAX_STREAM_BUFFER_CHARS) {
          throw new Error("VERQESTRA UI stream frame exceeded the gateway buffer");
        }
        let boundary = FRAME_BOUNDARY.exec(buffer);
        while (boundary) {
          const frame = buffer.slice(0, boundary.index);
          // `exec` visada užpildo [0]; `noUncheckedIndexedAccess` to nežino, o riba stovi
          // toje pačioje išraiškoje kaip prieiga (`while (boundary)`).
          buffer = buffer.slice(boundary.index + boundary[0]!.length);
          const data = frameData(frame);
          if (data === null) {
            yield { type: "keepalive" };
          } else {
            try {
              yield { type: "activity", activity: projectActivityPayload(JSON.parse(data)) };
            } catch {
              // A single malformed frame is upstream noise, not a reason to drop
              // a healthy connection; the next snapshot supersedes it anyway.
            }
          }
          boundary = FRAME_BOUNDARY.exec(buffer);
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }

  async *activityStream(signal: AbortSignal): AsyncGenerator<AgLoopStreamMessage> {
    let failures = 0;
    while (!signal.aborted) {
      try {
        yield* this.#readStream(signal);
        // A clean upstream end is a restart, not a fault: the ladder resets so a
        // healthy reconnect is not punished by an earlier outage.
        failures = 0;
      } catch {
        if (signal.aborted) return;
        failures += 1;
        if (failures >= MAX_STREAM_RECONNECT_ATTEMPTS) {
          throw new Error("VERQESTRA UI activity stream is unavailable");
        }
      }
      if (signal.aborted) return;
      yield { type: "keepalive" };
      await delay(reconnectDelayMs(this.reconnectBaseMs, failures), signal);
    }
  }
}
