// VQ-503 (4/5-b) testai — UI porto parinkimas. Svarbiausia, ką jie pin'ina: portas išvedamas iš
// projekto ŠAKNIES (ta pati šaknis → tas pats portas, kitos šaknys → kiti portai); „portas klauso"
// NĖRA įrodymas, kad serveris mūsų; aiškus override META, o ne tyliai krenta į kitą portą; ir
// persistuotas įrašas priimamas tik su SAVO projekto fingerprint'u.

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import {
  InvalidUiPortError,
  UI_PORT_ENV,
  UI_PORT_RANGE_END,
  UI_PORT_RANGE_SIZE,
  UI_PORT_RANGE_START,
  buildUiIdentityBody,
  derivePreferredUiPort,
  identityFingerprint,
  parseUiPortOverride,
  projectFingerprint,
  uiPortCandidates,
  uiUrl,
  type UiPortProbeResult,
} from "../interfaces/http/ui-port-rules.js";
import {
  UI_SERVER_RECORD_SCHEMA_VERSION,
  parseEnvFile,
  readUiServerRecord,
  resolveUiPort,
  uiServerRecordFile,
  writeUiServerRecord,
  type UiPortPorts,
} from "../interfaces/http/ui-port-store.js";

const ROOT = path.resolve("/repo");
const RUNTIME = path.join(ROOT, "vq");
const STATE = path.join(RUNTIME, "state");
const COMMANDS_ENV = path.join(RUNTIME, "config", "commands.env");
const NOW = new Date("2026-08-21T12:00:00.000Z");
const FINGERPRINT = projectFingerprint(ROOT, "linux");

type PortWorld = {
  ports: UiPortPorts;
  store: Map<string, string>;
  env: Map<string, string>;
  probes: Map<number, UiPortProbeResult>;
  probed: number[];
  defaultProbe: UiPortProbeResult;
};

function portWorld(files: Record<string, string> = {}): PortWorld {
  const store = new Map(Object.entries(files));
  const world: PortWorld = {
    store,
    env: new Map<string, string>(),
    probes: new Map<number, UiPortProbeResult>(),
    probed: [],
    defaultProbe: { state: "free" },
    ports: {
      fs: {
        readTextFileIfExists: (p) => Promise.resolve(store.get(p)),
        writeTextFileAtomic: (p, content) => {
          store.set(p, content);
          return Promise.resolve();
        },
        makeDirectory: () => Promise.resolve(),
      },
      env: (name) => world.env.get(name),
      probe: (port) => {
        world.probed.push(port);
        return Promise.resolve(world.probes.get(port) ?? world.defaultProbe);
      },
      now: () => NOW,
      platform: "linux",
    },
  };
  return world;
}

// ---------------------------------------------------------------------------
// grynosios taisyklės
// ---------------------------------------------------------------------------

test("projectFingerprint: ta pati šaknis duoda tą patį portą, kita šaknis — kitą", () => {
  assert.equal(projectFingerprint(ROOT, "linux"), projectFingerprint(ROOT, "linux"));
  assert.notEqual(projectFingerprint(ROOT, "linux"), projectFingerprint(path.resolve("/kitas"), "linux"));

  // Windows keliai case-insensitive ir su abiem skirtukais: be normalizavimo tas pats projektas
  // gautų du portus ir du UI serverius.
  assert.equal(projectFingerprint("D:\\Repo\\App", "win32"), projectFingerprint("d:/repo/app/", "win32"));
  // Kelias per identifikacijos maršrutą NEIŠEINA — tik 64 bitų hash'as.
  assert.equal(projectFingerprint(ROOT, "linux").length, 16);
});

test("uiPortCandidates: pageidaujamas pirmas, deterministinis ratas, visas diapazonas", () => {
  const preferred = derivePreferredUiPort(ROOT, "linux");
  const candidates = uiPortCandidates(ROOT, "linux");

  assert.equal(candidates[0], preferred);
  assert.equal(candidates.length, UI_PORT_RANGE_SIZE);
  assert.equal(new Set(candidates).size, UI_PORT_RANGE_SIZE, "kiekvienas portas lygiai kartą");
  assert.ok(candidates.every((port) => port >= UI_PORT_RANGE_START && port <= UI_PORT_RANGE_END));
  // Hash'as, o ne „pirmas laisvas": eilė nepriklauso nuo paleidimo tvarkos.
  assert.deepEqual(candidates, uiPortCandidates(ROOT, "linux"));
});

