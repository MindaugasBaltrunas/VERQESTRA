// Dashboard'o MUTACIJOS (`POST`) — etalonas: AG_loop interfaces/http/ui-server.ts mutacijų blokas.
//
// Bendra šio failo taisyklė, skirianti jį nuo skaitymų: mutacija privalo kristi GARSIAI. Skaitymo
// pusėje sugadintas artefaktas virsta degradavusiu bloku, nes dashboard'as yra diagnostikos
// paviršius; čia priešingai — tylus „nepavyko" reikštų operatoriaus paspaustą mygtuką be pasekmės.
//
// Antra taisyklė: ATSAKYMO FORMA yra kliento kontraktas. `ui-app/src/model/api.ts` skaito
// `data.loop`, `data.worker_request`, `data.proposals` — bendrinis kūnas be šių raktų klientui
// atrodo kaip `undefined`, ir jis parodo sėkmę ten, kur jos nebuvo. 2026-08-23 UI audito antras
// ratas rado būtent tai keturiuose maršrutuose.

import {
  INTERNAL_ERROR_RESPONSE,
  mapJsonBodyError,
  mapPolicyDecisionError,
  mapRuntimeControlError,
  mapTaskTriageError,
  mapUploadError,
} from "./ui-error-mapping.js";
import {
  decodeSegment,
  json,
  requiredText,
  toResponse,
  type PolicyDecisionRequest,
  type UiPolicyDecisionVerb,
  type UiRouteRequest,
  type UiRouteResponse,
  type UiRouterDeps,
} from "./ui-router-model.js";
import { InvalidCompressionRequestError } from "./ui-compression-mutation.js";
import type { PolicyProposalGroup } from "../../application/policy-governance/policy-file-registry.js";
import type { TaskTriageAction } from "./ui-task-actions.js";

const POLICY_GROUP_ROUTE = /^\/api\/policies\/(architecture-style|coding-principles|enforcement)\/set$/;
const PROPOSAL_DECISION_ROUTE = /^\/api\/policies\/proposals\/(approve|reject|apply|cancel)$/;
const SLOT_MODE_ROUTE = /^\/api\/runtime\/loop\/slots\/([^/]+)$/;
const COMPRESSION_FEATURE_ROUTE = /^\/api\/compression\/features\/([^/]+)$/;
const TASK_TRIAGE_ROUTE = /^\/api\/tasks\/(requeue|complete)\/(.+)$/;
const LEARNING_DECISION_ROUTE = /^\/learning\/(approve|reject)\/(.+)$/;
const FOLDER_OPEN_ROUTE = /^\/folders\/open\/(.+)$/;

function badRequest(message: string): UiRouteResponse {
  return { kind: "json", status: 400, data: { error: message } };
}

/**
 * Klaida → atsakymas su ŽURNALO eilute tik neatpažintam gedimui.
 *
 * Atpažinta vartotojo klaida (400/403/409) žurnale yra triukšmas — jos priežastis jau keliauja
 * klientui. Neatpažinta virsta 500 BE detalių, tad be šios eilutės ji nepaliktų pėdsako niekur.
 */
