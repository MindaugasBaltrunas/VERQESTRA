// Politikų governance PER DASHBOARD'Ą — realūs adapteriai, realūs failai (2026-08-23 UI audito
// antras ratas).
//
// Ką šis failas pin'ina ir kodėl. Iki audito UI politikų maršrutai buvo prijungti prie žalio
// append-only žurnalo, o visas `policy-proposal-service` sluoksnis — su `ProposalNotApproved` ir
// `HumanReviewApprovalRequired` vartais — gulėjo nepanaudotas. Pasekmė: `approve`/`reject`/`apply`
// grįždavo 500, `apply` niekada nerašė politikos failo, o pasiūlymo `routing` ateidavo IŠ KLIENTO.
// Visi keturi teiginiai čia tikrinami tikru srautu, o ne fake'ais: fake'ai būtų atkartoję būtent
// tą prielaidą, kuri ir buvo klaidinga.

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { handleUiRequest, type UiRouteResponse } from "../interfaces/http/ui-router.js";
import { uiRouterPorts } from "../composition/ui/router-adapters.js";
import { humanReviewApprovalMarkerPath } from "../application/policy-governance/policy-proposal-service.js";

const TOKEN = "policy-governance-token";

type Sandbox = { projectRoot: string; runtimeRoot: string; agRoot: string };

/**
 * `global_policy_changes_require_human_review: false` — tai VIENINTELIS jungiklis, per kurį
 * `coding-principles` pasiūlymas gauna `routing: "queue"` ir gali būti pritaikytas iš UI.
 * Numatytoji reikšmė yra `true`, tad be šio failo net `approve → apply` sustotų ties 403.
 */
async function makeSandbox(options: { humanReview: boolean } = { humanReview: true }): Promise<Sandbox> {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "vq-ui-policy-"));
  const runtimeRoot = path.join(projectRoot, "vq");
  const agRoot = path.join(projectRoot, "AG");
  await mkdir(path.join(runtimeRoot, "architecture"), { recursive: true });
  await mkdir(path.join(agRoot, "tasks", "queue"), { recursive: true });
  await writeFile(
    path.join(runtimeRoot, "architecture", "enforcement-policy.json"),
    JSON.stringify({ global_policy_changes_require_human_review: options.humanReview }),
    "utf8",
  );
  return { projectRoot, runtimeRoot, agRoot };
}

function route(sandbox: Sandbox, method: string, url: string, body: unknown = null): Promise<UiRouteResponse> {
  const ports = uiRouterPorts({ ...sandbox, logError: () => {} });
  return handleUiRequest(
    { ports, projectRoot: sandbox.projectRoot, uiToken: TOKEN, eventLimitFromQuery: () => 50 },
    {
      method,
      url,
      headers: { host: "127.0.0.1:4173", "x-vq-ui-token": TOKEN },
      readJsonBody: () => Promise.resolve(body),
      readRawBody: () => Promise.resolve(""),
    },
  );
}

function jsonData(response: UiRouteResponse): Record<string, unknown> {
  assert.equal(response.kind, "json");
  return (response as { data: Record<string, unknown> }).data;
}

/** Statusas iš JSON/text atsakymo; statiniai maršrutai čia niekada neatsiranda. */
function statusOf(response: UiRouteResponse): number {
  assert.notEqual(response.kind, "static", "politikų maršrutas negali virsti statiniu failu");
  return (response as { status: number }).status;
}

const CODING_PRINCIPLES = "vq/architecture/coding-principles.json";
const DECISION_BODY = { policy_file: CODING_PRINCIPLES, setting_id: "dry", reason: "auditas" };

