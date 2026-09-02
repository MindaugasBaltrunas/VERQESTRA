// 2026-08-23 (operatoriaus radinys): code-index semantika nepateko į konteksto kešo tapatybę.
//
// `codeIndexVersion` pakelta (2.1.0 → 3.x, kai indeksas ėmė duoti importus, simbolius ir briaunas
// Python/PHP/C#/.NET kalboms), bet `code_index` deskriptorius saugojo TIK `fresh:<source_hash>`.
// Šaltinių hash'as nuo indeksuotojo semantikos nepriklauso — tie patys failai duoda tą patį hash'ą,
// — tad pack'as, sudėtas iš SKURDESNIO indekso, grįždavo kaip pilnavertis hit'as.
//
// Taisyta dviem lygiais, ir šis failas prikala būtent STRUKTŪRINĮ: versija įeina į deskriptorių,
// tad būsimi indekso kėlimai anuliuoja pack'us automatiškai, nebereikalaudami prisiminti kelti ir
// `CONTEXT_CACHE_VERSION`.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { codeIndexVersion } from "../application/code-intelligence/indexing/types.js";
import { CONTEXT_CACHE_VERSION } from "../application/context-pack/context-cache-model.js";
import { buildCodeIndex } from "../application/code-intelligence/indexing/builder.js";
import { codeIndexPath } from "../application/code-intelligence/store/code-index-store.js";
import { nodeFsTestPort } from "./helpers/node-fs-port.js";

test("code-index manifestas neša versiją, iš kurios statoma pack'o tapatybė", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vq-cache-identity-"));
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "main.py"), "def run():\n    return 1\n", "utf8");

    const index = await buildCodeIndex(nodeFsTestPort, root);
    const manifest = JSON.parse(await nodeFsTestPort.readTextFile(codeIndexPath(root, "manifest.json"))) as {
      version?: string;
      source_hash?: string;
    };

    // Be šių dviejų laukų deskriptoriaus sudėti neįmanoma — jis skaitomas būtent iš manifesto,
    // o ne iš proceso konstantos, nes turi aprašyti indeksą, iš kurio pack'as SUDĖTAS.
    assert.equal(manifest.version, codeIndexVersion, "manifestas neša indekso versiją");
    assert.equal(typeof manifest.source_hash, "string");
    assert.equal(manifest.source_hash, index.manifest.source_hash);

    // Esmė: šaltinių hash'as apibūdina DUOMENIS. Perstačius indeksą tų pačių failų hash'as
    // nesikeičia, tad be versijos deskriptoriuje senas pack'as būtų neatskiriamas nuo naujo.
    const rebuilt = await buildCodeIndex(nodeFsTestPort, root);
    assert.equal(rebuilt.manifest.source_hash, index.manifest.source_hash, "tie patys failai — tas pats hash'as");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Priminimo testas, kaip ir `CONTEXT_CACHE_VERSION` atveju: jei kas nors pakels indekso versiją,
// šis krisdamas parodys, KUR dar tą kėlimą reikia atspindėti. Skirtumas nuo ankstesnės būklės —
// deskriptorius jau tvarko invalidaciją pats, tad čia liko tik sąmoningumo vartas.
test("indekso ir kešo versijos: kėlimas turi būti sąmoningas", () => {
  assert.equal(codeIndexVersion, "4.6.0", "ciklo inicializatoriaus vardas dalyvauja scope — references ir imports");
  assert.equal(CONTEXT_CACHE_VERSION, 11, "pakelta kartu su task 138 parseAgentBlock proza-vs-role fix'u");
});