function mapped(
  deps: UiRouterDeps,
  error: unknown,
  map: (error: unknown) => { status: number; body?: { error: string } | undefined; text?: string | undefined },
): UiRouteResponse {
  const response = map(error);
  if (response.status >= 500) {
    deps.ports.logError(`[ui] request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return toResponse(response);
}

export async function handlePost(
  deps: UiRouterDeps,
  pathname: string,
  request: UiRouteRequest,
): Promise<UiRouteResponse | undefined> {
  const ports = deps.ports;

  const withJsonBody = async (
    run: (body: unknown) => Promise<UiRouteResponse>,
  ): Promise<UiRouteResponse> => {
    let body: unknown;
    try {
      body = await request.readJsonBody();
    } catch (error) {
      return toResponse(mapJsonBodyError(error instanceof Error && error.name === "RequestBodyTooLargeError"));
    }
    try {
      return await run(body);
    } catch (error) {
      ports.logError(`[ui] request failed: ${error instanceof Error ? error.message : String(error)}`);
      return toResponse(INTERNAL_ERROR_RESPONSE);
    }
  };

  if (pathname === "/tasks/queue/upload") {
    let saved: string[];
    try {
      saved = await ports.uploadQueueFiles(await request.readRawBody());
    } catch (error) {
      return toResponse(mapUploadError(error));
    }
    // Užduotys JAU išsaugotos: loop paleidimo klaida nebepaverčia viso atsakymo 500 — klientas turi
    // sužinoti, kad failai eilėje, net jei loop'as nepasileido.
    let loop: unknown;
    try {
      loop = await ports.ensureLoopRunning();
    } catch (error) {
      loop = { status: "failed", reason: error instanceof Error ? error.message : String(error) };
    }
    return json({ saved, loop }, 201);
  }

  // `{ loop }`, o ne žalias rezultatas: klientas (`api.ts#resumeLoop`) skaito BŪTENT šį raktą, ir
  // be jo `result.status` yra `undefined` — nepavykęs paleidimas ekrane atrodo kaip sėkmė.
  if (pathname === "/tasks/resume") {
    return json({ loop: await ports.ensureLoopRunning() });
  }

  if (pathname === "/tasks/stop") {
    const loop = await ports.requestLoopStop();
    // Abu slot'ai kartu pereina į `drain`: stop vėliava sustabdo loop'ą TARP task'ų, bet slot'ų
    // valdiklis liktų rodyti `run` — snapshot'as prieštarautų tikrovei, ir „Start" po „Stop"
    // atrodytų kaip valdiklio klaida. Vėliava JAU įrašyta, tad valdiklio rašymo klaida negali
    // paversti viso atsakymo 500-uku: `null` reiškia „valdiklio būsenos nežinome".
    const loopControl = await ports.drainAllSlots().catch(() => null);
    return json({ loop, loop_control: loopControl });
  }

  if (pathname === "/api/runtime/workers") {
    return await withJsonBody(async (body) => {
      try {
        // Kūnas paduodamas VISAS: `.strict()` schema atmeta ir nežinomus laukus, ir `null`.
        return json({ worker_request: await ports.setRequestedWorkers(body) });
      } catch (error) {
        return mapped(deps, error, mapRuntimeControlError);
      }
    });
  }

  if (pathname === "/api/runtime/loop/start") return await startLoopWithWorkers(deps, request, withJsonBody);

  if (pathname === "/api/ui/rebuild") return await startUiRebuild(deps);

  const policyGroup = POLICY_GROUP_ROUTE.exec(pathname);
  if (policyGroup?.[1]) return await proposePolicyChange(deps, policyGroup[1] as PolicyProposalGroup, withJsonBody);

  const decision = PROPOSAL_DECISION_ROUTE.exec(pathname);
  if (decision?.[1]) return await decidePolicyProposal(deps, decision[1] as UiPolicyDecisionVerb, withJsonBody);

  // Kelias yra KLIENTO kontraktas, ne serverio skonis: `ui-app/src/model/api.ts` kviečia būtent
  // `/api/runtime/loop/slots/<workerId>`, ir tą patį daro etalonas. VQ-503 metu čia buvo atsiradęs
  // `/api/runtime/slots/<workerId>/mode` — nedokumentuotas nuokrypis, kurio niekas nepamatė, nes
  // dashboard'o dar nebuvo. VQ-601 jį atstatė: maršruto pervadinimas be kliento yra tylus lūžis.
  const slotMode = SLOT_MODE_ROUTE.exec(pathname);
  if (slotMode?.[1]) {
    const workerId = decodeSegment(slotMode[1]);
    return await withJsonBody(async (body) => {
      try {
        return json(await ports.setSlotMode(workerId, body));
      } catch (error) {
        return mapped(deps, error, mapRuntimeControlError);
      }
    });
  }

  const compressionFeature = COMPRESSION_FEATURE_ROUTE.exec(pathname);
  if (compressionFeature?.[1]) {
    const feature = decodeSegment(compressionFeature[1]);
    return await withJsonBody(async (body) => {
      try {
        return json({ config: await ports.setCompressionFeature(feature, (body as { value?: unknown }).value) });
      } catch (error) {
        // Nežinomas raktas ir neleistina reikšmė yra KLIENTO klaidos: 400 su domeno paaiškinimu.
        // 500 čia reikštų „serveris sugedo", ir operatorius ieškotų gedimo ten, kur jo nėra.
        if (error instanceof InvalidCompressionRequestError) {
          return { kind: "json", status: 400, data: { error: error.message } };
        }
        // Domeno validatorius meta paprastą `Error` su `… validation failed: …` — irgi kliento klaida.
        if (error instanceof Error && /validation failed:/.test(error.message)) {
          return { kind: "json", status: 400, data: { error: error.message } };
        }
        ports.logError(`[ui] request failed: ${error instanceof Error ? error.message : String(error)}`);
        return toResponse(INTERNAL_ERROR_RESPONSE);
      }
    });
  }

  const triage = TASK_TRIAGE_ROUTE.exec(pathname);
  if (triage?.[1] && triage[2]) {
    const action = triage[1] as TaskTriageAction;
    try {
      return json(await ports.applyTaskTriage(action, decodeSegment(triage[2])));
    } catch (error) {
      return toResponse(mapTaskTriageError(error));
    }
  }

  const learning = LEARNING_DECISION_ROUTE.exec(pathname);
  if (learning?.[1] && learning[2]) {
    const verdict = learning[1] === "approve" ? "approved" : "rejected";
    try {
      return json({ record: await ports.decideLearningRecommendation(decodeSegment(learning[2]), verdict) });
    } catch (error) {
      ports.logError(`[ui] request failed: ${error instanceof Error ? error.message : String(error)}`);
      return toResponse(INTERNAL_ERROR_RESPONSE);
    }
  }

  const folder = FOLDER_OPEN_ROUTE.exec(pathname);
  if (folder?.[1]) {
    // Nežinomas bucket'as yra 404, o ne bandymas atidaryti laisvos formos kelią.
    const opened = await ports.openTaskBucketFolder(decodeSegment(folder[1]));
    return { kind: "empty", status: opened ? 204 : 404 };
  }

  return undefined;
}

type WithJsonBody = (run: (body: unknown) => Promise<UiRouteResponse>) => Promise<UiRouteResponse>;

/**
 * Loop'o paleidimas su AIŠKIU srautų skaičiumi. Trys žingsniai viena tvarka: prašymas → valdiklio
 * atstatymas → procesas.
 *
 * Iki 2026-08-23 UI audito antro rato šis maršrutas kūno NESKAITĖ: operatoriaus „paleisti 2 srautus"
 * dingdavo tyliai, valdiklis likdavo su senu `drain`, tad ką tik paleistas loop'as atsisakydavo
 * pirmo task'o, o klientas rodydavo „Ciklas paleistas su 2 srautais" — melą apie tai, kas įvyko.
 */
async function startLoopWithWorkers(
  deps: UiRouterDeps,
  _request: UiRouteRequest,
  withJsonBody: WithJsonBody,
): Promise<UiRouteResponse> {
  const ports = deps.ports;
  return await withJsonBody(async (body) => {
    const { workers, ...rest } = { ...((body ?? {}) as Record<string, unknown>) };
    // `requested` yra ŠIO maršruto kontraktui nežinomas laukas ir vienintelis, kurio `.strict()`
    // pagauti NEGALI: po persivadinimo jis sutampa su tiksliniu raktu, tad klientas galėtų
    // persirašyti maršruto kontraktą. Atmetama aiškiai.
    if (Object.hasOwn(rest, "requested")) return badRequest("unknown field: requested (use workers)");
    try {
      const workerRequest = await ports.setRequestedWorkers({ ...rest, requested: workers });
      const loopControl = await ports.resetLoopControl();
      const loop = await ports.ensureLoopRunning();
      return json({ loop, worker_request: workerRequest, loop_control: loopControl });
    } catch (error) {
      return mapped(deps, error, mapRuntimeControlError);
    }
  });
}

/**
 * UI bundle rebuild paleidimas. Kūno neskaito — komanda fiksuota kode (`ui-rebuild.ts`), tad
 * request'e nėra ką validuoti. Portas OPTIONAL: composition realaus spawn'o adapterį suriša
 * sekanti užduotis, iki tol maršrutas atsako `disabled`, o ne 500.
 */
async function startUiRebuild(deps: UiRouterDeps): Promise<UiRouteResponse> {
  if (!deps.ports.uiRebuild) return json({ status: "disabled" });
  try {
    return json(await deps.ports.uiRebuild.start());
  } catch (error) {
    deps.ports.logError(`[ui] request failed: ${error instanceof Error ? error.message : String(error)}`);
    return toResponse(INTERNAL_ERROR_RESPONSE);
  }
}

/**
 * Politikos pakeitimo pasiūlymas.
 *
 * Klientas paduoda TIK `setting_id`, `requested_value` ir — NEPRIVALOMAI — `reason`. `old_value`,
 * `timestamp` ir — svarbiausia — `routing` nustato SERVERIS: suklastotas `routing: "queue"` apeitų
 * human-review vartus prie `apply`, o pasiūlymo žurnalas taptų pasakojimu, ne įrodymu.
 *
 * `reason` privalomumo nebeliko (operatoriaus patvirtintas kontrakto pakeitimas, 2026-08-28):
 * trūkstamas ar tuščias virsta `""`, kaip jau daro application sluoksnis (`buildPolicyProposal`
 * priima `reason?`). Priverstinis laukas nedavė audito vertės — jį buvo galima užpildyti bet kuo,
 * o vienintelė reali pasekmė buvo 400 operatoriui, spustelėjusiam politikos valdiklį. VIENINTELIS
 * 400 čia lieka dėl `setting_id`: be jo pasiūlymas neturi objekto.
 */
async function proposePolicyChange(
  deps: UiRouterDeps,
  group: PolicyProposalGroup,
  withJsonBody: WithJsonBody,
): Promise<UiRouteResponse> {
  return await withJsonBody(async (body) => {
    const settingId = requiredText(body, "setting_id");
    if (!settingId) return badRequest("setting_id is a required non-empty string");
    const reason = requiredText(body, "reason") ?? "";
    const requestedValue = (body as Record<string, unknown>)["requested_value"];
    try {
      return json(
        await deps.ports.proposePolicyChange(group, {
          setting_id: settingId,
          requested_value: requestedValue,
          reason,
        }),
      );
    } catch (error) {
      return mapped(deps, error, mapPolicyDecisionError);
    }
  });
}

/**
 * Pasiūlymo sprendimas (approve / reject / apply / cancel).
 *
 * `actor` čia NEPRIIMAMAS iš kliento: serveris gali sąžiningai paliudyti tik tiek, kad sprendimas
 * atėjo per lokalų UI. Append-only audito žurnalas, kuriame bet kas gali pasirašyti bet kokiu
 * vardu, nėra auditas.
 *
 * `cancel` čia NIEKUO neišsiskiria: leistinos pradinės būsenos (`pending`/`approved`) yra
 * application taisyklė, o ne maršruto — router'is tik perduoda verbą portui ir atvaizduoja
 * `ProposalCancelConflictError` į 409 per tą patį `mapPolicyDecisionError`. Būsenos tikrinimas
 * čia reikštų dvi tiesos vietas, iš kurių HTTP pusė pasentų tyliai.
 */
async function decidePolicyProposal(
  deps: UiRouterDeps,
  verb: UiPolicyDecisionVerb,
  withJsonBody: WithJsonBody,
): Promise<UiRouteResponse> {
  return await withJsonBody(async (body) => {
    const policyFile = requiredText(body, "policy_file");
    const settingId = requiredText(body, "setting_id");
    const reason = requiredText(body, "reason");
    if (!policyFile || !settingId || !reason) {
      return badRequest("policy_file, setting_id and reason are required non-empty strings");
    }
    const input: PolicyDecisionRequest = { policy_file: policyFile, setting_id: settingId, reason };
    try {
      return json(await deps.ports.decidePolicyProposal(verb, input));
    } catch (error) {
      return mapped(deps, error, mapPolicyDecisionError);
    }
  });
}
