// Bundle senumo porto (`UiRouterPorts.bundle`) surišimas su tikru fs (058-a-02).
//
// Grynas skaičiavimas (`bundleStalenessFields`) jau padengtas `interfaces/http` teste su pin'intais
// mtime skaičiais — čia tikrinamas TIK adapteris: ar jis realiai skaito `ui-app/dist/index.html` ir
// naujausią `ui-app/src` failo mtime REKURSYVIAI, ir ar trūkstamas kelias grąžina `null`, o ne meta
// klaidą (žr. `router-adapters.ts` komentarą prie `bundlePorts`).

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { uiRouterPorts } from "../composition/ui/router-adapters.js";

type Sandbox = { projectRoot: string; runtimeRoot: string; agRoot: string };

async function makeSandbox(): Promise<Sandbox> {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "vq-ui-bundle-"));
  const runtimeRoot = path.join(projectRoot, "vq");
  const agRoot = path.join(projectRoot, "AG");
  await mkdir(runtimeRoot, { recursive: true });
  await mkdir(agRoot, { recursive: true });
  return { projectRoot, runtimeRoot, agRoot };
}

function readBundleFacts(sandbox: Sandbox) {
  const ports = uiRouterPorts({ ...sandbox, logError: () => {} });
  if (!ports.bundle) throw new Error("bundle portas nesurištas");
  return ports.bundle.readFacts();
}

async function touch(absolutePath: string, at: Date): Promise<void> {
  await writeFile(absolutePath, "// stub", "utf8");
  await utimes(absolutePath, at, at);
}

test("bundle šviežias: dist/index.html naujesnis už naujausią src failą (nested)", async () => {
  const sandbox = await makeSandbox();
  try {
    const srcDir = path.join(sandbox.projectRoot, "ui-app", "src");
    const nestedDir = path.join(srcDir, "view", "components");
    await mkdir(nestedDir, { recursive: true });
    await mkdir(path.join(sandbox.projectRoot, "ui-app", "dist"), { recursive: true });

    const oldSrcTime = new Date("2026-01-01T00:00:00Z");
    const newestSrcTime = new Date("2026-01-03T00:00:00Z");
    const distTime = new Date("2026-01-05T00:00:00Z");
    await touch(path.join(srcDir, "App.tsx"), oldSrcTime);
    // Naujausias failas yra REKURSYVIAI, ne šaknyje — adapteris privalo eiti giliau.
    await touch(path.join(nestedDir, "Badge.tsx"), newestSrcTime);
    await touch(path.join(sandbox.projectRoot, "ui-app", "dist", "index.html"), distTime);

    const facts = await readBundleFacts(sandbox);
    assert.ok(facts, "bundle sukurtas — faktai neturi būti null");
    assert.equal(facts.bundleMtimeMs, distTime.getTime());
    assert.equal(facts.srcMtimeMs, newestSrcTime.getTime());
  } finally {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  }
});

test("bundle pasenęs: naujausias src failas naujesnis už dist/index.html", async () => {
  const sandbox = await makeSandbox();
  try {
    const srcDir = path.join(sandbox.projectRoot, "ui-app", "src");
    await mkdir(srcDir, { recursive: true });
    await mkdir(path.join(sandbox.projectRoot, "ui-app", "dist"), { recursive: true });

    const distTime = new Date("2026-01-01T00:00:00Z");
    const srcTime = new Date("2026-01-05T00:00:00Z");
    await touch(path.join(sandbox.projectRoot, "ui-app", "dist", "index.html"), distTime);
    await touch(path.join(srcDir, "App.tsx"), srcTime);

    const facts = await readBundleFacts(sandbox);
    assert.ok(facts);
    assert.equal(facts.bundleMtimeMs, distTime.getTime());
    assert.equal(facts.srcMtimeMs, srcTime.getTime());
    assert.ok(facts.srcMtimeMs > facts.bundleMtimeMs, "src turi būti naujesnis, kad bundle būtų pasenęs");
  } finally {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  }
});

test("bundle nesukurtas: trūkstamas ui-app/dist/index.html grąžina null, ne meta klaidą", async () => {
  const sandbox = await makeSandbox();
  try {
    // `ui-app` katalogo apskritai nėra — nei dist, nei src.
    const facts = await readBundleFacts(sandbox);
    assert.equal(facts, null);
  } finally {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  }
});
