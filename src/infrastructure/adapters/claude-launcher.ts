// Matomas (visible) Claude dispatch paleidiklis — PowerShell skripto builder'is su
// dispatch-nonce watchdog'u (etalonas: AG_loop orchestrator/adapters/claude-launcher.ts 1:1).
// Skirtumai tik VERQESTRA layout: exit kodai iš shared/exit-codes, maxTurns builder'is iš
// claude-tool-schema, stop-bridge failo bazinis vardas lieka `claude-stop-status.json`
// (vq/state — žr. state/stop-bridge.ts).

import { claudeMaxTurnsArgs } from "./claude-tool-schema.js";
import { DISPATCH_TIMEOUT_EXIT_CODE, EXECUTOR_UNAVAILABLE_EXIT_CODE } from "../../shared/exit-codes.js";

export type VisibleClaudeLauncherOptions = {
  projectRoot: string;
  promptPath: string;
  model: string;
  exitFile: string;
  /** Pirminis sesijos srauto log'as. Nuo 2026-08-09 tai yra bandymo (`attempt`) kanalas, jei jis žinomas. */
  logFile: string;
  /**
   * Antrinis, BEST-EFFORT log veidrodis (globalus `vq/logs/claude-last.log`). Jis egzistuoja tik
   * dėl skaitytojų už bandymo namespace'o ribų (dashboard, operatoriaus `tail`), todėl jo
   * rašymo klaida — pvz. gyvos senesnės sesijos laikomas failas (EBUSY) — NEGALI nutraukti
   * sesijos: abi jo komandos tyliai praleidžia savo klaidas. Nenurodžius veidrodžio nėra ir
   * skriptas lieka toks pat, koks buvo iki šio lauko.
   */
  mirrorLogFile?: string;
  /**
   * The one canonical dispatch timeout (same value the dispatch path passes as
   * `timeoutMs` to the outer run() call). The launcher's own inner WaitForExit budget
   * is derived from this — see resolveVisibleLauncherTimeoutMs — instead of reading an
   * independently configurable env var, so the two timeout layers can never disagree.
   */
  dispatchTimeoutMs: number;
  /**
   * Dispatch sesijos turn limitas (`claude -p --max-turns N`). Etalono 2026-07-22 pamoka:
   * be limito viena užduotis suko ~250 API ėjimų (51M cache-read, ~$20) iki wall-clock
   * timeout'o. Reikšmę validuoja claudeMaxTurnsArgs (tik teigiamas sveikas skaičius virsta
   * flag'u), todėl interpoliacija į PowerShell komandą saugi. Nenurodyta/<=0 — be ribos.
   */
  maxTurns?: number;
  /**
   * Unikalus šio dispatch'o nonce (etalono 2026-08-04 watchdog incidentas). Įrašomas į
   * sesijos env (AG_DISPATCH_NONCE), Stop hook'as jį persineša į claude-stop-status.json,
   * o watchdog'as reaguoja TIK į "done" su šiuo nonce — lygiagrečios interaktyvios sesijos
   * "done" (be nonce arba su kitu) nebegali nužudyti šios dispatch sesijos.
   * Tik [a-z0-9] — interpoliuojama į PS ir regex.
   */
  dispatchNonce: string;
  /**
   * `dispatch_tool_schema` profilis matomam paleidikliui (etalono task 0005). Reikšmės
   * ateina iš config'u valdomos politikos, todėl laikomos NEPATIKIMA įvestimi ir tikrinamos
   * SAFE_TOOL_NAME allowlist'u prieš bet kokią interpoliaciją. Nenurodyta arba tuščias
   * sąrašas — komanda lieka baitas į baitą tokia pati kaip iki šio lauko.
   */
  disallowedTools?: readonly string[];
};

const SAFE_NONCE = /^[a-z0-9]{8,64}$/;

/**
 * Tas pats raidynas, kurį jau taiko `buildDispatchDisallowedTools` (claude-tool-schema.ts).
 * Kartojamas čia sąmoningai: paleidiklis yra command-injection paviršius ir privalo galioti
 * pats sau, o ne pasitikėti, kad kvietėjas sąrašą jau išfiltravo. Kablelis irgi neleidžiamas —
 * sąrašas į CLI keliauja kaip VIENA kableliais atskirta reikšmė, tad vardas su kableliu galėtų
 * įrašyti į ją papildomą įrašą.
 */
const SAFE_TOOL_NAME = /^[A-Za-z0-9_-]+$/;