test("parseUiPortOverride: rašybos klaida META, o ne virsta išvestu portu", () => {
  assert.equal(parseUiPortOverride(" 4200 ", UI_PORT_ENV), 4200);
  assert.throws(() => parseUiPortOverride("4173abc", UI_PORT_ENV), InvalidUiPortError);
  assert.throws(() => parseUiPortOverride("", UI_PORT_ENV), InvalidUiPortError);
  assert.throws(() => parseUiPortOverride("80", UI_PORT_ENV), InvalidUiPortError);
  assert.throws(() => parseUiPortOverride("70000", UI_PORT_ENV), InvalidUiPortError);
});

test("identityFingerprint: svetimas ar neatpažįstamas atsakymas NĖRA `mūsų`", () => {
  assert.equal(identityFingerprint(buildUiIdentityBody("abc123")), "abc123");
  assert.equal(identityFingerprint(JSON.stringify({ service: "kitas", project_fingerprint: "abc" })), undefined);
  assert.equal(identityFingerprint(JSON.stringify({ service: "verqestra-ui" })), undefined);
  assert.equal(identityFingerprint("{ nebaigtas"), undefined);
  assert.equal(identityFingerprint("null"), undefined);
});

test("parseEnvFile: komentarai, tuščios eilutės ir be `=` praleidžiami", () => {
  assert.deepEqual(parseEnvFile("# komentaras\n\nAG_UI_PORT = 4200 \nBLOGAI\n=tuščias raktas\n"), {
    AG_UI_PORT: "4200",
  });
});

// ---------------------------------------------------------------------------
// įrašas
// ---------------------------------------------------------------------------

test("readUiServerRecord: sugadintas ar netinkamas įrašas yra `nežinome`, ne klaida", async () => {
  const broken = portWorld({ [uiServerRecordFile(STATE)]: "{ nebaigtas" });
  assert.equal(await readUiServerRecord(broken.ports, STATE), undefined);

  const wrongSchema = portWorld({ [uiServerRecordFile(STATE)]: JSON.stringify({ port: 4200 }) });
  assert.equal(await readUiServerRecord(wrongSchema.ports, STATE), undefined);

  const world = portWorld();
  const written = await writeUiServerRecord(world.ports, STATE, { port: 4200, fingerprint: FINGERPRINT, pid: 42 });
  assert.equal(written.url, uiUrl(4200));
  assert.equal(written.schema_version, UI_SERVER_RECORD_SCHEMA_VERSION);
  assert.deepEqual(await readUiServerRecord(world.ports, STATE), written);
});

// ---------------------------------------------------------------------------
// sprendimas
// ---------------------------------------------------------------------------

test("resolveUiPort: laisvas išvestas portas priimamas", async () => {
  const world = portWorld();
  const resolution = await resolveUiPort({ ports: world.ports, projectRoot: ROOT, runtimeRoot: RUNTIME });

  assert.deepEqual(resolution, {
    status: "available",
    port: derivePreferredUiPort(ROOT, "linux"),
    url: uiUrl(derivePreferredUiPort(ROOT, "linux")),
    source: "derived",
    fingerprint: FINGERPRINT,
  });
});

test("resolveUiPort: svetimas procesas porte NĖRA `already-running`", async () => {
  const world = portWorld();
  const preferred = derivePreferredUiPort(ROOT, "linux");
  // Vien „portas klauso" nebėra įrodymas: be fingerprint'o kandidatas praleidžiamas.
  world.probes.set(preferred, { state: "occupied" });

  const resolution = await resolveUiPort({ ports: world.ports, projectRoot: ROOT, runtimeRoot: RUNTIME });
  assert.equal(resolution.status, "available");
  assert.notEqual(resolution.status === "available" ? resolution.port : 0, preferred);

  // Mūsų fingerprint'as porte — antro serverio kelti nereikia.
  const own = portWorld();
  own.probes.set(preferred, { state: "occupied", fingerprint: FINGERPRINT });
  const running = await resolveUiPort({ ports: own.ports, projectRoot: ROOT, runtimeRoot: RUNTIME });
  assert.deepEqual({ status: running.status, port: running.status === "already-running" ? running.port : 0 }, {
    status: "already-running",
    port: preferred,
  });
});

