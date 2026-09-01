// 2026-08-25, operatoriaus sprendimas: orkestratoriaus entrypoint atpažįstamas ir dabartiniu
// produkto vardu.
//
// Migruojant CLI buvo pervadintas (`package.json` bin = `verqestra`), o bash politika liko su
// etalono vardu `ag`. Pasekmė nebuvo higieninė: NĖ VIENAS agentas negalėjo paleisti ciklo per
// sankcionuotą kelią, nors etalone galėjo — `pnpm exec verqestra loop`, `node dist/cli.js loop` ir
// `node_modules/.bin/verqestra loop` visi krisdavo į `not-allowlisted`.
//
// Testas gina ne tai, kad plyšys veikia, o jo DYDĮ: pridėtas VARDAS, ne galia. Subkomandų aibė ta
// pati keturių, argumentai neleidžiami, o `exec` forma neturi tapti bendru „pnpm exec bet kas".

import assert from "node:assert/strict";
import test from "node:test";
import { evaluateBashCommandPolicy } from "../domain/policies/bash-command-policy.js";

const allowed = (command: string): void =>
  assert.equal(evaluateBashCommandPolicy(command).blockedPattern, undefined, command);

const blocked = (command: string, why: string): void =>
  assert.ok(evaluateBashCommandPolicy(command).blockedPattern, `${command} — ${why}`);

test("loop entrypoint: etalono vardas `ag` nesulaužytas", () => {
  allowed("ag loop");
  allowed("ag loop-guard");
  allowed("pnpm ag status");
});

test("loop entrypoint: dabartinis vardas `verqestra`, įskaitant workspace bin formą", () => {
  allowed("verqestra loop");
  allowed("verqestra loop-guard");
  allowed("verqestra status");
  allowed("pnpm exec verqestra loop");
  allowed("pnpm exec verqestra run-claude-loop");
});

test("loop entrypoint: subkomandų aibė NEPRAPLĖSTA", () => {
  blocked("verqestra task-generate", "ne viena iš keturių leistinų subkomandų");
  blocked("pnpm exec verqestra rollback-stable", "rollback nėra loop entrypoint");
  blocked("verqestra install", "diegimas nėra loop entrypoint");
});

test("loop entrypoint: argumentai neleidžiami — šablonas baigiasi subkomanda", () => {
  blocked("verqestra loop --force", "papildomi argumentai");
  blocked("pnpm exec verqestra loop --json", "papildomi argumentai");
});

test("loop entrypoint: `exec` netapo universaliu praleidimu", () => {
  blocked("pnpm exec rm -rf /tmp/x", "exec nėra wildcard");
  blocked("pnpm exec verqestra loop; echo pwned", "kabliataškis atveria antrą segmentą");
  blocked("pnpm exec verqestra loop && rm -rf x", "grandinė atveria antrą segmentą");
});

// 2026-09-01 (GeoGravity human-review priežiūra): ta pati rename parity taisyklė
// requeue/task-move/task-ledger-sync komandoms — `ag` bin'o target repo nėra, `node dist/cli.js`
// kelio taip pat, tad sankcionuota human-review → done operacija buvo neįmanoma per jokį leistą
// įėjimą. Testas gina plyšio DYDĮ: kitas vardas, tos pačios kryptys ir argumentų ribos.
test("task priežiūra: `verqestra` forma leidžiama toms pačioms subkomandoms", () => {
  allowed("verqestra requeue 1199_web_query_viewer_shell_completion_invalidation.md");
  allowed("verqestra task-move AG/tasks/human-review/1196_geoobject_objecttype_passthrough.md AG/tasks/done");
  allowed("verqestra task-ledger-sync");
  allowed("pnpm exec verqestra task-ledger-sync");
  allowed("ag task-move AG/tasks/human-review/x.md AG/tasks/done");
});

test("task priežiūra: kryptys ir argumentų ribos NEPRAPLĖSTOS", () => {
  blocked("verqestra task-move AG/tasks/done/x.md AG/tasks/queue", "leidžiama tik human-review → done");
  blocked("verqestra task-move AG/tasks/human-review/../secrets.md AG/tasks/done", "kelio traversal");
  blocked("verqestra task-move AG/tasks/human-review/x.md AG/tasks/done --force", "papildomi argumentai");
  blocked("verqestra requeue AG/tasks/queue/x.md", "requeue ima tik failo vardą be kelio");
  blocked("verqestra task-ledger-sync --rebuild", "argumentai neleidžiami");
});