// Etalono F5 (ag-runtime-dispatch-hardening): šis skriptas anksčiau skaitė NUOSAVĄ
// CLAUDE_VISIBLE_TIMEOUT_MS env var su nepriklausomu default'u (90 min), atskirai nuo
// išorinio dispatch timeout'o (60 min). Dvi nepriklausomos rankenėlės reiškė, kad laimi
// mažesnė — o pilną process-tree kill darė tik išorinis Node run() timeout'as; vidinis
// kelias žudė tik tiesioginį child'ą ir palikdavo pipe'intą `claude` anūką našlaičiu.
// Dabar yra viena kanoninė reikšmė (dispatchTimeoutMs); vidinis skriptas išsiveda
// griežtai mažesnį biudžetą, tad jis visada gauna pirmą, švarų šansą suveikti ir
// nužudyti pilną procesų medį anksčiau nei išorinis Node timeout'as.
export const VISIBLE_LAUNCHER_TIMEOUT_GRACE_MS = 10_000;
const MIN_VISIBLE_LAUNCHER_TIMEOUT_MS = 1_000;

export function resolveVisibleLauncherTimeoutMs(dispatchTimeoutMs: number): number {
  if (!Number.isFinite(dispatchTimeoutMs) || dispatchTimeoutMs <= 0) {
    throw new Error(`Invalid dispatch timeout ms for visible launcher: ${dispatchTimeoutMs}`);
  }
  return Math.max(MIN_VISIBLE_LAUNCHER_TIMEOUT_MS, dispatchTimeoutMs - VISIBLE_LAUNCHER_TIMEOUT_GRACE_MS);
}

function psSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

