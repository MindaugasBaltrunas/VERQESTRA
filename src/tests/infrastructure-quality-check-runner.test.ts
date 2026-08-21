// VQ-504 (15/N) testai — vieno quality-policy patikrinimo vykdymas ant REALIŲ procesų.
// Pin'inama tai, kas skiria dvi formas: `spawn` kelias jokio shell'o nepaleidžia (metasimboliai
// lieka argumento tekstu), o `shell` kelias juos interpretuoja. Sulieti formas reikštų grąžinti
// injekcijos paviršių, kurį atskira spawn forma ir panaikina.

import assert from "node:assert/strict";
import { test } from "node:test";
import { runQualityCheck } from "../infrastructure/process/quality-check-runner.js";

test("spawn forma: argumentai keliauja BE shell'o, o exit kodas grąžinamas kaip yra", async () => {
  const ok = await runQualityCheck(
    { kind: "spawn", display: "node exit 0", cmd: process.execPath, args: ["-e", "process.exit(0)"] },
    process.cwd(),
  );
  assert.equal(ok.code, 0);

  const failed = await runQualityCheck(
    { kind: "spawn", display: "node exit 7", cmd: process.execPath, args: ["-e", "process.exit(7)"] },
    process.cwd(),
  );
  // Kodas perduodamas TIKSLIAI: vartai skiria „patikra nepraėjo" nuo „patikros paleisti nepavyko".
  assert.equal(failed.code, 7);
});

test("spawn forma: metasimbolis lieka ARGUMENTU, o ne komanda", async () => {
  // Jei kelias eitų per shell'ą, `;` atskirtų antrą komandą ir stdout turėtų `pwned`.
  const result = await runQualityCheck(
    {
      kind: "spawn",
      display: "node echo",
      cmd: process.execPath,
      args: ["-e", "process.stdout.write(process.argv[1] ?? '')", "; echo pwned"],
    },
    process.cwd(),
  );
  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim(), "; echo pwned");
});

test("spawn forma: stdout ir stderr atskiriami", async () => {
  const result = await runQualityCheck(
    {
      kind: "spawn",
      display: "node streams",
      cmd: process.execPath,
      args: ["-e", "process.stdout.write('out'); process.stderr.write('err')"],
    },
    process.cwd(),
  );
  assert.equal(result.stdout.trim(), "out");
  assert.equal(result.stderr.trim(), "err");
});
