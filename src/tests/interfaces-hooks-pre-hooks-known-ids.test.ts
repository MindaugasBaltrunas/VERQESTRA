// `collectKnownTaskIds` — `## Priklausomybės` nuorodų domeno šaltinis. 2026-08-30 incidentas:
// žinomi id buvo imami TIK iš vq/state/task-ledger.json, o niekada nebėgęs queue task'as
// (075-preserved-ref...) ledger'yje neegzistuoja — pre-write vartas klaidingai blokavo 083
// pataisą su `priklausomybe-unknown-id`. Etalono taisyklė („TIK queue arba done bucket'ų id")
// tiesos šaltiniu daro bucket'ų failus; ledger'is lieka sąjungoje dėl istorinių id.
import assert from "node:assert/strict";
import test from "node:test";
import { collectKnownTaskIds, type HookFsPort } from "../interfaces/hooks/index.js";

const ROOT = "/proj";
const RUNTIME = "/proj/vq";

function fakeFs(input: {
  ledger?: string;
  buckets?: Record<string, string[]>;
  withoutListing?: boolean;
}): HookFsPort {
  const base: HookFsPort = {
    exists: async () => false,
    readTextFileIfExists: async (absolutePath) =>
      absolutePath.replaceAll("\\", "/").endsWith("vq/state/task-ledger.json") ? input.ledger : undefined,
    writeTextFile: async () => undefined,
    appendTextFile: async () => undefined,
    makeDirectory: async () => undefined,
  };
  if (input.withoutListing) return base;
  return {
    ...base,
    listDirectoryIfExists: async (absoluteDir) => {
      const normalized = absoluteDir.replaceAll("\\", "/");
      for (const [bucket, entries] of Object.entries(input.buckets ?? {})) {
        if (normalized.endsWith(`AG/tasks/${bucket}`)) return entries;
      }
      return undefined;
    },
  };
}

test("niekada nebėgęs queue task'as yra žinomas id (ledger'yje jo nėra)", async () => {
  const fs = fakeFs({
    ledger: JSON.stringify({ "066-b-03-run-coordinator": {} }),
    buckets: { queue: ["075-preserved-ref-retencija.md"], done: ["071-pre-write-hookas.md"] },
  });
  const ids = await collectKnownTaskIds(fs, ROOT, RUNTIME);
  assert.ok(ids.includes("075-preserved-ref-retencija"), "queue failas be ledger įrašo privalo būti žinomas");
  assert.ok(ids.includes("071-pre-write-hookas"), "done failas privalo būti žinomas");
  assert.ok(ids.includes("066-b-03-run-coordinator"), "ledger indėlis lieka sąjungoje");
});

test("ne-.md įrašai ir kiti bucket'ai į domeną nepatenka", async () => {
  const fs = fakeFs({
    buckets: {
      queue: ["notes.txt", "090-tikras.md"],
      done: [],
      "human-review": ["099-parkuotas.md"],
    },
  });
  const ids = await collectKnownTaskIds(fs, ROOT, RUNTIME);
  assert.deepEqual(ids.sort(), ["090-tikras"], "tik queue/done .md vardai be plėtinio");
});

test("be listingo porto krenta į vien-ledger šaltinį (susiaurina, neišplečia)", async () => {
  const fs = fakeFs({ ledger: JSON.stringify({ "012-ledgeryje": {} }), withoutListing: true });
  const ids = await collectKnownTaskIds(fs, ROOT, RUNTIME);
  assert.deepEqual(ids, ["012-ledgeryje"]);
});

test("sugadintas ledger'is ir nerandami katalogai duoda tuščią indėlį, ne klaidą", async () => {
  const corrupted = await collectKnownTaskIds(
    fakeFs({ ledger: "{ broken", buckets: { queue: ["075-x.md"] } }),
    ROOT,
    RUNTIME,
  );
  assert.deepEqual(corrupted, ["075-x"], "bucket'ų failai lieka šaltiniu");

  const emptyWorld = await collectKnownTaskIds(fakeFs({}), ROOT, RUNTIME);
  assert.deepEqual(emptyWorld, [], "tuščias pasaulis — tuščias domenas");
});
