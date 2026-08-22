import type {
  BenchmarkReportView,
  DashboardData,
  LoopResult,
  LoopSlotMode,
  LoopStopResult,
  LoopWorkerId,
  ResolvedProposal,
  ReliabilityAnalyticsResponse,
  TokenAnalyticsResponse,
  TokenUsageQueryResponse,
  TokenUsageServerFilter,
  WorkerRequestState,
  WorkflowBucket,
  UploadResult,
} from "./types";

export function getUiToken(): string {
  return document.querySelector<HTMLMetaElement>('meta[name="vq-ui-token"]')?.content ?? "";
}

/**
 * Užklausos riba. Nė viena UI užklausa neturėjo nei timeout'o, nei `AbortController`, tad pakibęs
 * ar nutilęs serveris palikdavo puslapį suktis amžinai — be klaidos, be „bandyti dar kartą"
 * (2026-08-06 UI auditas). `/api/reliability-analytics?fresh=1` paleidžia git subprocesus, todėl
 * riba yra dosni, bet baigtinė.
 */
const REQUEST_TIMEOUT_MS = 30_000;

function withTimeout(options: RequestInit): { init: RequestInit; done: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  return {
    init: { ...options, signal: controller.signal },
    done: () => clearTimeout(timer),
  };
}

async function request(url: string, options: RequestInit = {}): Promise<Response> {
  const { init, done } = withTimeout({
    ...options,
    headers: {
      ...(options.headers as Record<string, string> | undefined),
      "x-vq-ui-token": getUiToken(),
    },
  });
  try {
    return await fetch(url, init);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(`Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s: ${url}`, { cause: error });
    }
    throw error;
  } finally {
    done();
  }
}

function post(url: string, options: RequestInit = {}): Promise<Response> {
  return request(url, { ...options, method: "POST" });
}

/**
 * Meta klaidą, kurioje matyti SERVERIO paaiškinimas, ne vien statusas.
 *
 * Iki 2026-08-06 UI audito kiekvienas kelias metė `HTTP <status>` ir atsakymo kūną numesdavo.
 * Vartotojas matydavo „Nepavyko įkelti užduoties: HTTP 400" vietoj serverio pasakyto
 * „task id already exists in done/" — t. y. tikslią priežastį, kurią jis pats gali sutvarkyti.
 */
async function assertOk(response: Response): Promise<void> {
  if (response.ok) return;
  let detail = "";
  try {
    const body = (await response.text()).trim();
    if (body) {
      try {
        const parsed = JSON.parse(body) as { error?: unknown };
        detail = typeof parsed.error === "string" ? parsed.error : body;
      } catch {
        detail = body;
      }
    }
  } catch {
    // Kūno perskaityti nepavyko — lieka pats statusas.
  }
  throw new Error(detail ? `HTTP ${response.status}: ${detail.slice(0, 300)}` : `HTTP ${response.status}`);
}

export async function fetchDashboard(): Promise<DashboardData> {
  const response = await request("/api/dashboard");
  await assertOk(response);
  return await (response.json() as Promise<DashboardData>);
}

export async function fetchWorkflowTasks(bucket: string): Promise<WorkflowBucket> {
  const response = await request(`/api/tasks?bucket=${encodeURIComponent(bucket)}`);
  await assertOk(response);
  return await (response.json() as Promise<WorkflowBucket>);
}
export async function resumeLoop(): Promise<LoopResult> {
  const r = await post("/tasks/resume");
  await assertOk(r);
  const data = (await r.json()) as { loop: LoopResult };
  return data.loop;
}

export async function stopLoop(): Promise<LoopStopResult> {
  const r = await post("/tasks/stop");
  await assertOk(r);
  const data = (await r.json()) as { loop: LoopStopResult };
  return data.loop;
}

export async function approveLearningRecommendation(id: string): Promise<void> {
  const r = await post(`/learning/approve/${encodeURIComponent(id)}`);
  await assertOk(r);
}

export async function rejectLearningRecommendation(id: string): Promise<void> {
  const r = await post(`/learning/reject/${encodeURIComponent(id)}`);
  await assertOk(r);
}

export async function uploadTaskFiles(files: File[]): Promise<UploadResult> {
  const payload = await Promise.all(files.map(async (f) => ({ name: f.name, content: await f.text() })));
  const r = await post("/tasks/queue/upload", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ files: payload }),
  });
  await assertOk(r);
  return await (r.json() as Promise<UploadResult>);
}

export async function openFolder(bucket: string): Promise<void> {
  const r = await post(`/folders/open/${encodeURIComponent(bucket)}`);
  await assertOk(r);
}

export async function proposePolicy(
  route: string,
  payload: { setting_id: string; requested_value: unknown; reason: string },
): Promise<void> {
  const r = await post(route, {
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  await assertOk(r);
}

/**
 * Įrašo worker slot'ų PRAŠYMĄ. Serveris grąžina įsigaliojusią būseną, o ne tai, kas buvo nusiųsta:
 * `AG_MAX_WORKERS` aplinkos kintamasis turi pirmenybę prieš failą, tad prašymas ir rezultatas gali
 * nesutapti.
 */
export async function setRequestedWorkers(requested: number): Promise<{ worker_request: WorkerRequestState }> {
  const r = await post("/api/runtime/workers", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ requested }),
  });
  await assertOk(r);
  return await (r.json() as Promise<{ worker_request: WorkerRequestState }>);
}

