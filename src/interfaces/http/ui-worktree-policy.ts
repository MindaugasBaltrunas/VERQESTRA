// Worktree politikos PERJUNGIMO modulis dashboard'ui (be HTTP maršruto ir be UI, AG 088).
//
// Du dalykai, kurie yra šio modulio kontraktas:
//
//   1. TIK `enabled` KEIČIASI. Konfigas skaitomas kaip generinis JSON objektas, o ne per domeno
//      schemą: kiti esami laukai (pvz. `root`, `branchPrefix`) keliauja per `{ ...raw }` spread'ą
//      nepaliesti, tad šis modulis niekada tyliai neatkuria to, ką 077 vėliau pašalins.
//   2. `.gitignore` LIEČIAMAS TIK ĮJUNGIANT IR TIK JEI EILUTĖS TRŪKSTA. Išjungimas failo
//      neskaito ir nerašo — „niekada" reiškia nė vieno efekto, ne efektą su tuščiu rezultatu.
//      Įjungimas prideda eilutę gale su komentaru; esamas turinys niekada nekeičiamas.

import path from "node:path";

const WORKTREE_GITIGNORE_LINE = ".ag/worktrees/";
const WORKTREE_GITIGNORE_COMMENT = "# VERQESTRA: worktree izoliacijos katalogas (auto-pridėta)";

export class InvalidWorktreePolicyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidWorktreePolicyConfigError";
  }
}

export type WorktreePolicyPorts = {
  readConfigFile(absolutePath: string): Promise<string>;
  writeConfigFile(absolutePath: string, content: string): Promise<void>;
  /** `undefined`, jei `.gitignore` neegzistuoja — skiriasi nuo tuščio failo. */
  readGitignore(absolutePath: string): Promise<string | undefined>;
  writeGitignore(absolutePath: string, content: string): Promise<void>;
  log(message: string): void;
};

export type SetWorktreePolicyEnabledInput = {
  /** vq runtime šaknis (`<root>/vq`) — konfigas gyvena `<runtimeRoot>/config/worktree-policy.json`. */
  runtimeRoot: string;
  /** Repozitorijos šaknis — `.gitignore` gyvena čia. */
  projectRoot: string;
  enabled: boolean;
};

export type SetWorktreePolicyEnabledResult = {
  enabled: boolean;
  gitignore_ok: boolean;
};

function parseRawConfig(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new InvalidWorktreePolicyConfigError(
      `worktree-policy.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new InvalidWorktreePolicyConfigError("worktree-policy.json must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function hasWorktreeGitignoreLine(content: string): boolean {
  return content.split(/\r?\n/).some((line) => line.trim() === WORKTREE_GITIGNORE_LINE);
}

/** Prideda eilutę gale su komentaru; esamas turinys (įskaitant jo formatavimą) nekeičiamas. */
function appendWorktreeGitignoreLine(content: string): string {
  const withoutTrailingBlankLines = content.replace(/\n+$/, "");
  const prefix = withoutTrailingBlankLines.length > 0 ? `${withoutTrailingBlankLines}\n\n` : "";
  return `${prefix}${WORKTREE_GITIGNORE_COMMENT}\n${WORKTREE_GITIGNORE_LINE}\n`;
}

export async function setWorktreePolicyEnabled(
  ports: WorktreePolicyPorts,
  input: SetWorktreePolicyEnabledInput,
): Promise<SetWorktreePolicyEnabledResult> {
  const configFile = path.join(input.runtimeRoot, "config", "worktree-policy.json");
  const raw = parseRawConfig(await ports.readConfigFile(configFile));
  const updated = { ...raw, enabled: input.enabled };
  await ports.writeConfigFile(configFile, `${JSON.stringify(updated, null, 2)}\n`);

  let gitignoreStatus: "ok" | "appended" = "ok";
  if (input.enabled) {
    const gitignoreFile = path.join(input.projectRoot, ".gitignore");
    const current = (await ports.readGitignore(gitignoreFile)) ?? "";
    if (!hasWorktreeGitignoreLine(current)) {
      await ports.writeGitignore(gitignoreFile, appendWorktreeGitignoreLine(current));
      gitignoreStatus = "appended";
    }
  }

  ports.log(`WORKTREE POLICY: enabled=${input.enabled} gitignore=${gitignoreStatus}`);
  return { enabled: input.enabled, gitignore_ok: true };
}
