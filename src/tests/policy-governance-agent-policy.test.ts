// Pilnas auditas 2026-09-05, PG-5: `default_role` konfigo semantika. Iki šios pataisos
// laukas buvo `z.unknown().transform(...)` — bet kokia ne-string reikšmė tyliai virsdavo
// „coder", tad sugadintas konfigas atrodydavo pakeistas, o maršrutizavimas likdavo senas.
// Visi kiti policy loader'iai tokiu atveju fail-fast'ina. Fake FS portas, jokio realaus IO.
import assert from "node:assert/strict";
import test from "node:test";
import {
  agentPolicyConfigPath,
  loadAgentPolicy,
  parseAgentPolicy,
} from "../application/policy-governance/agent-policy.js";
import { defaultAgentPolicy } from "../domain/policies/agent-policy-defaults.js";
import type { PolicyConfigFileSystemPort } from "../application/policy-governance/ports.js";

const coderRole = {
  allowed_adapters: ["claude"],
  default_model_hint: "sonnet",
  can_write_code: true,
};

function policyWith(overrides: Record<string, unknown>): Record<string, unknown> {
  return { version: "1", roles: { coder: coderRole }, ...overrides };
}

function fsWith(files: Record<string, string>): PolicyConfigFileSystemPort {
  return { readTextFileIfExists: async (filePath: string) => files[filePath] };
}

test("agent-policy: trūkstamas default_role krenta į 'coder'", () => {
  const parsed = parseAgentPolicy(policyWith({}));
  assert.equal(parsed.default_role, "coder");
  assert.equal(parsed.version, "1");
});

test("agent-policy: ne-string default_role meta klaidą, o ne tyliai virsta 'coder' (PG-5)", () => {
  for (const bad of [42, null, true, ["coder"], { role: "coder" }]) {
    assert.throws(
      () => parseAgentPolicy(policyWith({ default_role: bad })),
      /default_role/,
      `ne-string reikšmė privalo mesti: ${JSON.stringify(bad)}`,
    );
  }

  // Tuščia eilutė irgi nėra vaidmuo — anksčiau ji prasprūsdavo iki „not in roles" klaidos,
  // kuri melavo apie priežastį.
  assert.throws(() => parseAgentPolicy(policyWith({ default_role: "" })), /default_role must not be empty/);
});

test("agent-policy: string default_role tikrinamas prieš roles registrą kaip iki šiol", () => {
  assert.throws(() => parseAgentPolicy(policyWith({ default_role: "nesamas" })), /not in roles/);
  assert.throws(
    () =>
      parseAgentPolicy({
        version: "1",
        default_role: "coder",
        roles: { coder: { ...coderRole, enabled: false } },
      }),
    /cannot be disabled/,
  );
});

test("agent-policy: loadAgentPolicy — nėra failo → default'ai; sugadintas default_role → klaida", async () => {
  const runtimeRoot = "/repo/vq";
  const policyPath = agentPolicyConfigPath(runtimeRoot);

  assert.equal(await loadAgentPolicy(fsWith({}), runtimeRoot), defaultAgentPolicy);

  const loaded = await loadAgentPolicy(fsWith({ [policyPath]: JSON.stringify(policyWith({})) }), runtimeRoot);
  assert.equal(loaded.default_role, "coder");

  await assert.rejects(
    () => loadAgentPolicy(fsWith({ [policyPath]: JSON.stringify(policyWith({ default_role: 42 })) }), runtimeRoot),
    /default_role/,
  );
});
