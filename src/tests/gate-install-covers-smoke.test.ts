// Vartas: ką reikalauja `smoke`, tą privalo atvežti `install`.
//
// Incidentas (2026-09-04): `templates/vq/config/` vežė `commands.env.example` ir
// `models.env.example`, o `smoke` tikrino `vq/config/commands.env` / `models.env`. Vardai
// prasilenkė, tad ŠVARUS diegimas — `verqestra install` ir iškart `verqestra smoke` — krisdavo
// `AG_SMOKE_FAILED` dviem FAIL eilutėm, nors nieko nebuvo padaryta ne taip.
//
// Kodėl to nepagavo esami testai: `interfaces-cli-bootstrap.test.ts` install pusę tikrina per
// sintetinį `TEMPLATE_ENTRIES` (`.claude/settings.json`, `CLAUDE.md`), o smoke pusę — per atskirą
// `HEALTHY_PATHS` sąrašą. Abu sąrašai teisingi kiekvienas sau ir gali išsiskirti tyliai; realaus
// `templates/` medžio nemato nė vienas. Todėl šis vartas skaito TIKRUS failus iš disko.
//
// `dist/cli.js` sąmoningai neįtrauktas: tai šio diegimo CLI, o ne šablonas. `install` jo neveža ir
// negali — jį pagamina `pnpm build`, ir jį saugo atskiras `build-gate`.

import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  SMOKE_REQUIRED_PROJECT_FILES,
  SMOKE_REQUIRED_RUNTIME_FILES,
} from "../interfaces/cli/bootstrap/smoke.js";

const TEMPLATES_ROOT = path.resolve(process.cwd(), "templates");

/**
 * Runtime konfigų sąrašas, užrašytas ČIA, o ne importuotas.
 *
 * Iki 2026-09-05 visi šio failo testai suko `SMOKE_REQUIRED_RUNTIME_FILES` — TESTUOJAMO modulio
 * eksportą. Tai reiškė, kad `config/models.env` išbraukimas iš smoke sąrašo padarydavo abi puses
 * žalias vienu redagavimu: reikalavimas dingdavo kartu su jo tikrinimu. Vartas, kurio apimtį
 * nustato tikrinamasis, nėra vartas. Sąrašo dubliavimas yra to kaina ir sąmoningas.
 */
const EXPECTED_RUNTIME_FILES = ["config/commands.env", "config/models.env"] as const;

/** Env priskyrimo pažeidimai. Grynas, kad taisyklę matytų ir korpusas, ir fixture'as. */
function envAssignmentViolations(line: string): string[] {
  const assignment = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
  if (assignment === null) return [`ne env eilutė: ${line}`];
  // `FOO=` praeidavo ankstesnį `…\s*=` šabloną. Tuščia reikšmė yra tas pats tylus gedimas kaip
  // tuščias failas: `smoke` spausdina OK, krautuvas nuskaito nieką ir krenta į default'ą.
  const value = (assignment[2] ?? "").trim().replace(/^(["'])(.*)\1$/, "$2");
  return value === "" ? [`\`${assignment[1] ?? line}\` be reikšmės`] : [];
}

/** Šablonų failas, atitinkantis smoke reikalaujamą kelią target projekte. */
function templateFor(relativePosixPath: string, underVq: boolean): string {
  const segments = relativePosixPath.split("/");
  return path.join(TEMPLATES_ROOT, ...(underVq ? ["vq", ...segments] : segments));
}

function readTemplate(absolutePath: string): string | undefined {
  try {
    if (!statSync(absolutePath).isFile()) return undefined;
    return readFileSync(absolutePath, "utf8");
  } catch {
    return undefined;
  }
}

test("smoke runtime sąrašas sutampa su ŠIO testo literalu", () => {
  assert.deepEqual(
    [...SMOKE_REQUIRED_RUNTIME_FILES],
    [...EXPECTED_RUNTIME_FILES],
    "smoke runtime reikalavimų sąrašas pasikeitė — jei tai sprendimas, pakeisk ir čia esantį literalą " +
      "kartu su priežastimi; jei ne, sąrašas buvo tyliai apkarpytas",
  );
});

test("kiekvieną `smoke` reikalaujamą failą veža `templates/`", () => {
  const missing: string[] = [];

  for (const relative of SMOKE_REQUIRED_RUNTIME_FILES) {
    const source = templateFor(relative, true);
    if (readTemplate(source) === undefined) missing.push(`vq/${relative} → ${path.relative(process.cwd(), source)}`);
  }
  for (const relative of SMOKE_REQUIRED_PROJECT_FILES) {
    const source = templateFor(relative, false);
    if (readTemplate(source) === undefined) missing.push(`${relative} → ${path.relative(process.cwd(), source)}`);
  }

  assert.deepEqual(
    missing,
    [],
    "šablonuose nėra failo, kurio `smoke` reikalaus po diegimo — švarus install → smoke kris AG_SMOKE_FAILED",
  );
});

test("šablonų env failai vardu YRA galutiniai, ne `.example` juodraščiai", () => {
  // Pervadinimas atgal į `.example` praeitų viršutinį testą tik tada, jei kartu būtų pakeistas ir
  // `SMOKE_REQUIRED_RUNTIME_FILES`. Šis testas fiksuoja būtent tą porą: smoke sąrašas negali
  // nudreifuoti į šablono vardą, nes tada `install` vėl vežtų juodraštį į gyvą konfigo kelią.
  for (const relative of SMOKE_REQUIRED_RUNTIME_FILES) {
    assert.doesNotMatch(
      relative,
      /\.example$/,
      `\`${relative}\` yra šablono juodraščio vardas — smoke privalo reikalauti galutinio konfigo`,
    );
  }
});

test("vežami env šablonai turi turinį — tuščias failas praeina `exists`, bet nieko nenustato", () => {
  // Tuščias `commands.env` yra tyliausias gedimas visoje grandinėje: `smoke` spausdina OK (jis
  // tikrina tik egzistavimą), o krautuvai nuskaito nieką ir krenta į default'us — 2026-09-04
  // šiame repo `MAX_RETRIES_PER_ERROR=4` taip virto tyliu 2.
  for (const relative of EXPECTED_RUNTIME_FILES) {
    const source = templateFor(relative, true);
    const text = readTemplate(source) ?? "";
    const assignments = text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));

    assert.ok(
      assignments.length > 0,
      `\`templates/vq/${relative}\` neturi nė vienos reikšmės — diegimas atvežtų tuščią konfigą`,
    );
    const violations = assignments.flatMap((line) => envAssignmentViolations(line));
    assert.deepEqual(violations, [], `\`templates/vq/${relative}\`: ${violations.join("; ")}`);
  }
});

test("apėjimai, kuriuos šis vartas privalo pagauti, yra raudoni", () => {
  // Fixture'ai, ne korpusas: taisyklė tikrinama prieš tekstą, kurio `templates/` neturi.
  assert.notDeepEqual(envAssignmentViolations("FOO="), []);
  assert.notDeepEqual(envAssignmentViolations("FOO=   "), []);
  assert.notDeepEqual(envAssignmentViolations('FOO=""'), []);
  assert.notDeepEqual(envAssignmentViolations("export FOO="), []);
  assert.notDeepEqual(envAssignmentViolations("tiesiog tekstas"), []);
  assert.deepEqual(envAssignmentViolations("FOO=1"), []);
  assert.deepEqual(envAssignmentViolations("export CLAUDE_OPUS_MODEL=opus"), []);
});
