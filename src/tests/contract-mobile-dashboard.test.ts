// KRYŽMINIS kontraktas: VERQESTRA UI dashboard payload ↔ mobile-gateway projekcija.
//
// 2026-08-24 `ui-dashboard-view.ts` pašalino `queueCounts` (jis buvo `workflowBuckets[].totalCount`
// dublikatas). `mobile-gateway/src/infrastructure/ag-loop-ui-projections.ts` jo vis dar skaitė, tad
// telefone VISI užduočių skaitikliai virto nuliais, nors grafe buvo 13 queued ir 1 done.
//
// Kodėl nei vienas rinkinys to nepagavo: mobile fikstūra tiekė `queueCounts` — lauką, kurio
// serveris jau nebesiuntė. Abu paketai atskirai buvo žali, nes kiekvienas tikrino SAVO prielaidą
// apie kitą. Šis testas tikrina pačią prielaidą.
//
// Kodėl ŠAKNYJE, o ne mobile pakete: lūžį sukėlė `src/` pakeitimas. Vartai turi kristi tam, kas
// tą pakeitimą daro — testas mobile pakete būtų suveikęs tik atskirame CI žingsnyje, jau po to,
// kai serverio pusė paskelbta žalia.
//
// Kodėl TEKSTU, o ne importu: `mobile-gateway` yra atskiras workspace paketas su savo tsconfig,
// ir `interfaces` sluoksniui importuoti jo nevalia. Tikrinamos DEKLARACIJOS — būtent jos ir
// prasilenkė.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(fileURLToPath(import.meta.url), "../../../");
const serverViewFile = path.join(repositoryRoot, "src/interfaces/http/ui-dashboard-view.ts");
const mobileProjectionFile = path.join(
  repositoryRoot,
  "mobile-gateway/src/infrastructure/ag-loop-ui-projections.ts",
);

/** `UiDashboardView` laukų vardai: dviejų tarpų įtrauka type deklaracijoje. */
function declaredPayloadFields(source: string): ReadonlySet<string> {
  const start = source.indexOf("export type UiDashboardView");
  assert.notEqual(start, -1, "ui-dashboard-view.ts must declare UiDashboardView");
  const end = source.indexOf("\n};", start);
  assert.notEqual(end, -1, "UiDashboardView must be a closed object type");
  const block = source.slice(start, end);
  return new Set([...block.matchAll(/^ {2}(\w+)\??:/gm)].flatMap((match) => match[1] ?? []));
}

/**
 * Laukai, kuriuos mobile projekcija ima iš dashboard payload'o.
 *
 * Imama TIK `source["…"]`: `bucket["name"]` ir panašūs skaito jau ištrauktą elementą, ne patį
 * atsakymą, tad jų čia neturi būti.
 */
function consumedPayloadFields(source: string): ReadonlySet<string> {
  const start = source.indexOf("function bucketCounts");
  assert.notEqual(start, -1, "the mobile projection must still derive bucket counts");
  const end = source.indexOf("\nexport function projectTaskBucketPayload", start);
  assert.notEqual(end, -1, "the dashboard projection must be followed by the task bucket one");
  const block = source.slice(start, end);
  return new Set([...block.matchAll(/\bsource\["(\w+)"\]/g)].flatMap((match) => match[1] ?? []));
}

test("every dashboard field the mobile projection reads is a field the server sends", async () => {
  const [serverSource, mobileSource] = await Promise.all([
    readFile(serverViewFile, "utf8"),
    readFile(mobileProjectionFile, "utf8"),
  ]);
  const emitted = declaredPayloadFields(serverSource);
  const consumed = consumedPayloadFields(mobileSource);

  // Be šių dviejų testas galėtų praeiti tuščias: sugedęs regex paverstų jį tyliu pritarimu.
  assert.ok(emitted.size >= 10, `the server payload parse collapsed to ${emitted.size} fields`);
  assert.ok(consumed.size > 0, "the mobile projection parse found no payload field at all");

  const missing = [...consumed].filter((field) => !emitted.has(field)).sort();
  assert.deepEqual(
    missing,
    [],
    `mobile-gateway reads dashboard fields the server does not send: ${missing.join(", ")}`,
  );
});

test("task counts have exactly one authority on both sides of the contract", async () => {
  const [serverSource, mobileSource] = await Promise.all([
    readFile(serverViewFile, "utf8"),
    readFile(mobileProjectionFile, "utf8"),
  ]);
  const emitted = declaredPayloadFields(serverSource);
  const consumed = consumedPayloadFields(mobileSource);

  // `workflowBuckets[].totalCount` yra vienintelis šaltinis. `queueCounts` buvo antra to paties
  // skaičiaus forma; dvi formos viename atsakyme anksčiau ar vėliau prasilenkia — ir prasilenkė.
  assert.ok(emitted.has("workflowBuckets"), "the server must publish workflowBuckets");
  assert.equal(
    emitted.has("queueCounts"),
    false,
    "queueCounts came back: pick one authority for task counts, not two",
  );
  assert.ok(
    consumed.has("workflowBuckets"),
    "the mobile projection must derive its counts from workflowBuckets",
  );
  assert.equal(
    consumed.has("queueCounts"),
    false,
    "the mobile projection reads queueCounts, which the server no longer sends",
  );
});
