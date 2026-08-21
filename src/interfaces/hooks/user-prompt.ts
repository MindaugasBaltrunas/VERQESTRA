// `UserPromptSubmit` hook'as (etalonas: AG_loop hooks/user-prompt.ts): vieną kartą per sesiją
// į prompt'ą įterpia orkestratoriaus konteksto bloką.
//
// „Vieną kartą" saugo vėliavos failas `vq/logs/.context-shown`: be jo tas pats blokas kartotųsi
// prie KIEKVIENO vartotojo prompt'o ir kainuotų tokenus visą sesiją. Vėliavą valo SessionStart.

import path from "node:path";
import { consoleHookIo, type HookFsPort, type HookIo } from "./protocol.js";

/**
 * Aktyvių agentų santrauka. Numatytoji reikšmė — etalono tekstas 1:1 (DUOMENYS, ne politika);
 * kompozicija gali paduoti realų sąrašą iš `vq/config/agents.json`, kai to prireiks, nekeičiant
 * šio modulio.
 */
export const DEFAULT_AGENT_SUMMARY =
  "architect, data-model, migrator, schedule-domain(module-domain), coder, reviewer, security, tester, i18n, performance, debugger, documenter, supervisor";

export type UserPromptContext = {
  /** Kiek sesijų užfiksuota `session.md` (dabartinė imtinai). */
  previousSessions: number;
  /** Paskutinė `SESSION_END` eilutė iš istorijos arba `undefined`. */
  lastSession: string | undefined;
  agentSummary: string;
};

/** Grynas konteksto bloko renderis — testai jį pin'ina be failų sistemos. */
export function renderUserPromptContext(context: UserPromptContext): string {
  const output: string[] = ["## Projekto orkestratoriaus kontekstas", ""];

  if (context.previousSessions <= 1) {
    output.push("**Pirmoji sesija** siame projekte.");
  } else {
    output.push(`**Sesijos numeris:** ${context.previousSessions}`, "");
    if (context.lastSession) {
      output.push(`**Paskutine sesija:** ${context.lastSession}`);
    }
    output.push("", "**Priminimas:** Perskaityk `vq/logs/session.md` jei reikia testi darba.");
  }

  output.push("");
  output.push(`**Aktyvus agentai:** ${context.agentSummary}`);
  output.push("**Auto-fix:** ijungtas (reviewer ir debugger taiso be patvirtinimo)");
  output.push("");
  return output.join("\n");
}

export type UserPromptDeps = {
  fs: HookFsPort;
  /** vq runtime šaknis (`<root>/vq`). */
  runtimeRoot: string;
  /** Agentų santrauka; numatytai — {@link DEFAULT_AGENT_SUMMARY}. */
  agentSummary?: string;
  now?: () => Date;
  io?: HookIo;
};

export async function hookUserPrompt(deps: UserPromptDeps): Promise<number> {
  const io = deps.io ?? consoleHookIo;
  const logDir = path.join(deps.runtimeRoot, "logs");
  const contextFlag = path.join(logDir, ".context-shown");

  await deps.fs.makeDirectory(logDir);
  if (await deps.fs.exists(contextFlag)) return 0;
  await deps.fs.writeTextFile(contextFlag, "");

  const sessionText = (await deps.fs.readTextFileIfExists(path.join(logDir, "session.md"))) ?? "";
  const historyText = (await deps.fs.readTextFileIfExists(path.join(logDir, "history.log"))) ?? "";

  io.out(
    renderUserPromptContext({
      previousSessions: (sessionText.match(/^## Sesija/gm) ?? []).length,
      lastSession: historyText
        .split(/\r?\n/)
        .filter((line) => line.includes("SESSION_END"))
        .at(-1),
      agentSummary: deps.agentSummary ?? DEFAULT_AGENT_SUMMARY,
    }),
  );

  const stamp = (deps.now?.() ?? new Date()).toISOString();
  await deps.fs.appendTextFile(path.join(logDir, "hooks.log"), `[${stamp}] UserPromptSubmit — kontekstas pateiktas\n`);
  return 0;
}
