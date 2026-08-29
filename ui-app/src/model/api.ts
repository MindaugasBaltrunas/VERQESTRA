import type {
  BenchmarkReportView,
  CompressionFeatureKey,
  CompressionFeatureValue,
  CompressionView,
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
  UiRebuildResult,
  UiWavesView,
  WorkerRequestState,
  WorkflowBucket,
  UploadResult,
} from "./types";
import { parseDashboardData, requireContractFields, type ContractField } from "./dashboardContract";

export function getUiToken(): string {
  return document.querySelector<HTMLMetaElement>('meta[name="vq-ui-token"]')?.content ?? "";
}

/**
 * Užklausos riba. Nė viena UI užklausa neturėjo nei timeout'o, nei `AbortController`, tad pakibęs
 * ar nutilęs serveris palikdavo puslapį suktis amžinai — be klaidos, be „bandyti dar kartą"
 * (2026-08-06 UI auditas). `/api/reliability-analytics?fresh=1` paleidžia git subprocesus, todėl
 * riba yra dosni, bet baigtinė.
 *
 * Invariantas: šis timeout'as PRIVALO likti mažesnis už trumpiausią pollingo periodą (30s —
 * `useDashboardController` REFRESH_SEC ir `useWavesController` WAVES_POLL_MS), kitaip lėtam
 * serveriui dar nenutraukta užklausa persidengia su kitu pollingo ciklu ir `requestSequence`
 * tyliai meta rezultatus (2026-08-28 UI auditas).
 */
export const REQUEST_TIMEOUT_MS = 15_000;

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

/**
 * Atsakymas tikrinamas RUNTIME (`parseDashboardData`), o ne pažymimas `as`: 2026-08-23 UI
 * paleidimo auditas rado, kad serveris grąžindavo `UiControlPlaneData`, o `as DashboardData`
 * tai praleisdavo iki pirmo `data.stopStatus.status` — t. y. iki tuščio ekrano be žinutės.
 */
export async function fetchDashboard(): Promise<DashboardData> {
  const response = await request("/api/dashboard");
  await assertOk(response);
  return parseDashboardData(await (response.json() as Promise<unknown>));
}

/**
 * Laukai, kuriuos `WavesPanel` skaito besąlygiškai (`data.degraded.length`, `data.leases`,
 * `data.last_rejections`, `data.events`). `slots`/`refill_decisions` lieka neprivalomi — panelė
 * juos skaito per `?? []`.
 */
const WAVES_VIEW_FIELDS: readonly ContractField[] = [
  { path: "degraded", kind: "array" },
  { path: "leases", kind: "array" },
  { path: "last_rejections", kind: "array" },
  { path: "events", kind: "array" },
];

export async function fetchWaves(): Promise<UiWavesView> {
  const response = await request("/api/waves");
  await assertOk(response);
  return requireContractFields<UiWavesView>(await response.json(), WAVES_VIEW_FIELDS, "/api/waves");
}

const WORKFLOW_BUCKET_FIELDS: readonly ContractField[] = [
  { path: "name", kind: "string" },
  { path: "tasks", kind: "array" },
];

export async function fetchWorkflowTasks(bucket: string): Promise<WorkflowBucket> {
  const route = `/api/tasks?bucket=${encodeURIComponent(bucket)}`;
  const response = await request(route);
  await assertOk(response);
  return requireContractFields<WorkflowBucket>(await response.json(), WORKFLOW_BUCKET_FIELDS, route);
}

/**
 * Ciklo valdymo atsakymo vokas.
 *
 * Kodėl ne `as { loop: … }`: kai serveris grąžindavo ŽALIĄ rezultatą be `loop` rakto (2026-08-23
 * audito antras ratas), `data.loop` būdavo `undefined`, `result.status` — irgi, ir kontroleris
 * neaptikdavo NĖ VIENO gedimo: `status === "failed"` niekada nesuveikdavo, o ekrane pasirodydavo
 * „paleista". Tylus melas apie ciklo būseną yra blogiausia įmanoma šio mygtuko baigtis.
 */
function requireLoopEnvelope<T extends { status: string }>(payload: unknown, route: string): T {
  const loop = (payload as { loop?: unknown } | null)?.loop;
  if (typeof loop !== "object" || loop === null || typeof (loop as { status?: unknown }).status !== "string") {
    throw new Error(`${route}: serverio atsakyme nėra 'loop' bloko — perkrauk VERQESTRA UI serverį`);
  }
  return loop as T;
}

export async function resumeLoop(): Promise<LoopResult> {
  const r = await post("/tasks/resume");
  await assertOk(r);
  return requireLoopEnvelope<LoopResult>(await r.json(), "/tasks/resume");
}

