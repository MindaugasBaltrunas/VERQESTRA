// VQ-501 (5/5-d) testai — compound-init handleris per fake portus: darbo erdvės katalogai,
// skip-if-exists rašymas su --force išimtimi ir profilis, seedintas iš realios detekcijos.
// ATSKIRAS failas nuo interfaces-cli-bootstrap.test.ts sąmoningai: tas jau 473 eilutės, o
// 500 eilučių vartai galioja ir testams.

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import type { CliIo } from "../interfaces/cli/registry.js";
import {
  compoundInit,
  compoundInitCommand,
  parseCompoundInitArgs,
  titleFromDescription,
  type CompoundInitPorts,
  type WriteState,
} from "../interfaces/cli/bootstrap/compound-init.js";

const ROOT = path.resolve("/repo");
const RUNTIME_ROOT = path.join(ROOT, "vq");
const norm = (value: string): string => value.replace(/\\/g, "/");
const rel = (absolute: string): string => norm(path.relative(ROOT, absolute));

function captureIo(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (line) => out.push(line), error: (line) => err.push(line) }, out, err };
}

function initPorts(input: {
  existingFiles?: string[];
  existing?: string[];
  markers?: string[];
  sourceFiles?: string[];
} = {}): {
  ports: CompoundInitPorts;
  directories: string[];
  writes: Map<string, string>;
} {
  const existingFiles = new Set(input.existingFiles ?? []);
  const existing = new Set((input.existing ?? []).map((entry) => norm(entry)));
  const directories: string[] = [];
  const writes = new Map<string, string>();

  return {
    directories,
    writes,
    ports: {
      exists: async (p) => existing.has(rel(p)),
      findProductMarkers: async () => input.markers ?? [],
      findSourceFiles: async () => input.sourceFiles ?? [],
      makeDirectory: async (dir) => void directories.push(rel(dir)),
      writeTextIfMissing: async (p, content, options): Promise<WriteState> => {
        const key = rel(p);
        if (existingFiles.has(key) && !options.overwrite) return "skipped";
        const state: WriteState = existingFiles.has(key) ? "overwritten" : "created";
        writes.set(key, content);
        existingFiles.add(key);
        return state;
      },
    },
  };
}

test("parseCompoundInitArgs ir titleFromDescription: aprašas surenkamas iš žodžių, --force atskiriamas", () => {
  assert.deepEqual(parseCompoundInitArgs(["Mano", "produktas", "--force"]), {
    description: "Mano produktas",
    force: true,
  });
  assert.deepEqual(parseCompoundInitArgs([]), { description: "", force: false });

  assert.equal(titleFromDescription("Mano puikus produktas su viskuo ir dar daugiau"), "Mano puikus produktas su viskuo ir");
  assert.equal(titleFromDescription("!!!"), "VERQESTRA Project");
});

test("compoundInit: sukuria bucket'us AG/tasks ir runtime katalogus vq/, įrašo tris failus", async () => {
  const world = initPorts({});
  const result = await compoundInit({ ports: world.ports, projectRoot: ROOT, runtimeRoot: RUNTIME_ROOT }, [
    "Mano produktas",
  ]);

  assert.ok(world.directories.includes("AG/tasks/queue"));
  assert.ok(world.directories.includes("AG/tasks/human-review"));
  assert.ok(world.directories.includes("vq/state"));
  assert.ok(world.directories.includes("vq/spec/changes"));
  assert.deepEqual(result.created, ["vq/project/profile.json", "vq/spec/product-brief.md", "vq/spec/constitution.md"]);
  assert.deepEqual(result.skipped, []);
  assert.equal(result.projectRoot, ROOT);
});

