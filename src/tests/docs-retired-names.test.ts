// Vartas prieš PASENUSIĄ dokumentaciją: pašalintas vardas neturi likti nei kode, nei komentaruose.
//
// 2026-08-23 ta pati klaidos klasė pasikartojo DUKART. Pirmą kartą `wave-graph.ts` antraštė liko
// skelbti, kad neperskaitytas grafas bangos nestabdo, nors elgesys jau buvo priešingas. Antrą kartą
// — po `blockWaveWithoutGraph` → `planWaveWithoutGraph` pervadinimo ir po atlaidžiojo variklio
// ištrynimo — keturi komentarai liko rodyti į tai, ko nebėra.
//
// Pasenusi dokumentacija pavojingesnė už jokią: ji TIKSLIAI aprašo spragą, kurios nebėra, ir kviečia
// ją atkurti. Testas paverčia „reikia nepamiršti" į „neįmanoma pamiršti".
//
// Kaip naudoti: pervadinus ar ištrynus eksportą, įrašyk senąjį vardą į `RETIRED`. Testas kris tol,
// kol jo liks kode ar komentaruose. Įrašas iš sąrašo NETRINAMAS — jis pigus ir saugo amžinai.
import assert from "node:assert/strict";
import test from "node:test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const SRC_ROOT = path.resolve(process.cwd(), "src");

/** Žyma eilutėje, kuri senąjį vardą mini SĄMONINGAI (pervadinimo istorija), o ne per užmaršumą. */
const ALLOW_MARKER = "retired-name-ok";

/** Vardas → kuo pakeistas (arba kodėl pašalintas). Rodoma kritus, kad taisymas būtų akivaizdus. */
const RETIRED: Record<string, string> = {
  blockWaveWithoutGraph: "planWaveWithoutGraph (2026-08-23: transformacija tapo konstruktoriumi)",
  reportSnapshot: "reportStoredGraph (2026-08-23: vardas skambėjo kaip snapshot'o panaudojimas)",
  resolveDependency: "queueSliceFromGraph + resolveTaskNode (2026-08-23: atlaidus rezolveris ištrintas)",
  detectCycles: "detectCyclesOverEdges (2026-08-23: algoritmas iškeltas į domain/adjacency)",
  computeDepths: "longestDependencyDepths (2026-08-23: algoritmas iškeltas į domain/adjacency)",
};

async function collect(dir: string, out: string[]): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await collect(full, out);
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
}

test("gate: pašalinti vardai neminimi nei kode, nei komentaruose", async () => {
  const files: string[] = [];
  await collect(SRC_ROOT, files);

  const offenders: string[] = [];
  for (const file of files) {
    // Šis failas VARDIJA senuosius vardus pagal paskirtį — kitaip jis kristų pats.
    if (file.endsWith("docs-retired-names.test.ts")) continue;
    const relative = path.relative(SRC_ROOT, file).split(path.sep).join("/");

    for (const [position, line] of (await readFile(file, "utf8")).split("\n").entries()) {
      // Sąmoninga istorinė nuoroda („anksčiau vadinosi X") yra teisėta ir vertinga: ji paaiškina,
      // kodėl vardas pasikeitė. Ji pažymima aiškiai, kad vartas skirtų ją nuo užmirštos nuorodos.
      if (line.includes(ALLOW_MARKER)) continue;

      for (const [retired, replacement] of Object.entries(RETIRED)) {
        // Žodžio ribos, ne substring: `detectCycles` yra `detectCyclesOverEdges` PRIEŠDĖLIS, ir be
        // šito vartas skųstųsi dėl paties pakaitalo.
        if (!new RegExp(`\\b${retired}\\b`).test(line)) continue;
        offenders.push(`${relative}:${position + 1}: ${retired} → ${replacement}`);
      }
    }
  }

  assert.deepEqual(offenders, [], `pasenusios nuorodos:\n  ${offenders.join("\n  ")}`);
});