export async function stopLoop(): Promise<LoopStopResult> {
  const r = await post("/tasks/stop");
  await assertOk(r);
  return requireLoopEnvelope<LoopStopResult>(await r.json(), "/tasks/stop");
}

export async function approveLearningRecommendation(id: string): Promise<void> {
  const r = await post(`/learning/approve/${encodeURIComponent(id)}`);
  await assertOk(r);
}

export async function rejectLearningRecommendation(id: string): Promise<void> {
  const r = await post(`/learning/reject/${encodeURIComponent(id)}`);
  await assertOk(r);
}

const UPLOAD_RESULT_FIELDS: readonly ContractField[] = [
  { path: "saved", kind: "array" },
  { path: "loop", kind: "object" },
];

export async function uploadTaskFiles(files: File[]): Promise<UploadResult> {
  const payload = await Promise.all(files.map(async (f) => ({ name: f.name, content: await f.text() })));
  const r = await post("/tasks/queue/upload", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ files: payload }),
  });
  await assertOk(r);
  return requireContractFields<UploadResult>(await r.json(), UPLOAD_RESULT_FIELDS, "/tasks/queue/upload");
}

export async function openFolder(bucket: string): Promise<void> {
  const r = await post(`/folders/open/${encodeURIComponent(bucket)}`);
  await assertOk(r);
}

export async function proposePolicy(
  route: string,
  payload: { setting_id: string; requested_value: unknown },
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
const WORKER_REQUEST_FIELDS: readonly ContractField[] = [
  { path: "worker_request", kind: "object" },
  { path: "worker_request.requested", kind: "number" },
  { path: "worker_request.source", kind: "string" },
];

export async function setRequestedWorkers(requested: number): Promise<{ worker_request: WorkerRequestState }> {
  const r = await post("/api/runtime/workers", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ requested }),
  });
  await assertOk(r);
  return requireContractFields<{ worker_request: WorkerRequestState }>(
    await r.json(),
    WORKER_REQUEST_FIELDS,
    "/api/runtime/workers",
  );
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
  return requireLoopEnvelope<LoopResult>(await r.json(), "/api/runtime/loop/start");
}

const UI_REBUILD_STATUSES = ["already-running", "started", "failed", "disabled"] as const;

/**
 * UI bundle rebuild paleidimas (`pnpm --dir ui-app build`, task 058). Kūno nesiunčia — komanda
 * fiksuota serveryje. `disabled` reiškia, kad composition adapteris dar nesurištas, ne klaidą.
 */
export async function rebuildUiBundle(): Promise<UiRebuildResult> {
  const r = await post("/api/ui/rebuild");
  await assertOk(r);
  const payload = (await r.json()) as { status?: unknown };
  const statuses: readonly string[] = UI_REBUILD_STATUSES;
  if (typeof payload.status !== "string" || !statuses.includes(payload.status)) {
    throw new Error("/api/ui/rebuild: serverio atsakyme nėra žinomo 'status' lauko — perkrauk VERQESTRA UI serverį");
  }
  return payload as UiRebuildResult;
}

/**
 * Perjungia worktree izoliacijos politiką — W2 lygiagretumo jungiklis (task 088-c-04).
 *
 * Kūnas yra LYGIAI vienas laukas: serveris (`interfaces/http/ui-router-mutations.ts`) bet kokį kitą
 * atmeta 400-uku, o `assertOk` perduoda jo paaiškinimą nepakeistą. Nei konfigo kelio, nei
 * `.gitignore` kelio klientas nesiunčia — abu gimsta serveryje.
 *
 * Atsakymo kūnas ČIA sąmoningai neskaitomas: naują būseną ekranas pasiima pakartotiniu
 * `fetchWaves()`, kad rodytų TĄ PATĮ šaltinį, kurį kitą bangą skaitys planuoklė — o ne mutacijos
 * atsakymą, liudijantį tik apie įrašytą norą. 404 reiškia, kad composition politikos porto
 * nesurišo; `assertOk` tai paverčia matoma klaida, o ne tyliu „pavyko".
 */
