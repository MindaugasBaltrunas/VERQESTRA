// VQ-504 (64/N): hook įėjimų PILNUMO vartai.
//
// KODĖL ŠIS TESTAS EGZISTUOJA. 2026-08-22 patikra rado, kad iš 17 etalono hook komandų
// VERQESTRA registre buvo tik 4, nors VISI 17 modulių jau parašyti ir ištestuoti. Spraga
// išgyveno ir VQ-50A auditą, ir tai NĖRA audito aplaidumas: auditas paleidžia komandas IŠ
// registro, tad neregistruotas įėjimas jam neegzistuoja pagal konstrukciją. Registras negali
// būti tikrinamas pats prieš save — jį reikia lyginti su IŠORINIU sąrašu.
//
// Todėl čia gyvena etalono hook komandų sąrašas kaip DUOMENYS. Kiekvienas vardas privalo būti
// arba surištas, arba eksplicitiškai deklaruotas kaip dar nesurištas. Tylaus trečio varianto
// nėra: pamiršta komanda nukrenta iš abiejų sąrašų ir sąjungos patikra griūva.

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCliCommands } from "../composition/cli-registry.js";
import { resolveRuntimeRoots } from "../composition/runtime-context.js";
import { POST_WRITE_GUARDS } from "../interfaces/hooks/post-write-guards.js";
import * as hooks from "../interfaces/hooks/index.js";

/**
 * Visos hook komandos, kurias deklaruoja AG_loop `orchestrator/runtime/command-registry.ts`.
 * Sąrašas kopijuojamas PAŽODŽIUI ir keičiamas tik kartu su etalonu — tai parity kontraktas,
 * ne mūsų pasirinkimas.
 */
const ETALON_HOOK_COMMANDS = [
  "hook-backend-guard",
  "hook-frontend-guard",
  "hook-migration-guard",
  "hook-mobile-guard",
  "hook-on-stop",
  "hook-package-guard",
  "hook-post-bash",
  "hook-post-bash-sync",
  "hook-post-read",
  "hook-post-write",
  "hook-pre-bash",
  "hook-pre-write",
  "hook-secret-scan",
  "hook-session-end",
  "hook-session-start",
  "hook-session-summary",
  "hook-user-prompt",
] as const;

/**
 * Dar nesurištos hook komandos. Moduliai jau yra `interfaces/hooks`, trūksta tik portų
 * adapterio ir registro eilutės — kiekvienas įrašas čia yra ATVIRA SKOLA, ne sprendimas.
 *
 * Sąrašas privalo TRUMPĖTI. Naujas įrašas čia leidžiamas tik tada, kai etalonas įgyja naują
 * hook'ą, kurio dar nemigravome.
 */
const PENDING_HOOK_COMMANDS = [
  "hook-on-stop",
  "hook-session-end",
  "hook-session-start",
  "hook-session-summary",
  "hook-user-prompt",
] as const;

function registryHookCommands(): string[] {
  const roots = resolveRuntimeRoots({ env: () => "/repo" });
  return buildCliCommands({ roots })
    .map((command) => command.name)
    .filter((name) => name.startsWith("hook-"));
}

test("hook registras: surištos ir deklaruotai nesurištos komandos padengia VISĄ etaloną", () => {
  const wired = registryHookCommands();
  const union = new Set([...wired, ...PENDING_HOOK_COMMANDS]);

  for (const name of ETALON_HOOK_COMMANDS) {
    assert.equal(
      union.has(name),
      true,
      `${name} nėra nei registre, nei PENDING sąraše — hook įėjimas dingo tyliai`,
    );
  }
  assert.equal(union.size, ETALON_HOOK_COMMANDS.length, "registre yra hook komanda, kurios etalonas neturi");
});

test("hook registras: PENDING sąrašas negali dengti jau surištos komandos", () => {
  const wired = new Set(registryHookCommands());
  for (const name of PENDING_HOOK_COMMANDS) {
    assert.equal(wired.has(name), false, `${name} jau surištas — pašalink jį iš PENDING sąrašo`);
  }
});

test("hook registras: PostToolUse fan-out'as spawnina TIK egzistuojančias komandas", () => {
  // `POST_WRITE_GUARDS` nurodo guard'us VARDU ir paleidžia juos atskiru procesu, tad registro
  // spraga čia nevirsta kompiliavimo klaida — ji virsta tyliu non-zero exit'u žurnale, kurio
  // niekas neskaito. Šis testas paverčia tokį neatitikimą matomu.
  const wired = new Set(registryHookCommands());
  for (const guard of POST_WRITE_GUARDS) {
    assert.equal(wired.has(guard.command), true, `${guard.command} spawninamas, bet registre jo nėra`);
  }
});

test("hook registras: kiekviena surišta komanda turi realų `interfaces/hooks` įėjimą", () => {
  // Vardo konvencija yra vienintelis dalykas, siejantis komandą su moduliu, tad ji tikrinama:
  // `hook-pre-bash` → `hookPreBash`. Neatitikimas reikštų, kad registras kviečia ką kita, nei
  // deklaruoja jo vardas.
  const exported = new Set(
    Object.entries(hooks)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name),
  );

  for (const name of registryHookCommands()) {
    const camel = name.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
    assert.equal(exported.has(camel), true, `${name} neturi eksportuoto ${camel} įėjimo`);
  }
});