test("pilnas srautas: pasiūlymas → patvirtinimas → taikymas RAŠO politikos failą", async () => {
  const sandbox = await makeSandbox({ humanReview: false });
  try {
    const proposed = await route(sandbox, "POST", "/api/policies/coding-principles/set", {
      setting_id: "dry",
      requested_value: "block",
      reason: "auditas",
      // Klientas bando padiktuoti maršrutą ir seną reikšmę — abu privalo būti IGNORUOJAMI.
      routing: "queue",
      old_value: "melas",
    });
    assert.equal(statusOf(proposed), 200);
    const proposal = jsonData(proposed)["proposal"] as Record<string, unknown>;
    assert.equal(proposal["policy_file"], CODING_PRINCIPLES);
    // `old_value` ateina iš politikų loaderio, ne iš kūno.
    assert.notEqual(proposal["old_value"], "melas");
    assert.equal(proposal["routing"], "queue");

    // Sąrašo forma yra `{ proposals }` su išspręsta būsena — būtent tai skaito `ui-app`.
    const listed = jsonData(await route(sandbox, "GET", "/api/policies/proposals"));
    const proposals = listed["proposals"] as { status: string }[];
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0]?.status, "pending");

    // `apply` PRIEŠ patvirtinimą yra būsenos konfliktas, ne serverio gedimas.
    assert.equal(statusOf(await route(sandbox, "POST", "/api/policies/proposals/apply", DECISION_BODY)), 409);

    const approved = jsonData(await route(sandbox, "POST", "/api/policies/proposals/approve", DECISION_BODY));
    assert.equal((approved["proposals"] as { status: string }[])[0]?.status, "approved");

    const applied = await route(sandbox, "POST", "/api/policies/proposals/apply", DECISION_BODY);
    assert.equal(statusOf(applied), 200);
    assert.equal((jsonData(applied)["proposals"] as { status: string }[])[0]?.status, "applied");

    // ĮRODYMAS, kad `apply` nėra vien žurnalo įrašas: politikos failas diske pasikeitė.
    const policy = JSON.parse(
      await readFile(path.join(sandbox.runtimeRoot, "architecture", "coding-principles.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.equal(policy["dry"], "block");

    // Sprendimo autorius yra SERVERIS: klientas negali liudyti, kas priėmė sprendimą.
    const decisions = await readFile(path.join(sandbox.runtimeRoot, "state", "policy", "decisions.jsonl"), "utf8");
    assert.equal(decisions.includes('"actor":"ui-local"'), true);
  } finally {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  }
});

test("human-review maršrutas: patvirtintas pasiūlymas NEPRITAIKOMAS be žmogaus žymės", async () => {
  const sandbox = await makeSandbox({ humanReview: true });
  try {
    const proposed = jsonData(
      await route(sandbox, "POST", "/api/policies/coding-principles/set", {
        setting_id: "dry",
        requested_value: "block",
        reason: "auditas",
      }),
    );
    assert.equal((proposed["proposal"] as Record<string, unknown>)["routing"], "human-review");

    await route(sandbox, "POST", "/api/policies/proposals/approve", DECISION_BODY);
    const blocked = await route(sandbox, "POST", "/api/policies/proposals/apply", DECISION_BODY);

    // 403, o ne 409: tai ne būsenos konfliktas, o atsisakymas suteikti teisę — pasiūlymas
    // maršrutizuotas į human-review, o UI nėra tas žmogus.
    assert.equal(statusOf(blocked), 403);

    // Žinutė privalo pasakyti, KUR sukurti žymę — bet REPO-RELIATYVIAI. Absoliutus kelias neša
    // disko raidę, vartotojo vardą ir įdiegimo vietą, t. y. tą patį, ką `free-text-redaction`
    // sąmoningai kerpa iš bangų vaizdo (2026-08-24 auditas, penktas ratas).
    const message = JSON.stringify(jsonData(blocked));
    assert.match(message, /vq\/state\/policy-approvals\//, "kelias privalo likti veiksmingas");
    assert.doesNotMatch(message, /[A-Za-z]:[\\/]/, "disko raidė į naršyklę neišeina");
    assert.equal(message.includes(sandbox.projectRoot.replace(/\\/g, "\\\\")), false, "šaknis neišeina");
    // Politikos failas NEPARAŠYTAS: vartai stovi PRIEŠ rašymą, ne po jo.
    await assert.rejects(() => readFile(path.join(sandbox.runtimeRoot, "architecture", "coding-principles.json"), "utf8"));

    // Žymę gali sukurti tik žmogus savo terminale (ji gyvena po vq/state, kurį saugo rašymo guard'as).
    const marker = humanReviewApprovalMarkerPath(sandbox.runtimeRoot, CODING_PRINCIPLES, "dry");
    await mkdir(path.dirname(marker), { recursive: true });
    await writeFile(marker, "approved by operator\n", "utf8");

    assert.equal(statusOf(await route(sandbox, "POST", "/api/policies/proposals/apply", DECISION_BODY)), 200);
    const policy = JSON.parse(
      await readFile(path.join(sandbox.runtimeRoot, "architecture", "coding-principles.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.equal(policy["dry"], "block");
  } finally {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  }
});

test("netinkama siūloma reikšmė yra 400 su paaiškinimu, o ne 500", async () => {
  const sandbox = await makeSandbox({ humanReview: false });
  try {
    // NUKRYPIMAS nuo etalono, griežtinantis: etalone schemos klaida krisdavo į bendrą 500.
    const response = await route(sandbox, "POST", "/api/policies/coding-principles/set", {
      setting_id: "dry",
      requested_value: "error",
      reason: "auditas",
    });
    assert.equal(statusOf(response), 400);
    // Pasiūlymo žurnale NIEKO neatsirado: validacija vyksta PRIEŠ rašymą.
    const listed = jsonData(await route(sandbox, "GET", "/api/policies/proposals"));
    assert.deepEqual(listed["proposals"], []);
  } finally {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  }
});

/**
 * `reason` NEBEPRIVALOMAS propose šakoje (operatoriaus patvirtintas kontrakto pakeitimas,
 * 2026-08-28). Tikrinama per TIKRĄ srautą, o ne per fake portą: teiginys yra ne „maršrutas
 * praleido", o „žurnale atsirado įrašas su `reason: ""`" — schema (`policyProposalSchema`)
 * validuoja PRIEŠ rašymą, tad 200 be žurnalo įrašo būtų tuščias sėkmės pranešimas.
 *
 * `setting_id` lieka vienintelis privalomas laukas: be jo pasiūlymas neturi objekto.
 */
test("pasiūlymas be `reason` priimamas ir įrašomas kaip tuščias, o be `setting_id` — 400", async () => {
  const sandbox = await makeSandbox({ humanReview: false });
  try {
    const proposed = await route(sandbox, "POST", "/api/policies/coding-principles/set", {
      setting_id: "dry",
      requested_value: "block",
    });
    assert.equal(statusOf(proposed), 200);
    assert.equal((jsonData(proposed)["proposal"] as Record<string, unknown>)["reason"], "");

    // Tuščias tekstas yra tas pats atvejis, kaip trūkstamas laukas — abu virsta `""`.
    const blank = await route(sandbox, "POST", "/api/policies/coding-principles/set", {
      setting_id: "dry",
      requested_value: "warn",
      reason: "   ",
    });
    assert.equal(statusOf(blank), 200);
    assert.equal((jsonData(blank)["proposal"] as Record<string, unknown>)["reason"], "");

    // Append-only žurnalas — ne tik atsakymas — turi abu įrašus su tuščia priežastimi.
    const journal = await readFile(path.join(sandbox.runtimeRoot, "state", "policy", "proposals.jsonl"), "utf8");
    const rows = journal.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => row["reason"]), ["", ""]);

    // `setting_id` vartai NEATLAISVINTI: 400 ir NIEKO naujo žurnale.
    const missing = await route(sandbox, "POST", "/api/policies/coding-principles/set", {
      requested_value: "block",
      reason: "auditas",
    });
    assert.equal(statusOf(missing), 400);
    assert.match(JSON.stringify(jsonData(missing)), /setting_id/);
    assert.equal((jsonData(await route(sandbox, "GET", "/api/policies/proposals"))["proposals"] as unknown[]).length, 2);
  } finally {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  }
});

test("nežinomas policy failas yra 400, o ne 500", async () => {
  const sandbox = await makeSandbox();
  try {
    const response = await route(sandbox, "POST", "/api/policies/proposals/approve", {
      policy_file: "vq/nezinomas.json",
      setting_id: "dry",
      reason: "auditas",
    });
    assert.equal(statusOf(response), 400);
    assert.match(JSON.stringify(jsonData(response)), /Unsupported policy file/);
  } finally {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  }
});