export async function setWorktreePolicyEnabled(enabled: boolean): Promise<void> {
  const r = await post("/api/runtime/worktree-policy", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  await assertOk(r);
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

/**
 * Pasiūlymų sąrašas. `proposals` PRIVALO būti masyvas: kai serveris grąžindavo žalią žurnalo
 * sąrašą be voko, `next.proposals` būdavo `undefined`, panelė likdavo amžinai „Įkeliama…", ir
 * operatorius neturėdavo net klaidos, iš kurios suprastų, kad kažkas negerai.
 */
function requireProposals(payload: unknown, route: string): { proposals: ResolvedProposal[] } {
  const proposals = (payload as { proposals?: unknown } | null)?.proposals;
  if (!Array.isArray(proposals)) {
    throw new Error(`${route}: serverio atsakyme nėra 'proposals' sąrašo — perkrauk VERQESTRA UI serverį`);
  }
  return { proposals: proposals as ResolvedProposal[] };
}

export async function fetchPolicyProposals(): Promise<{ proposals: ResolvedProposal[] }> {
  const response = await request("/api/policies/proposals");
  await assertOk(response);
  return requireProposals(await response.json(), "/api/policies/proposals");
}

/** `pagination` liktų neprivalomas net kontrakte — kontroleris jį skaito tik per `?.`. */
const TOKEN_USAGE_FIELDS: readonly ContractField[] = [{ path: "records", kind: "array" }];

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
  return requireContractFields<TokenUsageQueryResponse>(await response.json(), TOKEN_USAGE_FIELDS, "/api/token-usage");
}

const TOKEN_ANALYTICS_FIELDS: readonly ContractField[] = [
  { path: "groups", kind: "array" },
  { path: "candidates", kind: "array" },
  { path: "history", kind: "array" },
];

export async function fetchTokenAnalytics(): Promise<TokenAnalyticsResponse> {
  const response = await request("/api/token-analytics");
  await assertOk(response);
  return requireContractFields<TokenAnalyticsResponse>(await response.json(), TOKEN_ANALYTICS_FIELDS, "/api/token-analytics");
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

/**
 * Laukai, be kurių `BenchmarkPage` griūva: `data.state`/`data.source.command` skaitomi be
 * apsaugos, kai `state` yra `"missing"`/`"corrupt"`. `report` lieka neprivalomas — tipe jis
 * `?:`, o puslapis jo laukia po `data && report &&` sąlyga.
 */
const BENCHMARK_REPORT_FIELDS: readonly ContractField[] = [
  { path: "state", kind: "string" },
  { path: "source", kind: "object" },
];

/** BENCH-11: the backend report is authoritative; this fetches it read-only, GET only. */
export async function fetchBenchmarkReport(): Promise<BenchmarkReportView> {
  const response = await request("/api/benchmark/report");
  await assertOk(response);
  return requireContractFields<BenchmarkReportView>(await response.json(), BENCHMARK_REPORT_FIELDS, "/api/benchmark/report");
}

/**
 * `actor` čia SĄMONINGAI nesiunčiamas: jį nustato serveris. Klientas negali liudyti, kas
 * priėmė sprendimą, o append-only audito žurnalas be to liudijimo yra tik pasakojimas.
 *
 * `cancel` naudoja TĄ PATĮ endpoint'ą — maršruto verb'as yra vienintelis skirtumas. Iš galutinės
 * būsenos (`applied`/`rejected`/jau `cancelled`) serveris atsako 409, ir `assertOk` perduoda jo
 * paaiškinimą nepakeistą: būsenos konfliktas priklauso serveriui, nes tik jis mato žurnalą.
 */
export async function decidePolicyProposal(
  verb: "approve" | "reject" | "apply" | "cancel",
  input: { policy_file: string; setting_id: string; reason: string },
): Promise<{ proposals: ResolvedProposal[] }> {
  const r = await post(`/api/policies/proposals/${verb}`, {
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  await assertOk(r);
  return requireProposals(await r.json(), `/api/policies/proposals/${verb}`);
}

/** Laukai, kuriuos `CompressionPage` skaito be apsaugos (`data.decision.pressure.level` ir kt.). */
const COMPRESSION_FIELDS: readonly ContractField[] = [
  { path: "canary", kind: "object" },
  { path: "features", kind: "array" },
  { path: "telemetry", kind: "object" },
  { path: "decision", kind: "object" },
  { path: "decision.pressure", kind: "object" },
  { path: "decision.recommendations", kind: "array" },
  { path: "degraded", kind: "array" },
];

/** Kompresijos vėliavos ir jų shadow telemetrija. */
export async function fetchCompression(): Promise<CompressionView> {
  const response = await request("/api/compression");
  await assertOk(response);
  return requireContractFields<CompressionView>(await response.json(), COMPRESSION_FIELDS, "/api/compression");
}

/**
 * Perjungia VIENĄ vėliavą.
 *
 * Atsakymo kūnas neskaitomas: naują būseną kontroleris pasiima pakartotiniu `fetchCompression`,
 * kad ekranas rodytų TĄ PATĮ šaltinį, kurį matys kitas dispatch'as — o ne mutacijos atsakymą,
 * liudijantį tik apie įrašytą norą. Neleistiną reikšmę serveris atmeta 400-uku, ir `assertOk`
 * perduoda jo paaiškinimą nepakeistą.
 */
export async function setCompressionFeature(
  feature: CompressionFeatureKey,
  value: CompressionFeatureValue,
): Promise<void> {
  const r = await post(`/api/compression/features/${encodeURIComponent(feature)}`, {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value }),
  });
  await assertOk(r);
}
