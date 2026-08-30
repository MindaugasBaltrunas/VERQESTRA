// Task 095: sėkmingas auditas, kuris nieko taisytino neranda, negalėjo užsidaryti kaip done —
// commit'o nėra (nebuvo ko taisyti), `hasWorkEvidence` nėra (read-only auditas neturi git
// deliverable), o ALREADY_IMPLEMENTED jo deliverable neatitinka semantiškai: task'as nebuvo
// „jau įgyvendintas", jis buvo ĮVYKDYTAS, ir jo rezultatas yra ataskaita „radinių nėra".
//
// Šie testai fiksuoja TREČIĄ siaurą no-commit done šaką su tokiu pat DVIGUBU įrodymu kaip
// task 060 išimtis: (1) AUDIT_COMPLETE markeris IR (2) nepriklausomas skaitytojo signalas
// `writeActivity === "no-writes"` IR švarus produkto medis. Bet kurio įrodymo trūkumas
// grąžina lygiai tą elgesį, koks buvo iki 095.
import assert from "node:assert/strict";
import test from "node:test";
import { resolveNoCommitDisposition, resolveNoCommitReviewReason, type NoCommitDoneInputs } from "../domain/diagnosis/dispositions.js";
import { logHasAuditCompleteMarker, logHasAlreadyImplementedMarker } from "../domain/diagnosis/stream-log.js";

// ---------------------------------------------------------------------------
// Markerio atpažinimas (stream-log.ts)
// ---------------------------------------------------------------------------

test("audit marker: plain-text log'e atpažįstama `AUDIT_COMPLETE: <santrauka>` forma", () => {
  assert.equal(logHasAuditCompleteMarker("AUDIT_COMPLETE: radinių nėra, 12 failų peržiūrėta\n"), true);
  assert.equal(logHasAuditCompleteMarker("  AUDIT_COMPLETE: įtrauktas su tarpais\n"), true);
  assert.equal(logHasAuditCompleteMarker("Ataskaita:\nAUDIT_COMPLETE: nieko taisytino\n"), true);
  // `\b` po markerio: dvitaškis nėra būtinas, bet žodžio riba — taip.
  assert.equal(logHasAuditCompleteMarker("AUDIT_COMPLETE nieko taisytino\n"), true);
});

test("audit marker: stream-json result envelope (etalono 1048/1049 pamoka)", () => {
  const streamLog = [
    '{"type":"system","noise":true}',
    "stderr triukšmas, ne JSON",
    `{"type":"result","result":"Auditas baigtas.\\nAUDIT_COMPLETE: 0 radinių, vartai žali."}`,
  ].join("\n");
  assert.equal(logHasAuditCompleteMarker(streamLog), true);
});

test("audit marker: neigiami atvejai", () => {
  assert.equal(logHasAuditCompleteMarker(""), false);
  assert.equal(logHasAuditCompleteMarker("tekstas be markerio"), false);
  // Eilutės viduryje paminėtas žodis nėra markeris — nei žaliame tekste, nei result lauke.
  assert.equal(logHasAuditCompleteMarker("tekste minimas AUDIT_COMPLETE žodis"), false);
  assert.equal(
    logHasAuditCompleteMarker('{"type":"result","result":"tekste minimas AUDIT_COMPLETE žodis"}'),
    false,
  );
  // Ne-result envelope neatiduoda nieko net su markeriu JSON viduje.
  assert.equal(logHasAuditCompleteMarker('{"type":"assistant","result":"AUDIT_COMPLETE: ne result"}'), false);
  // Prefiksas nėra markeris (`\b` riba).
  assert.equal(logHasAuditCompleteMarker("AUDIT_COMPLETED_YESTERDAY: ne tas žodis"), false);
});

test("audit marker: du markeriai nesipainioja tarpusavyje", () => {
  assert.equal(logHasAuditCompleteMarker("ALREADY_IMPLEMENTED: jau padaryta\n"), false);
  assert.equal(logHasAlreadyImplementedMarker("AUDIT_COMPLETE: radinių nėra\n"), false);
});

// ---------------------------------------------------------------------------
// Dispozicija (dispositions.ts)
// ---------------------------------------------------------------------------

