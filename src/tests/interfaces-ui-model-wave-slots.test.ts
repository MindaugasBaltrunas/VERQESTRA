// VQ-503 (3/5-a) testai — bangos slot'ų projekcija ir laisvo teksto redakcija. Svarbiausia, ką
// jie pin'ina: nesėkmė NUGALI `released` (kritęs ir atlaisvintas slot'as vis tiek yra kritęs),
// neperskaitomas įvykių šaltinis neverčia `provisioned` melo, senesnės kartos nesėkmė nepriskiriama
// naujam lease'ui, o į UI išeinančiame tekste nelieka nei absoliutaus kelio, nei lease UUID.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SLOT_FAILURE_PREFIX,
  SLOT_FAILURE_REASON_MAX_CHARS,
  buildWaveSlots,
  parseSlotFailureLine,
  type BuildWaveSlotsInput,
  type WaveSlotLease,
} from "../interfaces/ui-model/wave-slot-model.js";
import {
  redactIdentifiers,
  redactPaths,
  sanitizeFreeText,
} from "../interfaces/http/free-text-redaction.js";

const NOW = new Date("2026-08-21T12:00:00.000Z");

function lease(over: Partial<WaveSlotLease> = {}): WaveSlotLease {
  return {
    worker_id: "w1",
    task_id: "890",
    status: "held",
    acquired_at: "2026-08-21T11:00:00.500Z",
    heartbeat_at: "2026-08-21T11:59:00.000Z",
    expires_at: "2026-08-21T12:30:00.000Z",
    has_worktree: true,
    ...over,
  };
}

function input(over: Partial<BuildWaveSlotsInput> = {}): BuildWaveSlotsInput {
  return { leases: [lease()], events: [], failures: [], events_available: true, now: NOW, ...over };
}

test("buildWaveSlots: be vykdymo įrodymo lieka provisioned, su įrodymu — running", () => {
  const idle = buildWaveSlots(input());
  assert.equal(idle[0]?.state, "provisioned");
  assert.equal(idle[0]?.lease_age_ms, 3_600_000 - 500);
  assert.equal(idle[0]?.stale, false);

  const running = buildWaveSlots(
    input({ events: [{ ts: "2026-08-21T11:05:00.000Z", event: "task_started", task_id: "890" }] }),
  );
  assert.equal(running[0]?.state, "running");

  // Svetimo task'o įvykis nieko neįrodo apie šį slot'ą.
  const foreign = buildWaveSlots(
    input({ events: [{ ts: "2026-08-21T11:05:00.000Z", event: "task_started", task_id: "999" }] }),
  );
  assert.equal(foreign[0]?.state, "provisioned");
});

test("buildWaveSlots: neperskaitytas įvykių šaltinis NEVERČIA provisioned melo", () => {
  // „Įrodymų nėra" ir „nieko nevyko" yra skirtingi dalykai: turėdamas lease'ą, bet neturėdamas
  // kuo patikrinti, vaizdas sako `running`, o ne tvirtina, kad slot'as tik paruoštas.
  const slots = buildWaveSlots(input({ events_available: false }));
  assert.equal(slots[0]?.state, "running");
});

test("buildWaveSlots: nesėkmė nugali released, o senesnės kartos nesėkmė nepriskiriama", () => {
  const failure = {
    worker_id: "w1",
    task_id: "890",
    ts: "2026-08-21T11:30:00.000Z",
    reason: "worktree užimtas",
  };

  const released = buildWaveSlots(input({ leases: [lease({ status: "released" })], failures: [failure] }));
  assert.equal(released[0]?.state, "failed", "kritęs ir atlaisvintas slot'as vis tiek yra kritęs");
  assert.equal(released[0]?.last_failure?.reason, "worktree užimtas");

  // Ankstesnės kartos įrašas log'e lieka dienomis — naujam lease'ui jis negalioja.
  const old = buildWaveSlots(input({ failures: [{ ...failure, ts: "2026-08-21T10:00:00.000Z" }] }));
  assert.equal(old[0]?.state, "provisioned");
  assert.equal(old[0]?.last_failure, null);

  // Ta pati SEKUNDĖ kaip lease'o paėmimas: be nuapvalinimo nesėkmė atrodytų senesnė ir dingtų.
  const sameSecond = buildWaveSlots(input({ failures: [{ ...failure, ts: "2026-08-21T11:00:00.000Z" }] }));
  assert.equal(sameSecond[0]?.state, "failed");
});