test("compoundInit: esamas failas praleidžiamas, --force jį perrašo", async () => {
  const skipWorld = initPorts({ existingFiles: ["vq/project/profile.json"] });
  const skipped = await compoundInit({ ports: skipWorld.ports, projectRoot: ROOT, runtimeRoot: RUNTIME_ROOT }, [
    "Mano produktas",
  ]);
  assert.deepEqual(skipped.skipped, ["vq/project/profile.json"]);
  assert.equal(skipWorld.writes.has("vq/project/profile.json"), false, "operatoriaus profilis nepaliestas");

  const forceWorld = initPorts({ existingFiles: ["vq/project/profile.json"] });
  const forced = await compoundInit({ ports: forceWorld.ports, projectRoot: ROOT, runtimeRoot: RUNTIME_ROOT }, [
    "Mano produktas",
    "--force",
  ]);
  assert.deepEqual(forced.overwritten, ["vq/project/profile.json"]);
  assert.equal(forced.created.length, 2);
});

test("compoundInit: profilis seedinamas iš detekcijos; npm šeima gauna quality_gates", async () => {
  const detected = initPorts({
    existing: ["pnpm-lock.yaml", "src"],
    markers: ["package.json"],
    sourceFiles: ["src/a.ts", "src/b.ts"],
  });
  await compoundInit({ ports: detected.ports, projectRoot: ROOT, runtimeRoot: RUNTIME_ROOT }, ["Mano produktas"]);

  const profile = JSON.parse(detected.writes.get("vq/project/profile.json") ?? "{}") as {
    name: string;
    language: string;
    package_manager: string;
    source_roots: string[];
    quality_gates?: { build: string; test: string };
  };
  assert.equal(profile.name, "Mano produktas");
  assert.equal(profile.language, "typescript");
  assert.equal(profile.package_manager, "pnpm");
  assert.deepEqual(profile.source_roots, ["src"]);
  assert.deepEqual(profile.quality_gates, { build: "pnpm build", test: "pnpm test" });
});

test("compoundInit: tuščias projektas krenta į default'us be išgalvotų quality_gates ne-npm valdikliui", async () => {
  const empty = initPorts({});
  await compoundInit({ ports: empty.ports, projectRoot: ROOT, runtimeRoot: RUNTIME_ROOT }, ["Tuščias"]);
  const fallback = JSON.parse(empty.writes.get("vq/project/profile.json") ?? "{}") as {
    language: string;
    package_manager: string;
    source_roots: string[];
    quality_gates?: unknown;
  };
  assert.equal(fallback.language, "typescript");
  assert.equal(fallback.package_manager, "pnpm");
  assert.deepEqual(fallback.source_roots, ["src"]);

  const go = initPorts({ existing: ["go.mod"], markers: ["go.mod"], sourceFiles: ["main.go"] });
  await compoundInit({ ports: go.ports, projectRoot: ROOT, runtimeRoot: RUNTIME_ROOT }, ["Go servisas"]);
  const goProfile = JSON.parse(go.writes.get("vq/project/profile.json") ?? "{}") as {
    language: string;
    quality_gates?: unknown;
  };
  assert.equal(goProfile.language, "go");
  // Go ekosistema neturi `<manager> <script>` konvencijos — komanda neišgalvojama.
  assert.equal(goProfile.quality_gates, undefined);
});

test("compoundInitCommand: santrauka su skaičiais; be aprašo — 2 su naudojimo eilute", async () => {
  const world = initPorts({});
  const { io, out } = captureIo();
  assert.equal(
    await compoundInitCommand({ ports: world.ports, projectRoot: ROOT, runtimeRoot: RUNTIME_ROOT, io }, ["Mano produktas"]),
    0,
  );
  assert.equal(out[0], `VERQESTRA compound workspace ready: ${ROOT}`);
  assert.equal(out[1], "created: 3");
  assert.equal(out[2], "overwritten: 0");
  assert.equal(out[3], "skipped: 0");

  const usage = captureIo();
  assert.equal(
    await compoundInitCommand({ ports: world.ports, projectRoot: ROOT, runtimeRoot: RUNTIME_ROOT, io: usage.io }, [
      "--force",
    ]),
    2,
  );
  assert.match(usage.err[0] ?? "", /^Usage: verqestra compound-init /);
});
