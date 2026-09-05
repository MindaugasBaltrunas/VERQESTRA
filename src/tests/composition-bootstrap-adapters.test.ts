// Task 172 testai — bootstrap/atkūrimo adapterių du sprendimai.
//
// `AG_ROLLBACK_CLEAN`: pilnas auditas 2026-09-05 (Dk2) rado, kad šablonas
// `templates/vq/config/commands.env` šį raktą vežė su instrukcija „set to 1", o kodas skaitė TIK
// `process.env` — operatoriaus įrašas faile nedarė nieko. Testas fiksuoja abu šaltinius ir jų
// pirmenybę, nes tyli spraga čia reiškia neįvykusį `git clean` po rollback'o.
//
// `commandExists`: lokali kopija zondavo per `sh -c "command -v ${command}"`. Interpoliuotas
// vardas su `;` shell'e virsdavo antra komanda; bendroji realizacija paduoda jį argumentu.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { rollbackCleanUntracked, rollbackStablePorts, smokePorts } from "../composition/runtime/bootstrap-adapters.js";

let root = "";

/** Runtime šaknis su (nebūtinu) `config/commands.env` turiniu. */
async function runtimeWithCommandsEnv(name: string, text?: string): Promise<string> {
  const runtimeRoot = path.join(root, name);
  await mkdir(path.join(runtimeRoot, "config"), { recursive: true });
  if (text !== undefined) await writeFile(path.join(runtimeRoot, "config", "commands.env"), text, "utf8");
  return runtimeRoot;
}

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "vq-bootstrap-adapters-"));
});

after(async () => {
  if (root !== "") await rm(root, { recursive: true, force: true });
});

test("rollbackCleanUntracked: aplinka nugali failą, tuščia aplinka atiduoda sprendimą failui", () => {
  assert.equal(rollbackCleanUntracked({}, "AG_ROLLBACK_CLEAN=1\n"), true, "failo `1` įjungia");
  assert.equal(rollbackCleanUntracked({}, "AG_ROLLBACK_CLEAN=true\n"), true, "`true` lygu `1`");
  assert.equal(rollbackCleanUntracked({}, "AG_ROLLBACK_CLEAN=0\n"), false, "failo `0` neįjungia");
  assert.equal(rollbackCleanUntracked({}, ""), false, "tuščias konfigas — numatytai NEšalinama");
  assert.equal(rollbackCleanUntracked({}), false, "be jokio šaltinio — NEšalinama");

  const env = { AG_ROLLBACK_CLEAN: "0" };
  assert.equal(rollbackCleanUntracked(env, "AG_ROLLBACK_CLEAN=1\n"), false, "env `0` nugali failo `1`");
  assert.equal(rollbackCleanUntracked({ AG_ROLLBACK_CLEAN: "1" }, "AG_ROLLBACK_CLEAN=0\n"), true, "ir atvirkščiai");
  // Tuščia reikšmė (`AG_ROLLBACK_CLEAN=` shell'e) laikoma NENUSTATYTA: kitaip ji tyliai
  // anuliuotų operatoriaus konfigą, o būtent to Dk2 spraga ir kainavo.
  assert.equal(rollbackCleanUntracked({ AG_ROLLBACK_CLEAN: "  " }, "AG_ROLLBACK_CLEAN=1\n"), true);
  assert.equal(rollbackCleanUntracked({}, "# AG_ROLLBACK_CLEAN=1\n"), false, "užkomentuota eilutė neįjungia");
});

test("rollbackStablePorts: `cleanUntracked` paimamas iš `vq/config/commands.env`", async () => {
  const runtimeRoot = await runtimeWithCommandsEnv("vq-file-on", "AG_UI_PORT=4200\nAG_ROLLBACK_CLEAN=1\n");
  assert.equal(rollbackStablePorts(runtimeRoot, {}).cleanUntracked, true);
});

test("rollbackStablePorts: env `0` nugali failo `1`, o nesamas failas nekrenta", async () => {
  const runtimeRoot = await runtimeWithCommandsEnv("vq-file-conflict", "AG_ROLLBACK_CLEAN=1\n");
  assert.equal(rollbackStablePorts(runtimeRoot, { AG_ROLLBACK_CLEAN: "0" }).cleanUntracked, false);

  const withoutFile = await runtimeWithCommandsEnv("vq-no-file");
  assert.equal(rollbackStablePorts(withoutFile, {}).cleanUntracked, false, "nesamas konfigas — `false`, ne klaida");
});

test("smokePorts.commandExists: vardas su shell metaženklais NEĮVYKDO nieko", async () => {
  const ports = smokePorts(path.join(root, "AG"), path.join(root, "vq"));
  // Su senuoju `sh -c \`command -v ${command}\`` interpoliavimu `;` po vardo paleisdavo antrą
  // komandą, kurios exit kodas 0 reikšdavo „įrankis yra". Bendra realizacija vardą paduoda
  // argumentu, tad vienintelis atsakymas čia yra „ne".
  assert.equal(await ports.commandExists("vq-nera-tokios-komandos; exit 0"), false);
  assert.equal(await ports.commandExists("vq-nera-tokios-komandos"), false, "nesamas įrankis — `false`");
});
