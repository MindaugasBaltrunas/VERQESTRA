// VQ-404 (2/2) testai — Claude provider adapteris: modelio env krautuvas ir tier mapping'as
// (claude-model-env), matomas PowerShell dispatch paleidiklis su nonce watchdog'u
// (claude-launcher) ir adapterių galimybių deklaracijos (adapter-capabilities).

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { nodeFsAdapter } from "../infrastructure/fs/node-fs-adapter.js";
import {
  ESCALATION_TIER_CEILING,
  assertSafeModelId,
  classifyTaskComplexity,
  escalateModelTier,
  loadModelsEnv,
  modelTierOfRoutingTier,
  modelTiers,
  normalizeModelTier,
  parseEnv,
  resolveModelTier,
  resolveRoutedModel,
  routingTierOfModelTier,
  selectClaudeModel,
} from "../infrastructure/adapters/claude-model-env.js";
import {
  VISIBLE_LAUNCHER_TIMEOUT_GRACE_MS,
  createVisibleClaudeLauncher,
  resolveVisibleLauncherTimeoutMs,
  type VisibleClaudeLauncherOptions,
} from "../infrastructure/adapters/claude-launcher.js";
import {
  adapterCapabilities,
  getAdapterCapabilityDeclaration,
  listAdapterCapabilityDeclarations,
} from "../infrastructure/adapters/adapter-capabilities.js";
import { DISPATCH_TIMEOUT_EXIT_CODE, EXECUTOR_UNAVAILABLE_EXIT_CODE } from "../shared/exit-codes.js";

const projectRoot = await mkdtemp(path.join(tmpdir(), "vq-launcher-"));
const runtimeRoot = path.join(projectRoot, "vq");
after(async () => {
  await rm(projectRoot, { recursive: true, force: true });
});

test("loadModelsEnv: be failo — einamosios kartos default'ai; su failu — override'ai ir kabučių/komentarų parse", async () => {
  const defaults = await loadModelsEnv(runtimeRoot);
  assert.equal(defaults.claudeHaikuModel, "claude-haiku-4-5");
  assert.equal(defaults.claudeSonnetModel, "claude-sonnet-5");
  assert.equal(defaults.claudeOpusModel, "claude-opus-5");
  assert.equal(defaults.claudeFableModel, "claude-fable-5");

  await nodeFsAdapter.writeTextFile(
    path.join(runtimeRoot, "config", "models.env"),
    [
      "# komentaras",
      'CLAUDE_SONNET_MODEL="sonnet-custom"',
      "export CLAUDE_OPUS_MODEL='opus-custom'",
      "CLAUDE_HAIKU_MODEL=haiku-custom # uodegos komentaras",
      "",
    ].join("\n"),
  );
  const loaded = await loadModelsEnv(runtimeRoot);
  assert.equal(loaded.claudeSonnetModel, "sonnet-custom");
  assert.equal(loaded.claudeOpusModel, "opus-custom");
  assert.equal(loaded.claudeHaikuModel, "haiku-custom");
  assert.equal(loaded.claudeFableModel, "claude-fable-5");

  // parseEnv: escape dvigubose kabutėse, ne-atpažįstamos eilutės praleidžiamos.
  const values = parseEnv('A="x\\"y"\nnesuprantama eilute\nB=plain');
  assert.equal(values["A"], 'x"y');
  assert.equal(values["B"], "plain");
});

