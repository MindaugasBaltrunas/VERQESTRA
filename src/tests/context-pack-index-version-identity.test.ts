// Ar INDEKSO VERSIJA realiai dalyvauja pack'o tapatybėje — per visą kelią, ne per sudedamąsias dalis.
//
// 2026-08-23 radinys buvo: `code_index` deskriptorius saugojo tik `fresh:<source_hash>`, tad pack'as,
// sudėtas iš SKURDESNIO indekso, grįždavo kaip pilnavertis hit'as — šaltinių hash'as nuo indeksuotojo
// semantikos nepriklauso. Taisymas buvo STRUKTŪRINIS: deskriptorius tapo `fresh:<versija>:<hash>`.
//
// Bet 2026-08-24 peržiūra rado, kad tas taisymas neturi savo testo:
//   • `context-pack-code-index-identity` tikrina, kad MANIFESTAS neša versiją, ir kad tie patys
//     failai duoda tą patį `source_hash` — sudedamąsias dalis, ne vartą;
//   • `infrastructure-state` tikrina, kad kešas atmeta pasikeitusį deskriptorių, bet SINTETINIAIS
//     eilutėmis (`"sha256:abc"` → `"sha256:kitas"`), t. y. neprikala gamintojo FORMATO.
//
// Vadinasi, grąžinus `currentCodeIndexDescriptor` į `fresh:${source_hash}` be versijos, VISI testai
// būtų likę žali. Šis failas uždaro būtent tą spragą: jis reprodukuoja operatoriaus scenarijų —
// indeksas perstatomas su NAUJA versija, failai nepasikeitę, — ir reikalauja MISS.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assembleContextPack } from "../application/context-pack/assemble/assemble.js";
import { buildCodeIndex } from "../application/code-intelligence/indexing/builder.js";
import { codeIndexVersion } from "../application/code-intelligence/indexing/types.js";
import { createContextCacheAdapter, readContextCacheEntries } from "../infrastructure/persistence/context-cache-store.js";
import { createCodeIntelligenceFsAdapter } from "../infrastructure/fs/code-intelligence-fs-adapter.js";
import { nodeFsAdapter } from "../infrastructure/fs/node-fs-adapter.js";

const TASK = [
  "# Task",
  "",
  "## Tikslas",
  "Pakeisti demo eksportą.",
  "",
  "## Failai",
  "Leidžiama:",
  "- `src/module/a.ts`",
  "",
  "## Veiksmas",
  "- Pakeisti eksportą.",
  "",
  "## Patikra",
  "- `pnpm test`",
  "",
  "## Stop",
  "Kai žalia.",
  "",
].join("\n");

async function world(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vq-index-identity-"));
  await mkdir(path.join(root, "AG", "tasks", "queue"), { recursive: true });
  await mkdir(path.join(root, "src", "module"), { recursive: true });
  await writeFile(path.join(root, "AG", "tasks", "queue", "0042-demo.md"), TASK, "utf8");
  await writeFile(path.join(root, "src", "module", "a.ts"), 'export function demo(): string {\n  return "x";\n}\n', "utf8");
  await buildCodeIndex(createCodeIntelligenceFsAdapter(root), root);
  return root;
}

/** Deskriptorius, kurį pack'as realiai užfiksavo — iš saugomo kešo įrašo, ne iš prielaidos. */
async function storedDescriptor(root: string): Promise<string | undefined> {
  const entries = await readContextCacheEntries(path.join(root, "vq"));
  return entries[0]?.entry.code_index;
}

/**
 * Paskutinio surinkimo `cache_status` iš telemetrijos.
 *
 * `ContextPackResult` kešo būsenos neneša — ji rašoma į `vq/logs/context-size.jsonl`, tad hit/miss
 * stebimas ten, kur produktas jį realiai deklaruoja.
 */
async function lastCacheStatus(root: string): Promise<string | undefined> {
  const raw = await nodeFsAdapter.readTextFileIfExists(path.join(root, "vq", "logs", "context-size.jsonl"));
  const last = (raw ?? "").trim().split("\n").at(-1);
  if (!last) return undefined;
  return (JSON.parse(last) as Record<string, unknown>)["cache_status"] as string | undefined;
}

