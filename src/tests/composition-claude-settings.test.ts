// VQ-701: `.claude/settings.json` yra KONTRAKTAS tarp Claude Code ir šio registro.
//
// Kodėl tam reikia testo: settings failas gyvena už TypeScript ribų, tad pervadinta ar pašalinta
// komanda jame lieka kaip eilutė, kurios niekas nebepatikrina. Gedimas būtų tyliausias įmanomas —
// hook'as tiesiog nieko nedarytų, o operatorius manytų, kad vartai veikia. Būtent ši klasė
// („parašyta, ištestuota, neprijungta" ir jos veidrodis „prijungta prie neegzistuojančio")
// kartojosi visoje E5–E7 eigoje, tad ji pin'inama abiem kryptimis.
//
// Tikrinami DU failai: šio repo settings (self-hosting) ir `templates/.claude/settings.json`
// (tai, ką `verqestra install` įdiegia svetimam projektui). Antrasis svarbesnis: jo klaida
// keliauja į kiekvieną diegimą.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { buildCliCommands } from "../composition/cli/registry.js";
import { resolveRuntimeRoots } from "../composition/runtime/context.js";

/**
 * Claude Code įvykis → hook'ai, kurie jame PRIVALO stovėti.
 *
 * Iki 2026-09-05 čia buvo vien įvykių vardų sąrašas, o tikrinimas — `length > 0`. Tai reiškė, kad
 * `PostToolUse` su vienu `hook-post-read` įrašu buvo lygiai toks pat žalias kaip su visais trimis:
 * dingęs `hook-post-write` (sesijos rašymų ledger'is ir guard fan-out) nebūtų pastebėtas niekur.
 * Įvykio BUVIMAS nėra vartas; vartas yra jo turinys, tad turinys užrašytas.
 */
const REQUIRED_HOOKS_BY_EVENT: Record<string, readonly string[]> = {
  SessionStart: ["hook-session-start"],
  UserPromptSubmit: ["hook-user-prompt"],
  PreToolUse: ["hook-pre-bash", "hook-pre-write"],
  PostToolUse: ["hook-post-bash", "hook-post-read", "hook-post-write"],
  Stop: ["hook-on-stop"],
  SessionEnd: ["hook-session-end"],
};

/**
 * Registro `hook-*` komandos, kurių settings faile NĖRA — ir kodėl.
 *
 * Iki 2026-09-05 vartas tikrino tik kryptį „settings → registras". Priešinga pusė („parašyta,
 * ištestuota, neprijungta") liko nematoma, nors antraštė žada abi. Sąrašas literalus ir su
 * priežastimis: tyli išimtis yra ta pati spraga, tik kitoje eilutėje.
 */
const NOT_IN_SETTINGS: Record<string, string> = {
  // Guard'ai nekviečiami iš settings — juos fan-out'ina `hook-post-write` ir `hook-on-stop`
  // (`interfaces/hooks/post-write-guards.ts`, `interfaces/hooks/stop-guards.ts`). Tą suvielinimą
  // saugo `composition-hook-registry.test.ts`, ne šis failas.
  "hook-secret-scan": "spawn per post-write/stop guard fan-out",
  "hook-package-guard": "spawn per post-write/stop guard fan-out",
  "hook-migration-guard": "spawn per post-write/stop guard fan-out",
  "hook-backend-guard": "spawn per post-write/stop guard fan-out",
  "hook-frontend-guard": "spawn per post-write/stop guard fan-out",
  "hook-mobile-guard": "spawn per post-write/stop guard fan-out",
  "hook-session-summary": "spawn per `composition/hooks/session-adapters.ts` runSessionSummary",
  // ATVIRA SPRAGA, ne sprendimas: pilnas auditas 2026-09-05 (P2, „Nesuvielinti mechanizmai") rado,
  // kad ši komanda registre yra, o kviečiama nėra NIEKUR. Ją uždaro task 207; kol tai neįvyko,
  // išimtis laiko spragą užrašytą, o ne nutylėtą.
  "hook-post-bash-sync": "audito 2026-09-05 P2 — registruota, bet nesuvielinta (task 207)",
};

type SettingsFile = {
  hooks?: Record<string, Array<{ matcher?: string; hooks?: Array<{ command?: string; type?: string }> }>>;
};

async function readSettings(relativePath: string): Promise<SettingsFile> {
  return JSON.parse(await readFile(path.resolve(process.cwd(), relativePath), "utf8")) as SettingsFile;
}

/** Įvykis → jame minimos `hook-*` komandos, nesvarbu, kokia forma jos kviečiamos. */
function hookCommandsByEvent(settings: SettingsFile): Record<string, string[]> {
  const byEvent: Record<string, string[]> = {};
  for (const [event, entries] of Object.entries(settings.hooks ?? {})) {
    const names = new Set<string>();
    for (const entry of entries) {
      for (const hook of entry.hooks ?? []) {
        const match = /(?:^|\s)(hook-[a-z0-9-]+)(?:\s|$)/.exec(hook.command ?? "");
        if (match?.[1]) names.add(match[1]);
      }
    }
    byEvent[event] = [...names].sort();
  }
  return byEvent;
}