const auditRun = (overrides: Partial<NoCommitDoneInputs> = {}): NoCommitDoneInputs => ({
  hasAlreadyImplementedMarker: false,
  productDirtyCount: 0,
  hasWorkEvidence: false,
  hasAuditCompleteMarker: true,
  writeActivity: "no-writes",
  ...overrides,
});

test("(a) AUDIT_COMPLETE + patvirtintas no-writes + švarus medis uždaro kaip done", () => {
  assert.equal(resolveNoCommitDisposition(auditRun()), "done");
});

test("(b) AUDIT_COMPLETE be patvirtinto no-writes lieka human-review", () => {
  assert.equal(resolveNoCommitDisposition(auditRun({ writeActivity: "unknown" })), "human-review");
  assert.equal(resolveNoCommitDisposition(auditRun({ writeActivity: "wrote" })), "human-review");
  const missingActivity: NoCommitDoneInputs = {
    hasAlreadyImplementedMarker: false,
    productDirtyCount: 0,
    hasWorkEvidence: false,
    hasAuditCompleteMarker: true,
  };
  assert.equal(resolveNoCommitDisposition(missingActivity), "human-review");
});

test("(c) AUDIT_COMPLETE su dirty produkto medžiu neuždaro tyliai — griežtoji rollback šaka lieka", () => {
  // Dirty įrašai prieštarauja „nulis rašymų" tvirtinimui; be ALREADY_IMPLEMENTED markerio
  // elgesys nepakinta: darbo prarasti negalima, todėl rollback.
  assert.equal(resolveNoCommitDisposition(auditRun({ productDirtyCount: 2 })), "rollback");
});

test("(d) no-writes be AUDIT_COMPLETE markerio lieka human-review (nepakitęs kelias)", () => {
  assert.equal(resolveNoCommitDisposition(auditRun({ hasAuditCompleteMarker: false })), "human-review");
  const missingMarker: NoCommitDoneInputs = {
    hasAlreadyImplementedMarker: false,
    productDirtyCount: 0,
    hasWorkEvidence: false,
    writeActivity: "no-writes",
  };
  assert.equal(resolveNoCommitDisposition(missingMarker), "human-review");
});

test("(e) AUDIT_COMPLETE nekeičia esamų ALREADY_IMPLEMENTED šakų verdiktų", () => {
  // Markeris + darbo įrodymas: done ir su, ir be audito markerio.
  const withEvidence = { productDirtyCount: 0, hasWorkEvidence: true, writeActivity: "unknown" } as const;
  assert.equal(resolveNoCommitDisposition({ hasAlreadyImplementedMarker: true, ...withEvidence }), "done");
  assert.equal(
    resolveNoCommitDisposition({ hasAlreadyImplementedMarker: true, hasAuditCompleteMarker: true, ...withEvidence }),
    "done",
  );
  // Markeris be įrodymų: human-review ir su audito markeriu, kai no-writes nepatvirtintas.
  assert.equal(
    resolveNoCommitDisposition({
      hasAlreadyImplementedMarker: true,
      hasAuditCompleteMarker: true,
      productDirtyCount: 0,
      hasWorkEvidence: false,
      writeActivity: "unknown",
    }),
    "human-review",
  );
});

test("(f) human-review priežastis skiria trūkstamą skaitytojo signalą nuo dingusio deliverable", () => {
  assert.equal(
    resolveNoCommitReviewReason(auditRun({ writeActivity: "unknown" })),
    "AUDIT_COMPLETE marker without confirmed zero-write evidence",
  );
  assert.equal(
    resolveNoCommitReviewReason(auditRun({ writeActivity: "wrote" })),
    "AUDIT_COMPLETE marker without confirmed zero-write evidence",
  );
  // `no-writes` pirmumas nepakinta (task 032 priežastis), o be audito markerio — bendra eilutė.
  assert.equal(resolveNoCommitReviewReason(auditRun()), "executor made no write-tool calls");
  assert.equal(
    resolveNoCommitReviewReason(auditRun({ hasAuditCompleteMarker: false, writeActivity: "unknown" })),
    "clean tree without work evidence (deliverable missing — possibly rolled back)",
  );
});
