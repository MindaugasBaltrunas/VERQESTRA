// Sąjungos, PERSAKYTOS abiejose laido pusėse (2026-08-24, dublikatų/mirusio kodo auditas).
//
// `ui-app` yra atskiras workspace su savo toolchain'u, tad importas iš `src/` sulaužytų jo
// build'ą — kiekviena bendra reikšmių aibė ten perrašyta ranka. Iki šio varto jas laikė tik tai,
// kad kažkada jas rašė tas pats žmogus.
//
// Vartas ne teorinis: jį rašant rastas realus nesutapimas — `PolicyProposalRouting` kliente turėjo
// `"openspec"`, kurio serverio `z.enum(POLICY_ROUTINGS)` neleidžia, tad ta reikšmė laidu niekada
// negalėjo atkeliauti. Sąjungos narys, kurio wire negali atnešti, kviečia parašyti šaką, kuri
// niekada neįvyks ir atrodys kaip veikianti.
//
// Ta pati technika kaip `benchmark-restated-contracts`: šaltinis skaitomas kaip TEKSTAS, tad
// pervadinta ar perkelta deklaracija krenta su „nerasta", o ne tyliai praeina.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const SRC = path.join(process.cwd(), "src");
const CLIENT_TYPES = path.join(process.cwd(), "ui-app", "src", "model", "types.ts");

/** Eilučių literalai iš `as const` sąrašo arba iš tipo sąjungos — abi formos duoda tą pačią aibę. */
function literalsOf(declaration: string): string[] {
  return [...declaration.matchAll(/"([^"]+)"/g)].map((match) => match[1] as string);
}

async function declaredLiterals(file: string, pattern: RegExp, what: string): Promise<string[]> {
  const source = await readFile(file, "utf8");
  const match = pattern.exec(source);
  assert.ok(
    match?.[1] !== undefined,
    `${what} nerasta ${path.relative(process.cwd(), file)} — deklaracija pervadinta arba perkelta, ` +
      "ir persakymas nebeturi su kuo būti sulygintas",
  );
  const values = literalsOf(match[1]);
  // Be šito vartas praeitų TUŠČIOMIS: pakeitus deklaracijos formą abi pusės grąžintų `[]`, o
  // `deepEqual([], [])` yra sutapimas be turinio.
  assert.ok(values.length > 0, `${what} neišparsinta į literalus — sulyginimas būtų tuščias`);
  return values;
}

const typeUnion = (alias: string): RegExp => new RegExp(`export type ${alias} =([^;]+);`);
const constArray = (name: string): RegExp => new RegExp(`export const ${name}[^=]*= \\[([^\\]]+)\\]`);

/** Vienas persakymas: serverio deklaracija ↔ `ui-app` tipo sąjunga. */
const RESTATED: { client: string; file: string; pattern: RegExp; what: string; why: string }[] = [
  {
    client: "TaskBucket",
    file: path.join(SRC, "domain", "tasks", "buckets.ts"),
    pattern: typeUnion("TaskBucket"),
    what: "TaskBucket",
    why: "nežinomas bucket'as ekrane liktų be kortelės, o `/api/tasks?bucket=` grąžintų 400",
  },
  {
    client: "LoopSlotMode",
    file: path.join(SRC, "application", "scheduling", "loop-control-store.ts"),
    pattern: constArray("LOOP_SLOT_MODES"),
    what: "LOOP_SLOT_MODES",
    why: "klientas siųstų režimą, kurį `setSlotMode` atmestų 400",
  },
  {
    client: "LoopWorkerId",
    file: path.join(SRC, "application", "scheduling", "loop-control-store.ts"),
    pattern: constArray("LOOP_SLOT_KEYS"),
    what: "LOOP_SLOT_KEYS",
    why: "trečias slot'as serveryje liktų be kortelės kliente",
  },
  {
    client: "LoopSlotState",
    file: path.join(SRC, "interfaces", "ui-model", "loop-slot-model.ts"),
    pattern: typeUnion("UiLoopSlotState"),
    what: "UiLoopSlotState",
    why: "nauja slot'o būsena ekrane virstų nežinoma",
  },
  {
    client: "AgentStatus",
    file: path.join(SRC, "interfaces", "ui-model", "agent-activity.ts"),
    pattern: typeUnion("AgentStatus"),
    what: "AgentStatus",
    why: "grandinės žingsnis be atpažintos būsenos prarastų spalvą ir prasmę",
  },
  {
    client: "PolicyProposalRouting",
    file: path.join(SRC, "application", "policy-governance", "policy-proposals-log.ts"),
    pattern: constArray("POLICY_ROUTINGS"),
    what: "POLICY_ROUTINGS",
    why: "klientas deklaruotų maršrutą, kurio serverio zod enum niekada nepraleidžia",
  },
];

for (const entry of RESTATED) {
  test(`persakyta sąjunga sutampa: ${entry.client}`, async () => {
    const server = await declaredLiterals(entry.file, entry.pattern, entry.what);
    const client = await declaredLiterals(CLIENT_TYPES, typeUnion(entry.client), entry.client);

    // Rūšiuojama: tvarka yra kiekvienos pusės reikalas, o sutapti privalo AIBĖ.
    assert.deepEqual([...client].sort(), [...server].sort(), entry.why);
  });
}