/** Visos `hook-*` komandos, kurias mini settings failas. */
function hookCommandsIn(settings: SettingsFile): string[] {
  return [...new Set(Object.values(hookCommandsByEvent(settings)).flat())].sort();
}

function registeredCommandNames(): Set<string> {
  const roots = resolveRuntimeRoots({ env: () => "/repo" });
  return new Set(buildCliCommands({ roots }).map((command) => command.name));
}

/** Registro `hook-*` komandos, kurių settings nemini ir kurioms nėra užrašytos išimties. */
function unwiredHooks(registered: Iterable<string>, referenced: readonly string[]): string[] {
  return [...registered]
    .filter((name) => name.startsWith("hook-"))
    .filter((name) => !referenced.includes(name) && NOT_IN_SETTINGS[name] === undefined)
    .sort();
}

for (const relativePath of [".claude/settings.json", "templates/.claude/settings.json"]) {
  test(`${relativePath}: kiekvienas hook'as yra REGISTRE`, async () => {
    const settings = await readSettings(relativePath);
    const registered = registeredCommandNames();
    const referenced = hookCommandsIn(settings);

    assert.ok(referenced.length > 0, "settings failas nemini nė vieno hook'o");
    for (const name of referenced) {
      assert.equal(registered.has(name), true, `${relativePath} kviečia "${name}", kurio registre NĖRA`);
    }
  });

  test(`${relativePath}: kiekvienas REGISTRO hook'as arba prijungtas, arba turi užrašytą išimtį`, async () => {
    const settings = await readSettings(relativePath);
    const unwired = unwiredHooks(registeredCommandNames(), hookCommandsIn(settings));
    assert.deepEqual(
      unwired,
      [],
      `registre yra, o ${relativePath} nemini: ${unwired.join(", ")} — arba prijunk, arba įrašyk ` +
        "priežastį į NOT_IN_SETTINGS (išimtis su priežastimi yra sprendimas, tyla — spraga)",
    );
  });

  test(`${relativePath}: kiekvienas privalomas įvykis turi TIKSLIAI jam priklausančius hook'us`, async () => {
    const settings = await readSettings(relativePath);
    const byEvent = hookCommandsByEvent(settings);

    assert.deepEqual(
      Object.keys(byEvent).sort(),
      Object.keys(REQUIRED_HOOKS_BY_EVENT).sort(),
      `${relativePath} įvykių rinkinys nesutampa su privalomu — įvykis be įrašo yra išjungtas vartas`,
    );
    for (const [event, required] of Object.entries(REQUIRED_HOOKS_BY_EVENT)) {
      assert.deepEqual(byEvent[event] ?? [], [...required], `${relativePath} ${event}: hook'ų rinkinys nesutampa`);
    }
  });
}

test("apėjimai, kuriuos šis vartas privalo pagauti, yra raudoni", () => {
  // Fixture'ai, ne settings failai: taisyklė tikrinama prieš konfigą, kurio repo neturi.
  const registry = ["hook-on-stop", "hook-brand-new", "hook-secret-scan", "loop"];
  assert.deepEqual(
    unwiredHooks(registry, ["hook-on-stop"]),
    ["hook-brand-new"],
    "naujas registro hook'as be settings įrašo ir be išimties privalo kristi",
  );
  assert.deepEqual(unwiredHooks(registry, ["hook-on-stop", "hook-brand-new"]), []);

  const stripped: SettingsFile = {
    hooks: { PostToolUse: [{ hooks: [{ type: "command", command: "verqestra hook-post-read" }] }] },
  };
  assert.deepEqual(hookCommandsByEvent(stripped)["PostToolUse"], ["hook-post-read"]);
  assert.notDeepEqual(hookCommandsByEvent(stripped)["PostToolUse"], [...(REQUIRED_HOOKS_BY_EVENT["PostToolUse"] ?? [])]);
});

test(".claude/settings.json: Stop vartas prijungtas prie hook-on-stop", async () => {
  // Atskiras teiginys, nes tai VIENINTELIS hook'as, kuris rašo į git istoriją. Jo dingimas iš
  // settings failo nebūtų matomas niekur kitur: sesija tiesiog nustotų commit'inti, o darbas
  // liktų nekommit'intas be jokio pranešimo.
  const settings = await readSettings(".claude/settings.json");
  const stopCommands = (settings.hooks?.["Stop"] ?? []).flatMap((entry) =>
    (entry.hooks ?? []).map((hook) => hook.command ?? ""),
  );
  assert.equal(
    stopCommands.some((command) => command.includes("hook-on-stop")),
    true,
  );
});