test("resolveUiPort: override yra VISAS nurodymas — svetimas procesas jame duoda failed", async () => {
  const world = portWorld();
  world.env.set(UI_PORT_ENV, "4200");
  world.probes.set(4200, { state: "occupied" });

  const resolution = await resolveUiPort({ ports: world.ports, projectRoot: ROOT, runtimeRoot: RUNTIME });
  assert.equal(resolution.status, "failed");
  // Tyliai atidaryti UI kitur, nei operatorius liepė, būtų blogiau nei pasakyti tiesą.
  assert.deepEqual(world.probed, [4200]);

  const broken = portWorld();
  broken.env.set(UI_PORT_ENV, "nope");
  const failed = await resolveUiPort({ ports: broken.ports, projectRoot: ROOT, runtimeRoot: RUNTIME });
  assert.equal(failed.status, "failed");
  assert.equal(broken.probed.length, 0, "netinkamas override nė nezonduojamas");
});

test("resolveUiPort: konfigo override galioja, kai aplinkos nėra", async () => {
  const world = portWorld({ [COMMANDS_ENV]: `${UI_PORT_ENV}=4210\n` });
  const resolution = await resolveUiPort({ ports: world.ports, projectRoot: ROOT, runtimeRoot: RUNTIME });

  assert.deepEqual({ status: resolution.status, source: resolution.status === "available" ? resolution.source : "" }, {
    status: "available",
    source: "config",
  });
});

test("resolveUiPort: persistuotas portas priimamas tik su SAVO fingerprint'u", async () => {
  const record = (fingerprint: string, port: number): string =>
    JSON.stringify({
      schema_version: UI_SERVER_RECORD_SCHEMA_VERSION,
      port,
      url: uiUrl(port),
      project_fingerprint: fingerprint,
      pid: 42,
      updated_at: NOW.toISOString(),
    });

  const own = portWorld({ [uiServerRecordFile(STATE)]: record(FINGERPRINT, UI_PORT_RANGE_START + 5) });
  const resolution = await resolveUiPort({ ports: own.ports, projectRoot: ROOT, runtimeRoot: RUNTIME });
  assert.equal(resolution.status === "available" ? resolution.source : "", "state");
  assert.equal(own.probed[0], UI_PORT_RANGE_START + 5, "persistuotas portas tikrinamas pirmas");

  // Nukopijuota svetimo projekto būsena neatiduoda mums jo porto.
  const foreign = portWorld({ [uiServerRecordFile(STATE)]: record("svetimas", UI_PORT_RANGE_START + 5) });
  const derived = await resolveUiPort({ ports: foreign.ports, projectRoot: ROOT, runtimeRoot: RUNTIME });
  assert.equal(derived.status === "available" ? derived.source : "", "derived");
});

test("resolveUiPort: už diapazono esantis persistuotas portas gali duoti tik already-running", async () => {
  const outside = 45000;
  const record = JSON.stringify({
    schema_version: UI_SERVER_RECORD_SCHEMA_VERSION,
    port: outside,
    url: uiUrl(outside),
    project_fingerprint: FINGERPRINT,
    pid: 42,
    updated_at: NOW.toISOString(),
  });

  // Laisvas efemerinis portas: prisirišti prie jo negalima (po restarto atitenka bet kam).
  const free = portWorld({ [uiServerRecordFile(STATE)]: record });
  const resolution = await resolveUiPort({ ports: free.ports, projectRoot: ROOT, runtimeRoot: RUNTIME });
  assert.equal(resolution.status === "available" ? resolution.source : "", "derived");

  // Bet jei ten gyvas MŪSŲ serveris — antro kelti nereikia.
  const live = portWorld({ [uiServerRecordFile(STATE)]: record });
  live.probes.set(outside, { state: "occupied", fingerprint: FINGERPRINT });
  const running = await resolveUiPort({ ports: live.ports, projectRoot: ROOT, runtimeRoot: RUNTIME });
  assert.equal(running.status, "already-running");
});

test("resolveUiPort: skenavimo biudžetas nutraukia paiešką, bet bent vienas kandidatas tikrinamas", async () => {
  const world = portWorld();
  world.defaultProbe = { state: "occupied" };

  const resolution = await resolveUiPort({
    ports: world.ports,
    projectRoot: ROOT,
    runtimeRoot: RUNTIME,
    scanBudgetMs: 0,
  });
  assert.equal(resolution.status, "failed");
  // Nulinis biudžetas nereiškia „nieko net nebandyk".
  assert.equal(world.probed.length, 1);
  assert.match(resolution.status === "failed" ? resolution.reason : "", /gave up after 1 candidate/);
});