test("tier mapping'as: round-trip, eskalacijos lubos opus, explicit fable išlaikomas, ID validacija", () => {
  for (const tier of modelTiers) {
    assert.equal(modelTierOfRoutingTier(routingTierOfModelTier(tier)), tier);
  }
  assert.equal(ESCALATION_TIER_CEILING, "opus");

  assert.equal(normalizeModelTier("claude-opus-5"), "opus");
  assert.equal(normalizeModelTier("fable"), "fable");
  assert.equal(normalizeModelTier("visiskai-nezinomas"), "haiku");

  // Eskalacija: kiekviena nesėkmė +1 pakopa, lubos — opus; fable per eskalaciją nepasiekiamas.
  assert.equal(escalateModelTier("haiku", 0), "haiku");
  assert.equal(escalateModelTier("haiku", 1), "sonnet");
  assert.equal(escalateModelTier("sonnet", 5), "opus");
  assert.equal(escalateModelTier("opus", 3), "opus");
  // Explicit fable bazė išlaikoma, bet nekeliama (jau virš lubų).
  assert.equal(escalateModelTier("claude-fable-5", 2), "fable");

  const env = {
    claudeHaikuModel: "h-1",
    claudeSonnetModel: "s-1",
    claudeOpusModel: "o-1",
    claudeFableModel: "f-1",
  };
  assert.equal(resolveModelTier("sonnet", env), "s-1");
  assert.equal(resolveRoutedModel("critical", env), "f-1");
  assert.equal(selectClaudeModel("claude-haiku-4-5", env), "h-1");
  assert.throws(() => assertSafeModelId("x'; calc; '"), /Nesaugus modelio ID/);
  assert.throws(() => resolveModelTier("opus", { ...env, claudeOpusModel: "a b" }), /Nesaugus modelio ID/);

  // Rizikos klasifikacija deleguojama maršrutizatoriui — rezultatas visada yra žinoma pakopa.
  assert.ok((modelTiers as readonly string[]).includes(classifyTaskComplexity("paprastas import fix")));
});

const BASE_OPTIONS: VisibleClaudeLauncherOptions = {
  projectRoot: "D:\\repo",
  promptPath: "D:\\repo\\vq\\state\\claude-prompt.md",
  model: "claude-sonnet-5",
  exitFile: "D:\\repo\\vq\\state\\claude-exit-code.txt",
  logFile: "D:\\repo\\vq\\logs\\attempt.log",
  dispatchTimeoutMs: 600_000,
  dispatchNonce: "abc12345",
};

test("createVisibleClaudeLauncher: komanda, nonce env + watchdog regex, stop-bridge kelias išvedamas iš exitFile", () => {
  const script = createVisibleClaudeLauncher(BASE_OPTIONS);

  assert.ok(
    script.includes(
      "& claude -p --verbose --output-format stream-json --include-partial-messages --include-hook-events --permission-mode auto --model 'claude-sonnet-5'",
    ),
  );
  // Be maxTurns/disallowedTools komanda baigiasi be papildomų flag'ų.
  assert.ok(!script.includes("--max-turns"));
  assert.ok(!script.includes("--disallowed-tools"));

  assert.ok(script.includes("`$env:AG_DISPATCH_NONCE = 'abc12345'"));
  assert.ok(script.includes(String.raw`'"dispatch_nonce"\s*:\s*"abc12345"'`));
  assert.ok(script.includes(String.raw`'"status"\s*:\s*"done"'`));

  // Stop-bridge failas — tame pačiame kataloge kaip exitFile, kanoniniu vardu.
  assert.ok(script.includes("'D:\\repo\\vq\\state\\claude-stop-status.json'"));

  // Vidinis biudžetas griežtai mažesnis už dispatch timeout (grace atėmimas).
  assert.ok(script.includes(`$timeoutMs = ${600_000 - VISIBLE_LAUNCHER_TIMEOUT_GRACE_MS}`));

  // Deterministiniai exit kodai: trūkstamas CLI ir watchdog timeout.
  assert.ok(script.includes(`exit ${EXECUTOR_UNAVAILABLE_EXIT_CODE}`));
  assert.ok(script.includes(`exit ${DISPATCH_TIMEOUT_EXIT_CODE}`));
  // Pilnas medžio kill, ne plikas Kill().
  assert.ok(script.includes("taskkill.exe /T /F /PID"));
});

