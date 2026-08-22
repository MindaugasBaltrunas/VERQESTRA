// Headless `claude -p` paleidiklis (etalonas: AG_loop core/claude-headless.ts run pusė).
// win32 kelias prompt'ą paduoda per laikiną failą ir PowerShell pipe (stdin apėjimas);
// modelio ir kelio reikšmės escape'inamos prieš interpoliaciją, o maxTurns/disallowed
// argumentai gimsta tik iš validuotų builder'ių — env/config negali injektuoti komandų.

import { unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { commandExists, run, runWithInput } from "../process/run-process.js";
import { claudeDisallowedToolsArgs, claudeMaxTurnsArgs, isUnknownFlagFailure } from "./claude-tool-schema.js";

const DEFAULT_CLAUDE_HEADLESS_TIMEOUT_MS = 10 * 60 * 1000;

export const claudeModelSelectionRules = `- Parink selected_model pagal šias taisykles (pakopos nuo žemiausios iki aukščiausios: haiku -> sonnet -> opus):
  - haiku: užduotis aiški, paprasta arba rutiniškai kartojama; taisymas lokalus ir mažos rizikos; klaida akivaizdi, pvz. import/export, TypeScript, lint, formatavimo ar vieno aiškaus testo problema.
  - sonnet: standartinė implementacija aiškioje ribotoje srityje; vidutinio dydžio pakeitimas su testais; reikalavimas aiškus, bet darbas nėra trivialus.
  - opus: aukščiausia pakopa — užduotis neaiški, svarbi, sudėtinga arba kritinė; yra architektūros, DB/migration, security, public API, cross-platform, produkto elgsenos ar didesnio refactor rizika; sprendimas liečia kelis scope vienu metu; reikia interpretuoti dviprasmišką reikalavimą; arba tas pats error_signature jau kartojosi ir žemesnės pakopos modelis nesusitvarkė.
  - Jei žemesnės pakopos modelis jau bandė ir nepavyko (žr. retry counts), rinkis bent viena pakopa aukštesnį modelį.
  - Jei abejoji tarp dviejų pakopų, rinkis ŽEMESNĘ: nepavykus retry eskalacija automatiškai pakels modelį pakopa aukščiau, o sistemiškai per aukšta pakopa brangiai kainuoja kiekvienam task'ui. Aukštesnę be abejonių rinkis tik esant aiškiam rizikos signalui (DB/security/public API/architektūros sprendimas).`;

export function claudeHeadlessTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env["CLAUDE_HEADLESS_TIMEOUT_MS"];
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CLAUDE_HEADLESS_TIMEOUT_MS;
}

/**
 * Claude Code leidimų režimas.
 *
 * Portas, o ne konstanta, nuo VQ-802 audito: benchmark `agent-solo` celė pagal paketo
 * kontraktą paleidžiama su `acceptEdits`, o orkestratoriaus dispatch — su `auto`. Įrašius vieną
 * jų į paleidiklį, antrasis režimas arba nebūtų įmanomas, arba tyliai gautų svetimą režimą, ir
 * matavimas lygintų du dalykus, kurie skiriasi ne tuo, kuo skelbiasi.
 */
export type ClaudePermissionMode = "auto" | "acceptEdits";

export type ClaudeHeadlessOptions = {
  /** Sesijos turn limitas (`--max-turns N`). Nenurodyta arba <=0 — be ribos. */
  maxTurns?: number;
  /** Leidimų režimas; numatytasis `auto` — istorinė orkestratoriaus dispatch elgsena. */
  permissionMode?: ClaudePermissionMode;
  /**
   * Pašalinti rašymo/vykdymo įrankių schemas iš konteksto (semantinei peržiūrai jos
   * nereikalingos). Nepalaikomas flag'as automatiškai nuimamas ir kvietimas kartojamas.
   */
  disallowWriteTools?: boolean;
};

export async function runClaudeHeadless(
  prompt: string,
  model: string,
  stateDir: string,
  options: ClaudeHeadlessOptions = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  const first = await runClaudeHeadlessOnce(prompt, model, stateDir, options);
  if (options.disallowWriteTools !== true || !isUnknownFlagFailure(first)) return first;
  // Šio Claude Code diegimo CLI flag'o nepalaiko — kartojam be jo, kad peržiūra neliktų sulaužyta.
  return await runClaudeHeadlessOnce(prompt, model, stateDir, { ...options, disallowWriteTools: false });
}

async function runClaudeHeadlessOnce(
  prompt: string,
  model: string,
  stateDir: string,
  options: ClaudeHeadlessOptions = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  const timeoutMs = claudeHeadlessTimeoutMs();
  const permissionMode = options.permissionMode ?? "auto";
  const extraArgs = [...claudeMaxTurnsArgs(options.maxTurns), ...claudeDisallowedToolsArgs(options.disallowWriteTools)];
  if (process.platform === "win32") {
    const shell = (await commandExists("pwsh.exe")) ? "pwsh.exe" : "powershell.exe";
    const tmpFile = path.join(stateDir, "_claude-headless-prompt.tmp");
    await writeFile(tmpFile, prompt, "utf8");
    const escapedPath = tmpFile.replace(/'/g, "''");
    const escapedModel = model.replace(/'/g, "''");
    // extraArgs saugu interpoliuoti: builder'iai praleidžia tik sveiką skaičių ir
    // fiksuotą įrankių sąrašą.
    const extraSuffix = extraArgs.length > 0 ? ` ${extraArgs.join(" ")}` : "";
    const result = await run(
      shell,
      [
        "-NoLogo",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `Get-Content -LiteralPath '${escapedPath}' -Raw | & claude -p --output-format json --permission-mode ${permissionMode} --model '${escapedModel}'${extraSuffix}`,
      ],
      { timeoutMs },
    );
    try {
      await unlink(tmpFile);
    } catch {
      // valymo klaida ignoruojama
    }
    return result;
  }

  return await runWithInput(
    "claude",
    ["-p", "--output-format", "json", "--permission-mode", permissionMode, "--model", model, ...extraArgs],
    prompt,
    process.cwd(),
    timeoutMs,
  );
}