/**
 * Paleidžia loop'ą su AIŠKIU srautų skaičiumi (task 0052). Serveris tuo pačiu atstato srautų
 * valdiklį, tad likusi `drain` vėliava neprivers ką tik paleisto loop'o atsisakyti pirmo task'o.
 */
export async function startLoopWithWorkers(workers: 1 | 2): Promise<LoopResult> {
  const r = await post("/api/runtime/loop/start", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workers }),
  });
  await assertOk(r);
  const data = (await r.json()) as { loop: LoopResult };
  return data.loop;
}

/**
 * Įrašo vieno srauto NORIMĄ būseną. Atsakymo kūnas sąmoningai neskaitomas: faktinę srauto būseną
 * kontroleris pasiima iš dashboard snapshot'o — tik jis žino, ką banga realiai daro, o mutacijos
 * atsakymas liudija tik apie įrašytą norą.
 */
export async function setSlotMode(
  workerId: LoopWorkerId,
  mode: LoopSlotMode,
  reason?: string,
): Promise<void> {
  const r = await post(`/api/runtime/loop/slots/${encodeURIComponent(workerId)}`, {
    headers: { "content-type": "application/json" },
    body: JSON.stringify(reason === undefined ? { mode } : { mode, reason }),
  });
  await assertOk(r);
}

/**
 * Užduoties triažas iš UI. Serveris leidžia TIK `human-review -> queue|done`, o bet kokį kitą
 * perėjimą atmeta 409 su paaiškinimu — `assertOk` tą paaiškinimą perduoda toliau nepakeistą.
 * Atsakymo kūnas neskaitomas: ką triažas realiai pakeitė, pasako kitas dashboard snapshot'as.
 */
export async function triageTask(action: "requeue" | "complete", reference: string): Promise<void> {
  const r = await post(`/api/tasks/${action}/${encodeURIComponent(reference)}`);
  await assertOk(r);
}

export async function fetchPolicyProposals(): Promise<{ proposals: ResolvedProposal[] }> {
  const response = await request("/api/policies/proposals");
  await assertOk(response);
  return await (response.json() as Promise<{ proposals: ResolvedProposal[] }>);
}

export async function fetchTokenUsage(filter: TokenUsageServerFilter): Promise<TokenUsageQueryResponse> {
  const params = new URLSearchParams();
  if (filter.model) params.set("model", filter.model);
  if (filter.phase) params.set("phase", filter.phase);
  if (filter.from) params.set("from", filter.from);
  if (filter.to) params.set("to", filter.to);
  if (filter.limit !== undefined) params.set("limit", String(filter.limit));
  if (filter.offset !== undefined) params.set("offset", String(filter.offset));
  const response = await request(`/api/token-usage?${params.toString()}`);
  await assertOk(response);
  return await (response.json() as Promise<TokenUsageQueryResponse>);
}

export async function fetchTokenAnalytics(): Promise<TokenAnalyticsResponse> {
  const response = await request("/api/token-analytics");
  await assertOk(response);
  return await (response.json() as Promise<TokenAnalyticsResponse>);
}

export async function fetchReliabilityAnalytics(fresh = false): Promise<ReliabilityAnalyticsResponse> {
  const response = await request(`/api/reliability-analytics${fresh ? "?fresh=1" : ""}`);
  await assertOk(response);
  const data = (await response.json()) as ReliabilityAnalyticsResponse;
  // A UI server started from an older dist answers 200 with a pre-byDay shape,
  // which would blank-crash the charts. Surface it as an actionable error instead.
  if (!Array.isArray(data.reliability?.byDay) || !Array.isArray(data.files?.byDay)) {
    throw new Error("serverio atsakymas pasenusios formos — perkrauk AG UI serverį (sustabdyk ir paleisk iš naujo)");
  }
  return data;
}

/** BENCH-11: the backend report is authoritative; this fetches it read-only, GET only. */
export async function fetchBenchmarkReport(): Promise<BenchmarkReportView> {
  const response = await request("/api/benchmark/report");
  await assertOk(response);
  return await (response.json() as Promise<BenchmarkReportView>);
}

/**
 * `actor` čia SĄMONINGAI nesiunčiamas: jį nustato serveris. Klientas negali liudyti, kas
 * priėmė sprendimą, o append-only audito žurnalas be to liudijimo yra tik pasakojimas.
 */
export async function decidePolicyProposal(
  verb: "approve" | "reject" | "apply",
  input: { policy_file: string; setting_id: string; reason: string },
): Promise<{ proposals: ResolvedProposal[] }> {
  const r = await post(`/api/policies/proposals/${verb}`, {
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  await assertOk(r);
  return await (r.json() as Promise<{ proposals: ResolvedProposal[] }>);
}