test("buildWaveSlots: pasibaigęs ar neperskaitomas galiojimas žymi stale", () => {
  const expired = buildWaveSlots(input({ leases: [lease({ expires_at: "2026-08-21T11:59:00.000Z" })] }));
  assert.equal(expired[0]?.stale, true);

  const unreadable = buildWaveSlots(input({ leases: [lease({ expires_at: "ne data" })] }));
  assert.equal(unreadable[0]?.stale, true);
  assert.equal(unreadable[0]?.heartbeat_age_ms, 60_000);

  // Atlaisvintam lease'ui stale klausimas neaktualus.
  const released = buildWaveSlots(input({ leases: [lease({ status: "released", expires_at: "ne data" })] }));
  assert.equal(released[0]?.stale, false);
});

test("buildWaveSlots: vienas slot'as vienam lease'ui, įvesties tvarka", () => {
  const slots = buildWaveSlots(
    input({ leases: [lease({ worker_id: "w2", task_id: "891" }), lease({ worker_id: "w1" })] }),
  );
  assert.deepEqual(
    slots.map((slot) => slot.worker_id),
    ["w2", "w1"],
  );
});

test("parseSlotFailureLine: laikas normalizuojamas į UTC, o svetimos formos praleidžiamos", () => {
  const parsed = parseSlotFailureLine(
    `[2026-08-21 11:30:00] ${SLOT_FAILURE_PREFIX} slot=w1 task=890 error=worktree busy`,
    (text) => text,
  );
  // Antspaudas be `Z` yra UTC; be perrinkimo jis būtų perskaitytas kaip lokalus laikas.
  assert.equal(parsed?.ts, "2026-08-21T11:30:00.000Z");
  assert.equal(parsed?.worker_id, "w1");
  assert.equal(parsed?.reason, "worktree busy");

  assert.equal(parseSlotFailureLine("[2026-08-21 11:30:00] kita eilutė", (t) => t), undefined);
  assert.equal(parseSlotFailureLine(`[ne data] ${SLOT_FAILURE_PREFIX} slot=w1 task=890 error=x`, (t) => t), undefined);
  // Laisvas tekstas identifikatoriaus vietoje į UI nepatenka.
  assert.equal(
    parseSlotFailureLine(`[2026-08-21 11:30:00] ${SLOT_FAILURE_PREFIX} slot=w1;rm task=890 error=x`, (t) => t),
    undefined,
  );
});

test("parseSlotFailureLine: sanitize taikomas priežasčiai ir ji apkarpoma", () => {
  const long = "x".repeat(SLOT_FAILURE_REASON_MAX_CHARS + 50);
  const parsed = parseSlotFailureLine(
    `[2026-08-21 11:30:00] ${SLOT_FAILURE_PREFIX} slot=w1 task=890 error=${long}`,
    (text) => text,
  );
  assert.equal(parsed?.reason.length, SLOT_FAILURE_REASON_MAX_CHARS);

  // Tuščias `reason` po valymo VIS TIEK yra nesėkmė — nutylėti ją būtų blogiau.
  const emptied = parseSlotFailureLine(
    `[2026-08-21 11:30:00] ${SLOT_FAILURE_PREFIX} slot=w1 task=890 error=C:/repo/x`,
    () => "",
  );
  assert.deepEqual({ ts: emptied?.ts, reason: emptied?.reason }, {
    ts: "2026-08-21T11:30:00.000Z",
    reason: "",
  });
});

test("sanitizeFreeText: absoliutūs keliai ir lease UUID nepatenka į UI", () => {
  const text =
    "lease 0f9a1c2b-3d4e-5f60-8a9b-0c1d2e3f4a5b konfliktas C:\\Users\\John Doe\\repo\\src\\a.ts ir /home/ana/repo/b.ts";
  const clean = sanitizeFreeText(text, [], "linux");

  assert.equal(clean.includes("John Doe"), false);
  assert.equal(clean.includes("/home/ana"), false);
  assert.equal(clean.includes("0f9a1c2b"), false);
  assert.match(clean, /<path>/);
  assert.match(clean, /<id>/);

  // Santykiniai keliai LIEKA: būtent jie paaiškina write-set konfliktą.
  assert.match(sanitizeFreeText("write-set konfliktas: src/a.ts", [], "linux"), /src\/a\.ts/);

  // Žinoma šaknis valoma pažodžiui, net kai forma neatitinka bendro šablono.
  assert.equal(redactPaths("darbas ties D:/VERQESTRA-x/failas", ["D:/VERQESTRA-x"], "win32").includes("VERQESTRA-x"), false);
  assert.equal(redactIdentifiers("be uuid"), "be uuid");
});
