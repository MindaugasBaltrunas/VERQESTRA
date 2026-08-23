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

/** Claude Code hook įvykiai, kuriuos šis produktas naudoja. Trūkstamas įvykis = neveikiantis vartas. */
const REQUIRED_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "SessionEnd",
] as const;

type SettingsFile = {
  hooks?: Record<string, Array<{ matcher?: string; hooks?: Array<{ command?: string; type?: string }> }>>;
};

async function readSettings(relativePath: string): Promise<SettingsFile> {
  return JSON.parse(await readFile(path.resolve(process.cwd(), relativePath), "utf8")) as SettingsFile;
}

/** Visos `hook-*` komandos, kurias mini settings failas, nesvarbu, kokia forma jos kviečiamos. */
function hookCommandsIn(settings: SettingsFile): string[] {
  const names = new Set<string>();
  for (const entries of Object.values(settings.hooks ?? {})) {
    for (const entry of entries) {
      for (const hook of entry.hooks ?? []) {
        const match = /(?:^|\s)(hook-[a-z0-9-]+)(?:\s|$)/.exec(hook.command ?? "");
        if (match?.[1]) names.add(match[1]);
      }
    }
  }
  return [...names].sort();
}

function registeredCommandNames(): Set<string> {
  const roots = resolveRuntimeRoots({ env: () => "/repo" });
  return new Set(buildCliCommands({ roots }).map((command) => command.name));
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

  test(`${relativePath}: visi privalomi Claude Code įvykiai padengti`, async () => {
    const settings = await readSettings(relativePath);
    for (const event of REQUIRED_EVENTS) {
      assert.ok((settings.hooks?.[event]?.length ?? 0) > 0, `${relativePath} neturi ${event} įrašo`);
    }
  });
}

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
