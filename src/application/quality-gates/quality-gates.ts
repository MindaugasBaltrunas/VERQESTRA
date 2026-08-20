// quality-gates use case (etalono application/quality-gates/quality-gates.ts, WBR VQ-305):
// išsprendžia sukonfigūruotas lint/typecheck/test/build komandas scope'ui, praleidžia jas per
// shell/spawn komandų politiką ir persistuoja tiek mašininį statusą
// (`vq/state/quality-gates-status.json`), tiek žmogaus log'ą (`checks-last.log`) — abu per
// portą. CLI argumentų apdorojimas, procesų spawn'as ir realus FS — E4/E5 adapterių darbas:
// etalono default'ai (`runQualityCheck` spawn'as, FS rašytojai, `fsGatesMemoPort`) čia
// SĄMONINGAI nedubliuojami, use case gauna juos per `QualityGatesPorts`.
import {
  isQualityScope,
  resolveQualityChecks,
  type QualityPolicy,
  type QualityScope,
  type ResolvedQualityCheck,
} from "../policy-governance/quality-policy.js";
import {
  evaluateShellQualityCommand,
  evaluateSpawnQualityCommand,
} from "../../domain/policies/quality-command-policy.js";
import type { CheckCommandContext } from "../../domain/policies/check-command-allowlist.js";
import type { QualityGateResult, QualityGatesStatus } from "./quality-gates-status.js";
import { gatesMemoRecordFor, memoCovers, type GatesMemoIdentity, type GatesMemoPort } from "./gates-memo.js";

export type CheckCommandResultLike = {
  code: number;
  stdout: string;
  stderr: string;
};

export type QualityGateRunner = (
  check: ResolvedQualityCheck,
  cwd: string,
  timeoutMs?: number,
  env?: Record<string, string | undefined>,
) => Promise<CheckCommandResultLike>;

/**
 * Vartų vykdymo efektai. `runner` privalo išlaikyti etalono `runQualityCheck` semantiką:
 * shell forma per shell, spawn forma per spawn su platformos package-manager vardo
 * normalizacija (npm → npm.cmd win32); jo nebuvimo default'o čia nėra — spawn'as yra E4.
 */
export type QualityGatesPorts = {
  loadPolicy(): Promise<QualityPolicy>;
  /** Komandų politikos kontekstas (configured checks + aktyvūs stack'ai); fail-safe pusę duoda adapteris. */
  commandContext(policy: QualityPolicy): Promise<CheckCommandContext>;
  runner: QualityGateRunner;
  writeStatus(status: QualityGatesStatus): Promise<void>;
  /** Pilnas checks-last.log turinys vienu įrašu. */
  writeChecksLog(text: string): Promise<void>;
  /** `vq/config/local.env` papildomi kintamieji vartų komandoms; klaida = tuščias rinkinys. */
  loadLocalEnv(): Promise<Record<string, string>>;
  memoPort?: GatesMemoPort;
};

export type RunQualityGatesOptions = {
  projectRoot?: string;
  now?: Date;
  /**
   * Vartų memoizacija (žr. gates-memo.ts). Numatytai įjungta; `memo: false` išjungia
   * visiškai (etalone tą darė injektuotas runner'is — fake rezultatai niekada nepatenka į
   * cache); `--no-memo` argumentas išjungia tik PASITIKĖJIMĄ esamu įrašu (suite paleidžiamas
   * pilnas), o šviežias žalias rezultatas memo vis tiek atnaujina — priverstinis pilnas
   * paleidimas neturi palikti pasenusio antspaudo.
   */
  memo?: boolean;
};

export function parseQualityScope(args: string[]): QualityScope {
  const scopeFlag = args.find((arg) => arg.startsWith("--scope="));
  const scopeIndex = args.indexOf("--scope");
  const scopeValue = scopeFlag?.slice("--scope=".length) ?? (scopeIndex >= 0 ? args[scopeIndex + 1] : undefined);
  const scope = scopeValue ?? "task";
  if (!isQualityScope(scope)) {
    throw new Error("Usage: ag quality-gates --scope task|feature|milestone");
  }
  return scope;
}

