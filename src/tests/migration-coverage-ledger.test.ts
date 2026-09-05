// `migration-coverage.json` yra vienintelis dokumentas, kuris atsako „ar migracija baigta".
// Iki šiol jo neskaitė NĖ VIENAS testas, ir būtent tai leido didžiausiai šio projekto spragai
// pragyventi nuo E0 iki E9: ledger'is buvo sėtas iš VQ-002 inventoriaus, kuris skaičiavo tris
// etalono paketus iš šešių, tad „0 pending" (COV-3) buvo TEISINGAS teiginys apie NETEISINGĄ
// aibę. Trys mobile paketai nebuvo pažymėti kaip praleisti — jų nebuvo išvis, o tyla vartų
// neturi. VQ-801 ir VQ-80A tą pačią aklą dėmę tik pakartotinai patvirtino.
//
// Todėl šis testas tikrina ne formatą, o TEIGINIUS: ar ledger'io vardijama aibė sutampa su
// etalono workspace'u, ir ar kiekvienas „migruota" turi atitikmenį diske. Rankomis prižiūrimas
// registras be varto yra pažadas, ne įrodymas.

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const repoRoot = process.cwd();
const ledgerPath = path.join(repoRoot, "migration-coverage.json");

type ReferencePackage = { reference: string; verqestra_path: string; tracked_as?: string };
type ModuleEntry = {
  module: string;
  target: string;
  wave: string;
  status: string;
  reason?: string;
  evidence?: string;
  note?: string;
};
type Deviation = {
  date: string;
  area: string;
  reason: string;
  direction: string;
  etalon_annotation: string;
  tests: string;
};
type Ledger = {
  schema_version: number;
  source: { reference_packages: ReferencePackage[] };
  rules: { statuses: string[] };
  modules: ModuleEntry[];
  deviations: Deviation[];
};

const ledger: Ledger = JSON.parse(await readFile(ledgerPath, "utf8"));

const sourceExtensions = [".ts", ".tsx"];

/**
 * Įrodymo požymis: kelias, failo vardas, testas, fixture'as ar commit'as.
 *
 * Iki 2026-09-05 „įrodymas" buvo `length >= 40` — tai matuoja teksto ILGĮ, ne jo turinį, tad
 * keturiasdešimt simbolių tvirtinimo („modulis perkeltas ir veikia kaip anksčiau") praeidavo lygiai
 * taip pat, kaip commit'o hash'as su testų skaičiais. Įrodymas privalo rodyti į kažką, ką galima
 * atsiversti.
 */
const NAMES_ARTIFACT = /[\w.-]+\/[\w.-]+|[\w-]+\.(?:ts|tsx|json|md|mjs|css|yaml|yml)\b|\btest|\bfixture|\bcommit\b/i;

function evidenceNamesArtifact(value: string): boolean {
  return value.trim().length >= 40 && NAMES_ARTIFACT.test(value);
}

/**
 * CLAUDE.md: „Kryptis visada griežtinanti." Žodžio ribos yra visa esmė: be jų `negriežtinantis` —
 * tikslus taisyklės PRIEŠINGYBĖS pavadinimas — praeidavo kaip substring'as.
 */
function directionIsStrengthening(value: string): boolean {
  return /\b(?:griežtinantis|grieztinantis)\b/i.test(value);
}

async function countSources(root: string): Promise<number> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => undefined);
  if (entries === undefined) return 0;
  let found = 0;
  for (const entry of entries) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      found += await countSources(absolute);
    } else if (entry.isFile() && sourceExtensions.some((extension) => entry.name.endsWith(extension))) {
      found += 1;
    }
  }
  return found;
}

test("ledger'io schema: kiekvienas modulis turi vardą, taikinį, bangą ir LEISTINĄ statusą", () => {
  assert.equal(ledger.schema_version, 1);
  // Anti-vakuumas: sutrumpėjęs ar tuščias `modules` neturi praeiti tylėdamas.
  assert.ok(ledger.modules.length > 40, `ledger'yje tik ${ledger.modules.length} modulių`);

  const allowed = new Set(ledger.rules.statuses);
  assert.ok(allowed.size >= 3, "statusų aibė sutrumpėjo");

  for (const entry of ledger.modules) {
    for (const field of ["module", "target", "wave", "status"] as const) {
      assert.equal(typeof entry[field], "string", `${entry.module}: trūksta ${field}`);
      assert.notEqual(entry[field].trim(), "", `${entry.module}: tuščias ${field}`);
    }
    assert.ok(allowed.has(entry.status), `${entry.module}: nežinomas statusas ${entry.status}`);
  }
});