test("gamintojo deskriptorius neša INDEKSO VERSIJĄ, ne tik šaltinių hash'ą", async () => {
  const root = await world();
  try {
    const deps = {
      fs: nodeFsAdapter,
      codeFs: createCodeIntelligenceFsAdapter(root),
      cache: createContextCacheAdapter(root, path.join(root, "vq")),
    };
    await assembleContextPack(["AG/tasks/queue/0042-demo.md"], root, deps);
    assert.equal(await lastCacheStatus(root), "miss", "kontrolė: pirmas surinkimas yra miss");

    const descriptor = await storedDescriptor(root);
    assert.ok(descriptor, "įrašas privalo būti išsaugotas");
    assert.match(
      descriptor,
      new RegExp(`^fresh:${codeIndexVersion.replace(/\./g, "\\.")}:[0-9a-f]{64}:[0-9a-f]{64}$`),
      `deskriptorius privalo būti fresh:<versija>:<source_hash>:<records_hash>, gauta: ${descriptor}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// `records_hash` deskriptoriuje uždaro tai, ko VERSIJA nemato: pakeistą ištraukimo logiką be
// versijos kėlimo. Versija yra DEKLARACIJA ir remiasi rankiniu kontraktu; `records_hash` yra
// faktinė indekso IŠVESTIS, tad tokiu atveju pack'ai anuliuojami vis tiek.
test("kitoks indekso TURINYS anuliuoja pack'ą net su ta pačia versija", async () => {
  const root = await world();
  try {
    const deps = {
      fs: nodeFsAdapter,
      codeFs: createCodeIntelligenceFsAdapter(root),
      cache: createContextCacheAdapter(root, path.join(root, "vq")),
    };
    await assembleContextPack(["AG/tasks/queue/0042-demo.md"], root, deps);
    await assembleContextPack(["AG/tasks/queue/0042-demo.md"], root, deps);
    assert.equal(await lastCacheStatus(root), "hit", "kontrolė: nepakitęs indeksas duoda hit'ą");

    // Simuliuojame indeksuotoją, kuris tiems patiems failams pagamino KITOKIUS įrašus, bet versijos
    // nepakėlė: keičiamas tik `records_hash` (t. y. tai, ką indeksas turi), o `version` ir
    // `source_hash` lieka. Su vien versija deskriptoriuje toks pack'as grįžtų kaip pilnavertis.
    const runtimeRoot = path.join(root, "vq");
    const [stored] = await readContextCacheEntries(runtimeRoot);
    assert.ok(stored);
    const parts = stored.entry.code_index.split(":");
    assert.equal(parts.length, 4, `laukta fresh:<versija>:<source>:<records>, gauta ${stored.entry.code_index}`);
    const otherContent = [...parts.slice(0, 3), "0".repeat(64)].join(":");
    await nodeFsAdapter.writeTextFile(
      stored.file,
      `${JSON.stringify({ ...stored.entry, code_index: otherContent }, null, 2)}\n`,
    );

    await assembleContextPack(["AG/tasks/queue/0042-demo.md"], root, deps);
    assert.equal(
      await lastCacheStatus(root),
      "miss",
      "pack'as, sudėtas iš kitokio indekso TURINIO, negali grįžti kaip pilnavertis hit'as",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Kita medalio pusė, ir ji tokia pat svarbi: deskriptorius neturi teisės daryti kešo nenaudingo.
// Build'as deterministinis, tad priverstinis perstatymas su nepakitusiais failais duoda TUOS PAČIUS
// įrašus — ir hit'as tokiu atveju yra teisingas atsakymas, ne spraga.
test("priverstinis perstatymas su nepakitusiais failais TOLIAU duoda hit'ą", async () => {
  const root = await world();
  try {
    const deps = {
      fs: nodeFsAdapter,
      codeFs: createCodeIntelligenceFsAdapter(root),
      cache: createContextCacheAdapter(root, path.join(root, "vq")),
    };
    await assembleContextPack(["AG/tasks/queue/0042-demo.md"], root, deps);

    await buildCodeIndex(createCodeIntelligenceFsAdapter(root), root);

    await assembleContextPack(["AG/tasks/queue/0042-demo.md"], root, deps);
    assert.equal(
      await lastCacheStatus(root),
      "hit",
      "deterministinis perstatymas duoda tą patį `records_hash` — kešas privalo likti naudingas",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SENESNIO build'o pack'as negrįžta kaip hit'as, nors failai ir indeksas nepakitę", async () => {
  const root = await world();
  try {
    const deps = {
      fs: nodeFsAdapter,
      codeFs: createCodeIntelligenceFsAdapter(root),
      cache: createContextCacheAdapter(root, path.join(root, "vq")),
    };
    await assembleContextPack(["AG/tasks/queue/0042-demo.md"], root, deps);

    // Kontrolė: nieko nepakeitus tas pats surinkimas yra HIT — kitaip tikrinimas žemiau nieko neįrodo.
    await assembleContextPack(["AG/tasks/queue/0042-demo.md"], root, deps);
    assert.equal(await lastCacheStatus(root), "hit", "nepakitęs repo privalo duoti hit'ą");

    // Scenarijus, kurio VIENINTELĖ apsauga yra versija deskriptoriuje: įrašas parašytas SENESNIO
    // build'o, kuris deskriptoriuje nešė tik `fresh:<source_hash>`. Failai tie patys, indeksas tas
    // pats, `CONTEXT_CACHE_VERSION` tas pats, šaltinių hash'ai tie patys — skiriasi TIK tai, iš
    // kokios indekso semantikos pack'as sudėtas.
    //
    // Manifesto versijos čia NEKEIČIAME sąmoningai: tai duotų miss'ą per šviežumo vartą, ir testas
    // matuotų ne tai, ką deklaruoja. (Pirmoji šio testo versija būtent tą klaidą ir turėjo —
    // mutacijos patikra parodė, kad ji praeina net grąžinus seną deskriptoriaus formatą.)
    const runtimeRoot = path.join(root, "vq");
    const [stored] = await readContextCacheEntries(runtimeRoot);
    assert.ok(stored, "įrašas privalo būti išsaugotas");
    const legacyDescriptor = `fresh:${stored.entry.code_index.split(":").at(-1) ?? ""}`;
    assert.notEqual(legacyDescriptor, stored.entry.code_index, "kontrolė: senas formatas tikrai kitoks");
    await nodeFsAdapter.writeTextFile(
      stored.file,
      `${JSON.stringify({ ...stored.entry, code_index: legacyDescriptor }, null, 2)}\n`,
    );

    await assembleContextPack(["AG/tasks/queue/0042-demo.md"], root, deps);
    assert.equal(
      await lastCacheStatus(root),
      "miss",
      "pack'as, sudėtas iš kitos indekso semantikos, negali grįžti kaip pilnavertis hit'as",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
