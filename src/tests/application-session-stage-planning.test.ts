// VQ-502 (6/6-c) testai — kieno darbas patenka į Stop commit'ą. Svarbiausia, ką jie pin'ina:
// įrodymų sluoksnių PRIORITETAS (nuosavybė > sesijos baseline > task baseline), clean-baseline
// rescue niekada negrąžina ĮRODYTAI svetimo produkto kelio, o ledger-gap saugiklis veikia TIK
// dispatch'intoje sesijoje ir TIK tada, kai bandymo starto momento nebežinome.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  planSessionStaging,
  type SessionStagingInput,
} from "../application/task-execution/session-stage-planning.js";

const NONCE = "nonce-1";
const TASK = "890";

function input(overrides: Partial<SessionStagingInput> = {}): SessionStagingInput {
  return {
    statusOutput: "",
    sessionWrites: [],
    owners: {},
    sessionBaseline: {},
    taskBaseline: {},
    taskId: TASK,
    dispatchNonce: NONCE,
    ...overrides,
  };
}

test("planSessionStaging: ledger'is + lifecycle stage'inami, svetimas produkto darbas — ne", () => {
  const plan = planSessionStaging(
    input({
      statusOutput: " M src/mine.ts\n M src/theirs.ts\n M vq/architecture/generated/map.json\n",
      sessionWrites: ["src/mine.ts", "src/theirs.ts"],
      owners: { "src/theirs.ts": { sessions: ["kitas-nonce"], tasks: ["999"] } },
    }),
  );

  assert.deepEqual(plan.paths.sort(), ["src/mine.ts", "vq/architecture/generated/map.json"]);
  // Skelbiamas tik realiai purvinas ir realiai paliktas kelias — kitaip tai būtų triukšmas.
  assert.deepEqual(plan.foreign, ["src/theirs.ts"]);
});

test("planSessionStaging: to paties task'o kito bandymo rašymai NĖRA svetimi", () => {
  // Dispatch + repair ciklas yra vienas darbo vienetas (ledger'is per-TASK), tad ankstesnio
  // bandymo sesijos nonce neturi paversti jo darbo svetimu.
  const plan = planSessionStaging(
    input({
      statusOutput: " M src/a.ts\n",
      sessionWrites: ["src/a.ts"],
      owners: { "src/a.ts": { sessions: ["ankstesnis-nonce"], tasks: [TASK] } },
    }),
  );

  assert.deepEqual(plan.paths, ["src/a.ts"]);
  assert.deepEqual(plan.foreign, []);
});

test("planSessionStaging: sesijos baseline VIRŠIJA task baseline, o purvas skaičiuojamas be savo rašymų", () => {
  // Retry sesija mato pirmojo bandymo necommit'intą darbą; jei jis PAAIŠKINTAS ledger'iu,
  // baseline lieka „švarus" ir rescue veikia toliau.
  const clean = planSessionStaging(
    input({
      statusOutput: " M src/a.ts\n M src/gap.ts\n",
      sessionWrites: ["src/a.ts"],
      owners: { "src/a.ts": { sessions: [NONCE], tasks: [TASK] } },
      sessionBaseline: {
        dispatch_nonce: NONCE,
        task_id: TASK,
        baseline_valid: true,
        non_runtime_dirty_entries: [{ status: " M", path: "src/a.ts" }],
      },
    }),
  );
  assert.equal(clean.baselineClean, true);
  assert.deepEqual(clean.paths.sort(), ["src/a.ts", "src/gap.ts"]);
  assert.deepEqual(clean.ledgerMisses, ["src/gap.ts"], "ledger spraga lieka matoma");

  // NEPAAIŠKINTAS purvas starte = gyvas co-tenant'as: rescue išjungiamas, stage'inamas tik ledger'is.
  const dirty = planSessionStaging(
    input({
      statusOutput: " M src/a.ts\n M src/foreign.ts\n",
      sessionWrites: ["src/a.ts"],
      sessionBaseline: {
        dispatch_nonce: NONCE,
        task_id: TASK,
        baseline_valid: true,
        non_runtime_dirty_entries: [{ status: " M", path: "src/foreign.ts" }],
      },
    }),
  );
  assert.equal(dirty.baselineClean, false);
  assert.deepEqual(dirty.paths, ["src/a.ts"]);
});