test("kiekvienas etalono workspace paketas TURI įrašą ledger'yje", () => {
  const packages = ledger.source.reference_packages;
  // Etalono `pnpm-workspace.yaml` vardija šešis paketus. Skaičius įrašytas, kad sąrašo
  // sutrumpinimas būtų pakeitimas, o ne nutylėjimas — būtent taip spraga ir atsirado.
  assert.equal(packages.length, 6, "etalonas vardija ŠEŠIS workspace paketus");

  for (const declared of packages) {
    const named = ledger.modules.filter((entry) => entry.module.includes(declared.reference));
    // Du teisėti apskaitos būdai. `AG/orchestrator` perstatymo metu buvo IŠSKAIDYTAS į
    // sluoksnius, tad vieno jį vardijančio įrašo nėra ir neturi būti — bet tada privalo būti
    // parašyta, KUR jis apskaitomas. Trečio varianto (nei įrašo, nei paaiškinimo) nėra: būtent
    // ta tyla ir buvo spraga.
    const explained = (declared.tracked_as ?? "").trim().length >= 20;
    assert.ok(
      named.length > 0 || explained,
      `etalono paketas ${declared.reference} neturi NEI ledger'io įrašo, NEI tracked_as ` +
        "paaiškinimo — tai ne sprendimas, o praleidimas (E0..E9 spraga)",
    );
  }
});

test("kiekvienas etalono paketas turi šaltinius diske, o ne tik eilutę registre", async () => {
  for (const declared of ledger.source.reference_packages) {
    const absolute = path.join(repoRoot, ...declared.verqestra_path.split("/"));
    const found = await countSources(absolute);
    assert.ok(
      found > 0,
      `${declared.reference} → ${declared.verqestra_path}: ledger'is teigia perkėlimą, ` +
        "bet kelias tuščias arba jo nėra",
    );
  }
});

test("statusai yra teiginiai, ne etiketės: pending nulis, wont-migrate — pagrįstas", () => {
  const pending = ledger.modules.filter((entry) => entry.status === "pending");
  const migrated = ledger.modules.filter((entry) => entry.status === "migrated");
  const declined = ledger.modules.filter((entry) => entry.status === "wont-migrate");

  assert.ok(migrated.length > 0, "nė vieno migruoto modulio — ledger'is prarado turinį");

  // `wont-migrate` be priežasties yra ta pati tyla, kaip nesantis įrašas: sprendimas, kurio
  // niekas negali patikrinti. Statuso pasirinkimas privalo kainuoti sakinį.
  for (const entry of declined) {
    const justification = entry.reason ?? entry.note ?? "";
    assert.ok(
      justification.trim().length >= 20,
      `${entry.module}: wont-migrate be priežasties`,
    );
  }

  // `pending` NĖRA draudžiamas — jis teisėtas vykstant bangai. Draudžiamas tik tylus
  // pending: įrašas, kuris nesako, ko laukiama.
  for (const entry of pending) {
    const explanation = entry.note ?? entry.reason ?? "";
    assert.ok(explanation.trim().length >= 20, `${entry.module}: pending be paaiškinimo`);
  }
});

test("kiekvienas migruotas etalono paketas remiasi ĮRODYMU, ne tvirtinimu", () => {
  for (const declared of ledger.source.reference_packages) {
    const named = ledger.modules.filter(
      (entry) => entry.module.includes(declared.reference) && entry.status === "migrated",
    );
    for (const entry of named) {
      const evidence = entry.evidence ?? "";
      assert.ok(
        evidenceNamesArtifact(evidence),
        `${entry.module}: statusas migrated be įvardyto įrodymo — evidence privalo minėti kelią, ` +
          "failą, testą ar commit'ą, o ne tik būti pakankamai ilgas",
      );
    }
  }
});

test("kiekvienas nukrypimas užrašytas TRIJOSE vietose ir yra griežtinantis", () => {
  assert.ok(ledger.deviations.length > 0, "nukrypimų sąrašas tuščias");
  for (const deviation of ledger.deviations) {
    for (const field of ["date", "area", "reason", "direction", "etalon_annotation", "tests"] as const) {
      assert.equal(typeof deviation[field], "string", `${deviation.area}: trūksta ${field}`);
      assert.ok(deviation[field].trim().length >= 10, `${deviation.area}: tuščias ${field}`);
    }
    // CLAUDE.md: „Kryptis visada griežtinanti: naujų praleidimų neatsiranda."
    assert.ok(
      directionIsStrengthening(deviation.direction),
      `${deviation.area}: nukrypimo kryptis nėra griežtinanti`,
    );
  }
});

test("apėjimai, kuriuos šis vartas privalo pagauti, yra raudoni", () => {
  // Fixture'ai, ne ledger'io eilutės: taisyklė tikrinama prieš tekstą, kurio registre nėra.
  assert.equal(directionIsStrengthening("negriežtinantis — praleidimas priimtas sąmoningai"), false);
  assert.equal(directionIsStrengthening("negrieztinantis — tas pats be diakritikos"), false);
  assert.equal(directionIsStrengthening("atlaidesnis: vartas išjungtas"), false);
  assert.equal(directionIsStrengthening("griežtinantis — naujų praleidimų neatsiranda"), true);

  assert.equal(
    evidenceNamesArtifact("Modulis perkeltas ir elgiasi lygiai taip pat, kaip elgėsi anksčiau."),
    false,
    "keturiasdešimt simbolių tvirtinimo be nuorodos NĖRA įrodymas",
  );
  assert.equal(evidenceNamesArtifact("src/shared/result.ts — parity per shared-primitives suite (45/45)"), true);
  assert.equal(evidenceNamesArtifact("commit 43fb8217"), false, "įrodymas privalo būti ir konkretus, ir turiningas");
});
