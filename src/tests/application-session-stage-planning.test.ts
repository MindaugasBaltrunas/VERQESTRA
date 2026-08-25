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

// 020-a-02 (R1 iš 020 diagnozės): ledger'is yra įrankio kilmės — Bash/PowerShell parašytas darbas
// jam nematomas, o abu senieji saugikliai kaip tik ilgame bandyme išsijungia (rescue reikalauja
// švaraus baseline'o, gap — kad savo baseline'o nebebūtų). Fallback'as dengia likusią spragą
// SCOPE įrodymu: visi purvini produkto keliai privalo tilpti į task'o Leidžiama aibę.
test("planSessionStaging: 018 regresija — Bash rašytas darbas grįžta per allowed-paths fallback", () => {
  // NEDENGTOJI zona, kurią vardija 020 diagnozė: SAVO baseline galioja (attemptStartKnown=true —
  // gap saugiklis IŠJUNGTAS), bet jis PURVINAS nepaaiškintu purvu (daugiaetapio bandymo ankstesnės
  // stadijos darbas; ledger'is tuščias, tad nepaaiškinamas) — rescue irgi IŠJUNGTAS. Iki
  // 020-a-02 abu failai iškrisdavo iš commit'o.
  const plan = planSessionStaging(
    input({
      statusOutput: " M src/app/capture-baseline.ts\n M src/app/baseline-report.ts\n",
      sessionWrites: [],
      sessionBaseline: {
        dispatch_nonce: NONCE,
        task_id: TASK,
        baseline_valid: true,
        non_runtime_dirty_entries: [
          { status: " M", path: "src/app/capture-baseline.ts" },
          { status: " M", path: "src/app/baseline-report.ts" },
        ],
      },
      allowedPaths: ["src/app/**", "src/tests/**"],
    }),
  );

  assert.deepEqual(plan.fallback.sort(), ["src/app/baseline-report.ts", "src/app/capture-baseline.ts"]);
  assert.deepEqual(plan.paths.sort(), ["src/app/baseline-report.ts", "src/app/capture-baseline.ts"]);
  assert.deepEqual(plan.gap, [], "gap saugiklis su galiojančiu baseline'u lieka išjungtas");
});

test("planSessionStaging: fallback SIAURINANTIS — vienas kelias už scope išjungia jį visiškai", () => {
  const outside = planSessionStaging(
    input({
      statusOutput: " M src/app/mine.ts\n M src/other/foreign-work.ts\n",
      sessionWrites: [],
      sessionBaseline: {
        dispatch_nonce: NONCE,
        task_id: TASK,
        baseline_valid: true,
        non_runtime_dirty_entries: [{ status: " M", path: "src/other/foreign-work.ts" }],
      },
      allowedPaths: ["src/app/**"],
    }),
  );
  assert.deepEqual(outside.fallback, [], "svetimas purvas medyje — scope įrodymas nebegalioja NĖ VIENAM keliui");
  assert.deepEqual(outside.paths, []);

  // Be nonce (interaktyvi sesija) ir be allowed aibės fallback'as neegzistuoja.
  const interactive = planSessionStaging(
    input({
      statusOutput: " M src/app/mine.ts\n",
      dispatchNonce: "",
      allowedPaths: ["src/app/**"],
    }),
  );
  assert.deepEqual(interactive.fallback, []);
  const noScope = planSessionStaging(
    input({
      statusOutput: " M src/app/mine.ts\n",
      sessionBaseline: { dispatch_nonce: NONCE, task_id: TASK, baseline_valid: true },
    }),
  );
  assert.deepEqual(noScope.fallback, []);
});

test("planSessionStaging: fallback'o negauna svetimas ir aktyvacijoje jau purvinas kelias", () => {
  // Įrodytai svetimas kandidatas išjungia fallback'ą VISĄ: svetimumas stipresnis už scope.
  const foreign = planSessionStaging(
    input({
      statusOutput: " M src/app/mine.ts\n M src/app/theirs.ts\n",
      sessionWrites: [],
      owners: { "src/app/theirs.ts": { sessions: ["kitas-nonce"], tasks: ["999"] } },
      sessionBaseline: {
        dispatch_nonce: NONCE,
        task_id: TASK,
        baseline_valid: true,
        non_runtime_dirty_entries: [{ status: " M", path: "src/app/theirs.ts" }],
      },
      allowedPaths: ["src/app/**"],
    }),
  );
  assert.deepEqual(foreign.fallback, []);

  // Aktyvacijos purvas įrodytai ne šio bandymo — jis atmetamas pavieniui, likęs darbas grįžta.
  const preDirty = planSessionStaging(
    input({
      statusOutput: " M src/app/old.ts\n M src/app/new.ts\n",
      sessionWrites: [],
      sessionBaseline: {
        dispatch_nonce: NONCE,
        task_id: TASK,
        baseline_valid: true,
        non_runtime_dirty_entries: [{ status: " M", path: "src/app/old.ts" }],
      },
      taskBaseline: { task_id: TASK, non_runtime_dirty_entries: [{ status: " M", path: "src/app/old.ts" }] },
      allowedPaths: ["src/app/**"],
    }),
  );
  assert.deepEqual(preDirty.fallback, ["src/app/new.ts"]);
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