test("planSessionStaging: clean-baseline rescue NEGRĄŽINA įrodytai svetimo produkto kelio", () => {
  // Baseline sako tik tai, kas buvo MŪSŲ starte; nuosavybė sako, kas failą realiai rašė — ir tai
  // stipresnis įrodymas. Be šito filtro rescue sugriebtų co-tenant'o WIP atgal į commit'ą.
  const plan = planSessionStaging(
    input({
      statusOutput: " M src/a.ts\n M src/theirs.ts\n",
      sessionWrites: ["src/a.ts", "src/theirs.ts"],
      owners: { "src/theirs.ts": { sessions: ["kitas"], tasks: ["999"] } },
      sessionBaseline: { dispatch_nonce: NONCE, task_id: TASK, baseline_valid: true },
    }),
  );

  assert.equal(plan.baselineClean, true);
  assert.deepEqual(plan.paths, ["src/a.ts"]);
  assert.deepEqual(plan.foreign, ["src/theirs.ts"]);
});

test("planSessionStaging: ledger-gap saugiklis tik dispatch'e ir tik be galiojančio savo baseline", () => {
  const lost = {
    statusOutput: " M src/early.ts\n M vq/architecture/generated/map.json\n",
    sessionWrites: [] as string[],
  };

  // Įrodymų sluoksniai sunaikinti bandymo viduryje: plane liktų tik lifecycle, o anksti parašytas
  // failas nebyliai nukristų iš commit'o.
  const rescued = planSessionStaging(input(lost));
  assert.deepEqual(rescued.gap, ["src/early.ts"]);
  assert.deepEqual(rescued.paths.sort(), ["src/early.ts", "vq/architecture/generated/map.json"]);

  // Interaktyvioje sesijoje tapatybės nėra, tad niekas negali būti ĮRODYTA svetimu — saugiklis
  // sušluotų visą medžio purvą į vartotojo commit'ą.
  const interactive = planSessionStaging(input({ ...lost, dispatchNonce: "" }));
  assert.deepEqual(interactive.gap, []);
  assert.deepEqual(interactive.paths, ["vq/architecture/generated/map.json"]);

  // Galiojantis SAVO baseline reiškia, kad apie co-tenant'ą įrodymas YRA — 0056 apsauga lieka
  // stipresnė už saugiklį.
  const known = planSessionStaging(
    input({
      ...lost,
      sessionBaseline: {
        dispatch_nonce: NONCE,
        task_id: TASK,
        baseline_valid: true,
        non_runtime_dirty_entries: [{ status: " M", path: "src/other.ts" }],
      },
    }),
  );
  assert.deepEqual(known.gap, []);
});

test("planSessionStaging: gap saugiklis praleidžia aktyvacijos metu jau purviną failą", () => {
  // Task baseline užrašytas dar prieš šios sesijos startą, tad tie keliai NEGALI būti šio
  // bandymo rašymai — be šios atimties saugiklis sugriebtų co-tenant'o failus.
  const plan = planSessionStaging(
    input({
      statusOutput: " M src/early.ts\n M src/pre-existing.ts\n",
      taskBaseline: {
        task_id: TASK,
        baseline_valid: true,
        non_runtime_dirty_entries: [{ status: " M", path: "src/pre-existing.ts" }],
      },
    }),
  );

  assert.deepEqual(plan.gap, ["src/early.ts"]);

  // SVETIMO task'o baseline nieko neįrodo: jis galėjo būti užrašytas JAU PO mūsų rašymų.
  const foreignBaseline = planSessionStaging(
    input({
      statusOutput: " M src/early.ts\n M src/pre-existing.ts\n",
      taskBaseline: {
        task_id: "999",
        baseline_valid: true,
        non_runtime_dirty_entries: [{ status: " M", path: "src/pre-existing.ts" }],
      },
    }),
  );
  assert.deepEqual(foreignBaseline.gap.sort(), ["src/early.ts", "src/pre-existing.ts"]);
});

test("planSessionStaging: task tapatybė imama iš SAVO baseline, ne iš globalaus current-task-id", () => {
  // Co-tenant'o dispatch'as perrašo globalų `current-task-id`; jei juo pasitikėtume, svetimi
  // keliai mūsų Stop'ui atrodytų kaip „to paties task'o darbas".
  const plan = planSessionStaging(
    input({
      statusOutput: " M src/theirs.ts\n",
      sessionWrites: ["src/theirs.ts"],
      owners: { "src/theirs.ts": { sessions: ["kitas"], tasks: ["999"] } },
      sessionBaseline: { dispatch_nonce: NONCE, task_id: TASK, baseline_valid: true },
      taskId: "999",
    }),
  );

  assert.deepEqual(plan.paths, []);
  assert.deepEqual(plan.foreign, ["src/theirs.ts"]);
});
