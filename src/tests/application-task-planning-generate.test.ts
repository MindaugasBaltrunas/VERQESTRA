// taskGenerate numerio unikalumo pertikrinimas prieš rašymą (TOCTOU lenktynių sargas):
// nekeičia src/tests/task-planning.test.ts, tik prideda naujus scenarijus tam pačiam kodui.

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { taskGenerate, type TaskGeneratePorts } from "../application/task-planning/generate.js";

const ROOT = path.resolve("/repo");
const abs = (rel: string): string => path.join(ROOT, rel).replace(/\\/g, "/");
const norm = (p: string): string => p.replace(/\\/g, "/");

function makePorts(
  files: Map<string, string>,
  writeFileExclusive?: (
    p: string,
    content: string,
    fallback: (p: string, content: string) => Promise<"created" | "exists">,
  ) => Promise<"created" | "exists">,
): TaskGeneratePorts {
  const defaultWrite = async (p: string, content: string): Promise<"created" | "exists"> => {
    if (files.has(norm(p))) return "exists";
    files.set(norm(p), content);
    return "created";
  };
  return {
    fs: {
      exists: async (p) => files.has(norm(p)),
      readTextFileIfExists: async (p) => files.get(norm(p)),
      listSubdirectories: async (dir) => {
        const prefix = `${norm(dir)}/`;
        const names = new Set<string>();
        for (const key of files.keys()) {
          if (key.startsWith(prefix) && key.slice(prefix.length).includes("/")) {
            names.add(key.slice(prefix.length).split("/")[0]!);
          }
        }
        return [...names];
      },
      listFiles: async (dir) => {
        const prefix = `${norm(dir)}/`;
        return [...files.keys()]
          .filter((key) => key.startsWith(prefix) && !key.slice(prefix.length).includes("/"))
          .map((key) => key.slice(prefix.length));
      },
      makeDirectory: async () => {},
      writeFileExclusive: writeFileExclusive
        ? (p, content) => writeFileExclusive(p, content, defaultWrite)
        : defaultWrite,
    },
  };
}

function baseFiles(): Map<string, string> {
  return new Map<string, string>([
    [abs("AG/openspec/changes/my-change/spec.md"), "# Spec"],
    [
      abs("AG/openspec/changes/my-change/tasks.md"),
      "- [ ] Pirmas planuojamas darbas\n- [ ] Antras planuojamas darbas\n",
    ],
    [abs("vq/architecture/enforcement-policy.json"), JSON.stringify({ require_tests_for_code_changes: true })],
  ]);
}

test("taskGenerate: TOCTOU kolizija tarp pertikrinimo ir rašymo pastumia numerį pirmyn, turinys neprarandamas", async () => {
  const files = baseFiles();

  // Simuliuojame "kitą procesą", kuris spėja parašyti 001-ą failą tiksliai tarp
  // isTaskNumberInUse patikros (kuri Map'e dar nieko nemato) ir writeFileExclusive iškvietimo:
  // pirmas writeFileExclusive bandymas su 001 numeriu visada grąžina "exists" nepriklausomai
  // nuo Map turinio, imituodamas lenktynes.
  let firstAttemptForCollidingNumber = true;
  const ports = makePorts(files, async (p, content, fallback) => {
    const fileName = path.basename(norm(p));
    if (fileName.startsWith("001-") && firstAttemptForCollidingNumber) {
      firstAttemptForCollidingNumber = false;
      return "exists";
    }
    return fallback(p, content);
  });

  const result = await taskGenerate(
    ports,
    { openspecChangeId: "my-change", startIndex: 1 },
    "/repo",
    path.join(ROOT, "vq"),
  );

  assert.equal(result.created.length, 2);
  assert.deepEqual(result.skipped, []);
  // Numeris 001 pralaimėjo TOCTOU lenktynes — pirmas taskLine turėjo pasistumti į 002-ą,
  // antras — į 003-ą; nei vienas turinys neprarastas ir joks failas neperrašytas.
  assert.deepEqual(result.created, [
    "AG/tasks/queue/002-pirmas-planuojamas-darbas.md",
    "AG/tasks/queue/003-antras-planuojamas-darbas.md",
  ]);
  assert.ok(!files.has(abs("AG/tasks/queue/001-pirmas-planuojamas-darbas.md")));
});

test("taskGenerate: viršijus MAX_ASSIGNMENT_ATTEMPTS meta aiškią klaidą su numeriu ir bandymų kiekiu", async () => {
  const files = baseFiles();

  // "exists" grąžinama visada, nepriklausomai nuo numerio — tikra sugadinta bucket būsena,
  // kurioje joks retry niekada nesuranda laisvo numerio.
  const ports = makePorts(files, async () => "exists");

  await assert.rejects(
    () => taskGenerate(ports, { openspecChangeId: "my-change", startIndex: 1 }, "/repo", path.join(ROOT, "vq")),
    /Task number \d+ still colliding after \d+ attempts/,
  );
});
