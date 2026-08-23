// VQ-504 (26/N) testai — KOMPOZICIJOS code-intelligence FS įėjimas.
//
// Kodėl šis testas egzistuoja: 16/N kompozicijoje buvo atsiradusi sava, „paprastesnė"
// `codeIntelligenceFs` kopija be symlink'ų varto, ir niekas to nepagavo — infrastruktūros
// symlink testai šioje mašinoje PRALEIDŽIAMI (Windows `symlink` reikalauja Developer Mode arba
// admin teisių; empiriškai: `file` ir `dir` krenta su EPERM). Todėl vartas čia tikrinamas per
// JUNCTION — tai tikras reparse point, kurį `realpath` išskleidžia lygiai taip pat, bet kurį
// Windows leidžia kurti be papildomų teisių.
//
// Tikrinamas ne pats adapteris (jį dengia infrastructure testai), o KOMPOZICIJOS surišimas:
// kad `codeIntelligenceFs(projectRoot)` grąžina šaknies apimties adapterį, o ne bet kokį
// objektą, tenkinantį porto tipą.

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { codeIntelligenceFs } from "../composition/runtime/node-adapters.js";

/**
 * Katalogo nuoroda, kurią pavyksta sukurti be papildomų teisių.
 *
 * win32: `junction` (nereikalauja Developer Mode); kitur: paprastas `dir` symlink'as.
 * Grąžina `false`, kai nepavyko nė vienas būdas — tada testas praleidžiamas SĄMONINGAI, o ne
 * apsimeta žaliu.
 */
async function linkDirectory(target: string, linkPath: string): Promise<boolean> {
  for (const kind of process.platform === "win32" ? (["junction", "dir"] as const) : (["dir"] as const)) {
    try {
      await symlink(target, linkPath, kind);
      return true;
    } catch {
      // bandome kitą būdą
    }
  }
  return false;
}

test("codeIntelligenceFs: nuoroda UŽ projekto šaknies neperskaitoma (realpath vartas)", async (t) => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "vq-code-fs-"));
  try {
    const projectRoot = path.join(sandbox, "projektas");
    const outside = path.join(sandbox, "svetima");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "slaptas.md"), "SVETIMAS TURINYS", "utf8");

    const linkPath = path.join(projectRoot, "isorinis");
    if (!(await linkDirectory(outside, linkPath))) {
      t.skip("katalogo nuorodos kurti neleidžia nei junction, nei symlink");
      return;
    }

    const fs = codeIntelligenceFs(projectRoot);
    const through = path.join(linkPath, "slaptas.md");

    // Turinys eina TIESIAI į LLM promptą ir į context cache — nuoroda už šaknies negali jo
    // ištraukti. Be varto šis skaitymas pavyktų ir grąžintų „SVETIMAS TURINYS".
    await assert.rejects(() => fs.readTextFile(through), /escapes project root/);

    // Egzistavimas irgi neatskleidžiamas: `absent`, ne `file`. Kitaip vartas paverstų skaitymo
    // draudimą į informacijos nutekėjimo kanalą („tokio failo ten YRA").
    assert.equal(await fs.statKind(through), "absent");
    assert.equal(await fs.exists(through), false);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("codeIntelligenceFs: kelias PROJEKTO viduje skaitomas normaliai", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "vq-code-fs-"));
  try {
    const projectRoot = path.join(sandbox, "projektas");
    await mkdir(path.join(projectRoot, "src"), { recursive: true });
    await writeFile(path.join(projectRoot, "src", "a.ts"), "export const a = 1;\n", "utf8");

    const fs = codeIntelligenceFs(projectRoot);
    const inside = path.join(projectRoot, "src", "a.ts");

    // Vartas privalo praleisti teisėtą kelią: per griežtas vartas sulaužytų indeksavimą, ir
    // tai būtų tokia pat regresija kaip jo nebuvimas.
    assert.equal(await fs.readTextFile(inside), "export const a = 1;\n");
    assert.equal(await fs.statKind(inside), "file");
    assert.equal(await fs.exists(inside), true);
    assert.ok((await fs.fileSize(inside)) > 0);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});