// Šios reikšmės įterpiamos į dvigubų kabučių here-string (`@"..."@`) ir Write-Host
// eilutes. Dvigubų kabučių here-string PowerShell plečia `$(...)`, `$var` ir `"`,
// todėl psSingleQuote ten NEapsaugo. Validuojame patį turinį, kad kompromituotas
// config/env (model iš models.env, projectRoot iš CLAUDE_PROJECT_DIR) negalėtų
// injektuoti komandų.
const POWERSHELL_UNSAFE = /[`"$\r\n]/;

function assertSafeLauncherValue(label: string, value: string): string {
  if (POWERSHELL_UNSAFE.test(value)) {
    throw new Error(
      `Nesaugi reikšmė '${label}' PowerShell paleidikliui (negalimi simboliai: \` " $ ar naujos eilutės): ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/**
 * `--disallowed-tools` segmentas `claude -p ...` eilutei arba tuščias stringas.
 *
 * Du sluoksniai, kaip ir `--model` atveju: (1) allowlist — vardas be jokių PowerShell
 * metasimbolių (backtick, `"`, `$`, kablelis, tarpas, nauja eilutė NEPRAEINA), (2) vienguba
 * kabutė apie visą kableliais sujungtą reikšmę, kad ji būtų vienas argumentas ir dvigubų
 * kabučių here-string'e neišplėtotų nieko. Tuščias sąrašas negrąžina flag'o — taip
 * išjungtas `dispatch_tool_schema` palieka komandą baitas į baitą nepakitusią.
 */
function buildDisallowedToolsSuffix(tools: readonly string[] | undefined): string {
  if (tools === undefined || tools.length === 0) return "";
  for (const tool of tools) {
    if (!SAFE_TOOL_NAME.test(tool)) {
      throw new Error(
        `Nesaugus disallowed-tool vardas PowerShell paleidikliui (tik [A-Za-z0-9_-]): ${JSON.stringify(tool)}`,
      );
    }
  }
  return ` --disallowed-tools ${psSingleQuote(tools.join(","))}`;
}

export function createVisibleClaudeLauncher(options: VisibleClaudeLauncherOptions): string {
  const {
    projectRoot,
    promptPath,
    model,
    exitFile,
    logFile,
    mirrorLogFile,
    dispatchTimeoutMs,
    maxTurns,
    dispatchNonce,
    disallowedTools,
  } = options;
  assertSafeLauncherValue("projectRoot", projectRoot);
  assertSafeLauncherValue("promptPath", promptPath);
  assertSafeLauncherValue("model", model);
  assertSafeLauncherValue("exitFile", exitFile);
  assertSafeLauncherValue("logFile", logFile);
  if (mirrorLogFile !== undefined) assertSafeLauncherValue("mirrorLogFile", mirrorLogFile);
  if (!SAFE_NONCE.test(dispatchNonce)) {
    throw new Error(`Nesaugus dispatch nonce PowerShell paleidikliui (tik [a-z0-9]{8,64}): ${JSON.stringify(dispatchNonce)}`);
  }
  const innerTimeoutMs = resolveVisibleLauncherTimeoutMs(dispatchTimeoutMs);
  // claudeMaxTurnsArgs praleidžia tik teigiamą sveiką skaičių — saugu interpoliuoti.
  const maxTurnsArgs = claudeMaxTurnsArgs(maxTurns);
  const maxTurnsSuffix = maxTurnsArgs.length > 0 ? ` ${maxTurnsArgs.join(" ")}` : "";
  // Validuojama PRIEŠ bet kokį skripto turinio sudarymą: netinkama reikšmė meta klaidą ir
  // paleidiklio failas apskritai nepasiekia disko su nepatikrinta reikšme viduje.
  const disallowedToolsSuffix = buildDisallowedToolsSuffix(disallowedTools);
  const quotedProjectRoot = psSingleQuote(projectRoot);
  const quotedPromptPath = psSingleQuote(promptPath);
  const quotedModel = psSingleQuote(model);
  const quotedExitFile = psSingleQuote(exitFile);
  const quotedLogFile = psSingleQuote(logFile);
  const quotedMirrorLogFile = mirrorLogFile === undefined ? undefined : psSingleQuote(mirrorLogFile);
  // `-ErrorAction SilentlyContinue`: veidrodis yra patogumas, ne įrodymas. Užrakintas globalus
  // failas nutildomas čia, o ne verčia pipeline'ą kartoti klaidą kiekvienai srauto eilutei.
  const mirrorTee = quotedMirrorLogFile === undefined
    ? ""
    : ` | Tee-Object -FilePath ${quotedMirrorLogFile} -Append -ErrorAction SilentlyContinue`;
  const mirrorTruncateLines = quotedMirrorLogFile === undefined
    ? []
    : [`Set-Content -LiteralPath ${quotedMirrorLogFile} -Value '' -ErrorAction SilentlyContinue`];
  // Stop bridge failas gyvena tame pačiame state/ kataloge kaip exitFile —
  // išvedama, ne konfigūruojama, kad watchdog'as visada stebėtų tą patį failą,
  // kurį dispatch kelias išvalo prieš paleidimą ir Stop hook'as užpildo.
  const stopStatusFile = exitFile.replace(/[^\\/]+$/, "claude-stop-status.json");
  const quotedStopStatusFile = psSingleQuote(stopStatusFile);

  return [
    "param()",
    "",
    "$pwshPath = (Get-Process -Id $PID).Path",
    '$inner = @"',
    `\`$env:CLAUDE_PROJECT_DIR = ${quotedProjectRoot}`,
    // Nonce paveldi TIK ši sesija ir jos hook'ai — Stop hook'as jį įrašo į stop
    // bridge, o watchdog'as žemiau reikalauja BŪTENT šio nonce (svetimų sesijų
    // "done" nebegali nužudyti šios sesijos medžio).
    `\`$env:AG_DISPATCH_NONCE = '${dispatchNonce}'`,
    `Set-Location -LiteralPath ${quotedProjectRoot}`,
    "`$nl = [Environment]::NewLine",
    "Write-Host 'Claude Code task runner started.'",
    // Even these purely informational lines go through psSingleQuote: a Windows directory may
    // legally contain an apostrophe (C:\Users\O'Brien\repo), and a raw one would close the quoted
    // string and let the rest of the path run as PowerShell — assertSafeLauncherValue does not
    // reject `'`, because inside a properly quoted string it is harmless.
    `Write-Host ('Project: ' + ${quotedProjectRoot})`,
    `Write-Host ('Model: ' + ${quotedModel})`,
    "Write-Host ''",
    `Set-Content -LiteralPath ${quotedLogFile} -Value ('Claude task runner started at ' + (Get-Date -Format o) + \`$nl + 'Project: ' + ${quotedProjectRoot} + \`$nl + 'Model: ' + ${quotedModel} + \`$nl + 'Prompt: ' + ${quotedPromptPath} + \`$nl)`,
    ...mirrorTruncateLines,
    // Etalono 2026-08-09 pamoka: trūkstamas vykdytojas anksčiau baigdavosi TYLIA sėkme —
    // PowerShell nepaleistos komandos `$LASTEXITCODE` lieka `$null`, tad skriptas grąžindavo 0,
    // o loop'as gedimą atpažindavo tik regex'u ant log teksto. Dabar tai deterministinis exit
    // kodas, kurį `isInfrastructureExitCode` klasifikuoja be jokio teksto.
    "if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {",
    "  Write-Host 'claude CLI was not found on PATH — nothing was dispatched.'",
    `  Set-Content -LiteralPath ${quotedExitFile} -Value ${EXECUTOR_UNAVAILABLE_EXIT_CODE} -NoNewline`,
    `  exit ${EXECUTOR_UNAVAILABLE_EXIT_CODE}`,
    "}",
    `Get-Content -LiteralPath ${quotedPromptPath} -Raw | & claude -p --verbose --output-format stream-json --include-partial-messages --include-hook-events --permission-mode auto --model ${quotedModel}${maxTurnsSuffix}${disallowedToolsSuffix} 2>&1 | Tee-Object -FilePath ${quotedLogFile} -Append${mirrorTee}`,
    "`$exitCode = `$LASTEXITCODE",
    "if (`$null -eq `$exitCode) { `$exitCode = 0 }",
    `Set-Content -LiteralPath ${quotedExitFile} -Value \`$exitCode -NoNewline`,
    "Write-Host ''",
    "Write-Host ('Claude finished with exit code ' + `$exitCode + '.')",
    "if (`$exitCode -ne 0) {",
    "  Write-Host ''",
    "  Write-Host 'Claude returned an error. Returning control to the loop after 10 seconds.'",
    "  Start-Sleep -Seconds 10",
    "}",
    "exit `$exitCode",
    '"@',
    "",
    `$timeoutMs = ${innerTimeoutMs}`,
    "$process = Start-Process `",
    "  -FilePath $pwshPath `",
    "  -ArgumentList @('-NoLogo', '-NoProfile', '-Command', $inner) `",
    `  -WorkingDirectory ${quotedProjectRoot} \``,
    "  -WindowStyle Normal `",
    "  -PassThru",
    "",
    // Etalono 1047 hang: vidinio lango `claude ... | Tee-Object` pipeline baigiasi tada, kai
    // užsidaro claude stdout PIPE, o ne kai claude procesas baigia darbą. Hook child'as,
    // paveldėjęs stdout handle ir niekada nepasibaigiantis, laiko pipe atvirą amžinai —
    // sesija baigta (Stop hook'as į stop bridge įrašė "done"), darbas užcommit'intas, bet
    // pipeline, vidinis langas ir šis išorinis skriptas kabo iki pilno dispatch timeout'o.
    // Watchdog: poll'ina procesą IR stop bridge; kai bridge sako "done", o procesas per grace
    // biudžetą taip ir nepasibaigė — žudo medį ir grįžta: stream log'e jau yra result
    // envelope, o diagnozė skaito stop bridge, tad niekas neprarandama.
    `$stopStatusPath = ${quotedStopStatusFile}`,
    `$exitFilePath = ${quotedExitFile}`,
    "$stopDoneGraceMs = 180000",
    "$deadline = [DateTime]::UtcNow.AddMilliseconds($timeoutMs)",
    "$stopDoneAt = $null",
    "while (-not $process.HasExited) {",
    "  if ([DateTime]::UtcNow -gt $deadline) {",
    // Pilnas process-tree kill, ne plikas $process.Kill() — $process yra vidinis pwsh,
    // pipe'inęs prompt'ą į `claude`; paprastas Kill() nužudo tik tiesioginį child'ą ir gali
    // palikti pipe'intą `claude` anūką našlaičiu. taskkill /T pereina ir nužudo visą medį
    // nuo šio PID tiek pwsh 7, tiek Windows PowerShell 5.1 (kitaip nei Process.Kill(true),
    // kuriam reikia .NET Core 3+).
    "    & taskkill.exe /T /F /PID $process.Id *> $null",
    `    exit ${DISPATCH_TIMEOUT_EXIT_CODE}`,
    "  }",
    "  if ($null -eq $stopDoneAt) {",
    "    try { $stopRaw = Get-Content -LiteralPath $stopStatusPath -Raw -ErrorAction Stop } catch { $stopRaw = '' }",
    // Tik status "done" — Stop hook'as rašo ir "error" (quality gates blokavo stop),
    // po kurio sesija toliau dirba; jos žudyti negalima. IR tik SU ŠIOS sesijos
    // dispatch_nonce (etalono 2026-08-04): globalų bridge failą rašo ir lygiagrečios
    // interaktyvios sesijos — jų "done" be šio nonce anksčiau nužudydavo ką tik
    // startavusią dispatch sesiją (zero-usage avarijos).
    `    if ($stopRaw -match '"status"\\s*:\\s*"done"' -and $stopRaw -match '"dispatch_nonce"\\s*:\\s*"${dispatchNonce}"') { $stopDoneAt = [DateTime]::UtcNow }`,
    "  } elseif (([DateTime]::UtcNow - $stopDoneAt).TotalMilliseconds -gt $stopDoneGraceMs) {",
    "    & taskkill.exe /T /F /PID $process.Id *> $null",
    "    try { $exitRaw = (Get-Content -LiteralPath $exitFilePath -Raw -ErrorAction Stop).Trim() } catch { $exitRaw = '' }",
    "    if ($exitRaw -match '^\\d+$') { exit [int]$exitRaw }",
    "    exit 0",
    "  }",
    "  Start-Sleep -Milliseconds 500",
    "}",
    "exit $process.ExitCode",
    "",
  ].join("\n");
}