test("createVisibleClaudeLauncher: maxTurns/disallowedTools interpoliacija tik per validuotus builder'ius", () => {
  const script = createVisibleClaudeLauncher({
    ...BASE_OPTIONS,
    maxTurns: 60,
    disallowedTools: ["WebSearch", "WebFetch"],
    mirrorLogFile: "D:\\repo\\vq\\logs\\claude-last.log",
  });
  assert.ok(script.includes("--max-turns 60"));
  assert.ok(script.includes("--disallowed-tools 'WebSearch,WebFetch'"));
  // Veidrodis: truncate + antras Tee-Object, abu best-effort.
  assert.ok(script.includes("Set-Content -LiteralPath 'D:\\repo\\vq\\logs\\claude-last.log' -Value '' -ErrorAction SilentlyContinue"));
  assert.ok(script.includes("Tee-Object -FilePath 'D:\\repo\\vq\\logs\\claude-last.log' -Append -ErrorAction SilentlyContinue"));

  // maxTurns <= 0 — jokio flag'o (claudeMaxTurnsArgs praleidžia tik teigiamą sveiką skaičių).
  const noTurns = createVisibleClaudeLauncher({ ...BASE_OPTIONS, maxTurns: 0 });
  assert.ok(!noTurns.includes("--max-turns"));
});

test("createVisibleClaudeLauncher: injekcijos paviršiai atmetami prieš rašant skriptą", () => {
  assert.throws(() => createVisibleClaudeLauncher({ ...BASE_OPTIONS, dispatchNonce: "ABC12345" }), /dispatch nonce/);
  assert.throws(() => createVisibleClaudeLauncher({ ...BASE_OPTIONS, dispatchNonce: "trumpas" }), /dispatch nonce/);
  assert.throws(() => createVisibleClaudeLauncher({ ...BASE_OPTIONS, model: 'x"y' }), /Nesaugi reikšmė 'model'/);
  assert.throws(() => createVisibleClaudeLauncher({ ...BASE_OPTIONS, projectRoot: "D:\\repo$x" }), /projectRoot/);
  assert.throws(() => createVisibleClaudeLauncher({ ...BASE_OPTIONS, logFile: "D:\\a\nb" }), /logFile/);
  assert.throws(
    () => createVisibleClaudeLauncher({ ...BASE_OPTIONS, disallowedTools: ["Web Search"] }),
    /disallowed-tool/,
  );
  assert.throws(
    () => createVisibleClaudeLauncher({ ...BASE_OPTIONS, disallowedTools: ["A,B"] }),
    /disallowed-tool/,
  );
  // Apostrofas keliuose LEIDŽIAMAS (psSingleQuote jį padvigubina).
  const script = createVisibleClaudeLauncher({ ...BASE_OPTIONS, projectRoot: "D:\\O'Brien\\repo" });
  assert.ok(script.includes("'D:\\O''Brien\\repo'"));
});

test("resolveVisibleLauncherTimeoutMs: grace atėmimas, apatinė riba, invalid metimas", () => {
  assert.equal(resolveVisibleLauncherTimeoutMs(600_000), 590_000);
  assert.equal(resolveVisibleLauncherTimeoutMs(5_000), 1_000);
  assert.throws(() => resolveVisibleLauncherTimeoutMs(0), /Invalid dispatch timeout/);
  assert.throws(() => resolveVisibleLauncherTimeoutMs(Number.NaN), /Invalid dispatch timeout/);
});

test("adapter-capabilities: visi adapteriai deklaruoja kiekvieną feature lygiai vieną kartą", () => {
  const declarations = listAdapterCapabilityDeclarations();
  assert.deepEqual(
    declarations.map((declaration) => declaration.adapter),
    ["claude", "codex", "dry-run"],
  );
  for (const declaration of declarations) {
    const features = [...declaration.implemented, ...declaration.future].map((capability) => capability.feature).sort();
    assert.deepEqual(features, [
      "context-pack-input",
      "deterministic-noop",
      "external-agent-execution",
      "policy-model-selection",
      "structured-output",
    ]);
  }
  assert.equal(getAdapterCapabilityDeclaration("claude"), adapterCapabilities.claude);
  assert.ok(
    adapterCapabilities.claude.implemented.some((capability) => capability.feature === "policy-model-selection"),
  );
});
