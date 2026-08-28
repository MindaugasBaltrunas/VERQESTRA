// Task 060: zero-writes sargas anksčiau parkuodavo į human-review KIEKVIENĄ bėgimą be
// Write/Edit kvietimų — net kai Žingsnis 0 sąžiningai nustatė ALREADY_IMPLEMENTED (054-b-03,
// 057-a-02, 2026-08-28, orchestrator.log: verdict=done + ALREADY_IMPLEMENTED marker, po to
// "TASK NOT DONE: ... executor made no write-tool calls"). Read-only sesija PAGAL APIBRĖŽIMĄ
// neturi git deliverable, tad `hasWorkEvidence` visada false — 2026-08-14 false-done epidemijos
// vartai (dispositions.ts) tai klaidingai laikė svetimu atsukimu.
//
// Šie testai fiksuoja siaurą išimtį: `resolveNoCommitDisposition` grąžina "done" tik su
// DVIGUBU įrodymu — (1) ALREADY_IMPLEMENTED markeris IR (2) nepriklausomas skaitytojo
// signalas, kad rašymų tikrai nebuvo (`writeActivity === "no-writes"`) IR švarus produkto
// medis. Bet koks vienas iš dviejų įrodymų be antro lieka human-review kaip anksčiau.
import assert from "node:assert/strict";
import test from "node:test";
import { resolveNoCommitDisposition, type NoCommitDoneInputs } from "../domain/diagnosis/dispositions.js";

test("(a) zero-writes + ALREADY_IMPLEMENTED marker + clean tree resolves to done", () => {
  const inputs: NoCommitDoneInputs = {
    hasAlreadyImplementedMarker: true,
    productDirtyCount: 0,
    hasWorkEvidence: false,
    writeActivity: "no-writes",
  };
  assert.equal(resolveNoCommitDisposition(inputs), "done");
});

test("(b) zero-writes without ALREADY_IMPLEMENTED marker stays human-review", () => {
  const inputs: NoCommitDoneInputs = {
    hasAlreadyImplementedMarker: false,
    productDirtyCount: 0,
    hasWorkEvidence: false,
    writeActivity: "no-writes",
  };
  assert.equal(resolveNoCommitDisposition(inputs), "human-review");
});

test("(c) ALREADY_IMPLEMENTED marker with dirty product files (contradicts no-writes claim) stays human-review", () => {
  const inputs: NoCommitDoneInputs = {
    hasAlreadyImplementedMarker: true,
    productDirtyCount: 1,
    hasWorkEvidence: false,
    writeActivity: "no-writes",
  };
  assert.equal(resolveNoCommitDisposition(inputs), "human-review");
});

test("(d) ALREADY_IMPLEMENTED marker without confirmed no-writes evidence stays human-review", () => {
  const unknownActivity: NoCommitDoneInputs = {
    hasAlreadyImplementedMarker: true,
    productDirtyCount: 0,
    hasWorkEvidence: false,
    writeActivity: "unknown",
  };
  assert.equal(resolveNoCommitDisposition(unknownActivity), "human-review");

  const wroteActivity: NoCommitDoneInputs = {
    hasAlreadyImplementedMarker: true,
    productDirtyCount: 0,
    hasWorkEvidence: false,
    writeActivity: "wrote",
  };
  assert.equal(resolveNoCommitDisposition(wroteActivity), "human-review");

  const missingActivity: NoCommitDoneInputs = {
    hasAlreadyImplementedMarker: true,
    productDirtyCount: 0,
    hasWorkEvidence: false,
  };
  assert.equal(resolveNoCommitDisposition(missingActivity), "human-review");
});

test("marker + git work evidence still resolves to done regardless of write activity (unchanged path)", () => {
  const inputs: NoCommitDoneInputs = {
    hasAlreadyImplementedMarker: true,
    productDirtyCount: 0,
    hasWorkEvidence: true,
    writeActivity: "unknown",
  };
  assert.equal(resolveNoCommitDisposition(inputs), "done");
});