/** Žmogui skirto checks log'o turinys — grynas rendinimas, kad testai jį pin'intų be FS. */
export function renderChecksLog(status: QualityGatesStatus, notes: readonly string[] = []): string {
  const lines: string[] = [`=== quality-gates scope:${status.scope} ===`, ...notes];

  if (!status.has_commands) {
    lines.push(status.message ?? "No quality gate commands configured");
  }

  for (const result of status.results) {
    lines.push(`=== ${result.name} ===`);
    lines.push(`command: ${result.command}`);
    if (result.stdout) lines.push(result.stdout.trimEnd());
    if (result.stderr) lines.push(result.stderr.trimEnd());
    lines.push(`exit_code: ${result.exit_code}`);
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

export async function runQualityGates(
  ports: QualityGatesPorts,
  args: string[] = [],
  options: RunQualityGatesOptions = {},
): Promise<QualityGatesStatus> {
  const projectRoot = options.projectRoot ?? process.cwd();
  const scope = parseQualityScope(args);
  const policy = await ports.loadPolicy();
  const checks = resolveQualityChecks(policy, scope);
  const commandContext = await ports.commandContext(policy);
  const commands = checks.map((check) => check.display);
  const updatedAt = (options.now ?? new Date()).toISOString();

  if (commands.length === 0) {
    const status: QualityGatesStatus = {
      passed: false,
      exit_code: 1,
      has_commands: false,
      scope,
      commands,
      skipped: [scope],
      failed_gates: [],
      results: [],
      message: `No quality gate commands configured for scope '${scope}'`,
      updated_at: updatedAt,
    };
    await ports.writeStatus(status);
    await ports.writeChecksLog(renderChecksLog(status));
    return status;
  }

  // Vartų memoizacija: identiškas medis + identiškos komandos = paskutinis žalias verdiktas
  // tebegalioja, suite nekartojamas. `memoActive` valdo VISĄ mechanizmą, `--no-memo` išjungia
  // tik pasitikėjimą jau esamu įrašu.
  const memoActive = (options.memo ?? true) && ports.memoPort !== undefined;
  const memoPort = ports.memoPort;
  const memoNotes: string[] = [];
  const identityBefore =
    memoActive && memoPort ? await memoPort.identify({ projectRoot, scope, commands }) : null;

  if (identityBefore !== null && memoPort && !args.includes("--no-memo")) {
    const memoRead = await memoPort.read(projectRoot);
    if (memoRead.status === "corrupted") {
      // Fail-open, bet GARSIAI: sugadintas antspaudas reiškia pilną suite, o ne tylų praėjimą.
      memoNotes.push(`quality-gates memo ignoruotas — sugadintas įrašas: ${memoRead.errors.join("; ")}`);
    } else if (memoCovers(memoRead, identityBefore, scope, commands)) {
      const marker = `QUALITY GATES PASSED: memo ${identityBefore.key}`;
      const passedAt = memoRead.status === "hit" ? memoRead.record.passed_at : updatedAt;
      const status: QualityGatesStatus = {
        passed: true,
        exit_code: 0,
        has_commands: true,
        scope,
        commands,
        skipped: [],
        failed_gates: [],
        results: [
          {
            name: `${scope}-memo`,
            command: "(memoized)",
            exit_code: 0,
            stdout:
              `${marker}\nMedis nepasikeitęs nuo paskutinio žalio paleidimo (${passedAt}). ` +
              "Identiško medžio pertikrinimas neduoda informacijos — suite praleistas.",
            stderr: "",
          },
        ],
        message: marker,
        updated_at: updatedAt,
      };
      await ports.writeStatus(status);
      await ports.writeChecksLog(renderChecksLog(status, [marker]));
      return status;
    }
  }

  const localEnv = await ports.loadLocalEnv().catch(() => ({}) as Record<string, string>);
  const gateEnv: Record<string, string | undefined> = { ...process.env, ...localEnv };
  const results: QualityGateResult[] = [];

  for (const [index, check] of checks.entries()) {
    const name = `${scope}-${index + 1}`;
    const command = check.display;
    const policyResult =
      check.kind === "shell"
        ? evaluateShellQualityCommand(check.display, commandContext)
        : evaluateSpawnQualityCommand(check.cmd, check.args, commandContext);
    if (policyResult.blockedPattern) {
      results.push({
        name,
        command,
        exit_code: 126,
        stdout: "",
        stderr: `Quality gate command blocked by ${check.kind} policy: ${policyResult.blockedPattern}`,
      });
      continue;
    }

    const result = await ports.runner(check, projectRoot, 30 * 60 * 1000, gateEnv);
    results.push({
      name,
      command,
      exit_code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  }

  const failedGates = results.filter((result) => result.exit_code !== 0).map((result) => result.name);
  const passed = failedGates.length === 0;
  if (memoActive && memoPort) {
    // Raudonas verdiktas NIEKADA nerašomas ir dar išvalo esamą įrašą: kol suite raudona,
    // memo apskritai neturi teisės egzistuoti.
    if (!passed) await memoPort.clear(projectRoot);
    else await recordGreenMemo(projectRoot, memoPort, identityBefore, scope, commands, updatedAt, memoNotes);
  }
  const status: QualityGatesStatus = {
    passed,
    exit_code: passed ? 0 : 1,
    has_commands: true,
    scope,
    commands,
    skipped: [],
    failed_gates: failedGates,
    results,
    updated_at: updatedAt,
  };
  await ports.writeStatus(status);
  await ports.writeChecksLog(renderChecksLog(status, memoNotes));
  return status;
}

/**
 * Žalio verdikto antspaudas rašomas su tapatybe, PERSKAIČIUOTA PO paleidimo, o ne su ta,
 * kuri buvo tikrinta prieš jį. Priežastis: vartų komanda pati perkompiliuoja `dist`, tad
 * po paleidimo `dist` tapatybė kita nei prieš — įrašius „prieš" tapatybę, kitas paleidimas
 * ant nepakitusio medžio vis tiek prašautų, ir memo pataikytų tik kas antrą kartą.
 *
 * Bet perskaičiuoti galima tik `dist` dalį. Jei paleidimo metu pasikeitė PATS MEDIS ar vartų
 * konfigas (lygiagreti sesija rašė į tą pačią darbo kopiją), tai, ką ką tik patvirtinome,
 * nebeatitinka to, kas guli diske — tokiu atveju neįrašoma nieko.
 */
async function recordGreenMemo(
  projectRoot: string,
  memoPort: GatesMemoPort,
  identityBefore: GatesMemoIdentity | null,
  scope: QualityScope,
  commands: readonly string[],
  passedAt: string,
  notes: string[],
): Promise<void> {
  if (identityBefore === null) return;
  const identityAfter = await memoPort.identify({ projectRoot, scope, commands });
  if (identityAfter === null) return;
  if (identityAfter.tree !== identityBefore.tree || identityAfter.config !== identityBefore.config) {
    await memoPort.clear(projectRoot);
    notes.push("quality-gates memo neįrašytas — medis pasikeitė vartų vykdymo metu");
    return;
  }
  await memoPort.write(projectRoot, gatesMemoRecordFor(identityAfter, scope, commands, passedAt));
}
