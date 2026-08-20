// Git automatikos politika (`vq/config/git-automation-policy.json`) — schema, fail-closed
// default'ai ir loaderis (etalono policy/git-automation-policy.ts, WBR VQ-305).
// Commit pavadinimo taisyklė (`commitTitleFromFiles`) — domain/policies/commit-message (FQC-12).
import path from "node:path";
import { z } from "zod";
import { validateWithSchema } from "../../shared/schema.js";
import { commitTitleFromFiles } from "../../domain/policies/commit-message.js";
import type { PolicyConfigFileSystemPort } from "./ports.js";

export type GitAutomationPolicy = {
  auto_commit_enabled: boolean;
  auto_push_enabled: boolean;
  conventional_commits_required: boolean;
  pr_after_successful_task: boolean;
  pr_requires_create_flag: boolean;
  release_notes_after_final_audit: boolean;
  release_notes_path: string;
  /**
   * Nustatoma TIK fail-closed atveju (žr. {@link failClosedGitAutomationPolicy}):
   * konfigas egzistuoja, bet yra netinkamas. Kvietėjai gali parodyti priežastį; pati
   * politika jau saugi.
   */
  config_error?: string;
};

export const defaultGitAutomationPolicy: GitAutomationPolicy = {
  auto_commit_enabled: true,
  auto_push_enabled: true,
  conventional_commits_required: true,
  pr_after_successful_task: true,
  pr_requires_create_flag: true,
  release_notes_after_final_audit: true,
  release_notes_path: "vq/project/release-notes.md",
};

const conventionalCommitPattern = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([A-Za-z0-9._/ -]+\))?!?: .+/;

/**
 * Netinkamas konfigas = IŠORINIAI, sunkiai atšaukiami veiksmai IŠJUNGTI (etalono task 0057).
 *
 * Parse klaida anksčiau grąžindavo PERMISYVIUS default'us su `auto_push_enabled: true` —
 * sugadintas konfigas paleisdavo push'ą į remote. Kryptis apversta: neaiškus konfigas
 * nebeįjungia nieko, ko negalima atšaukti.
 *
 * `auto_commit_enabled` SĄMONINGAI lieka `true`: lokalus commit'as yra atstatomas ir jis
 * saugo sesijos darbą nuo dirty-tree rollback kaskados, o būtent tos kaskados kaina yra
 * didesnė už neįvykusį commit'ą.
 */
export const failClosedGitAutomationPolicy: GitAutomationPolicy = {
  auto_commit_enabled: true,
  auto_push_enabled: false,
  conventional_commits_required: true,
  pr_after_successful_task: false,
  pr_requires_create_flag: true,
  release_notes_after_final_audit: false,
  release_notes_path: defaultGitAutomationPolicy.release_notes_path,
};

// Griežta schema: tik TIKRI boolean. `raw?.x !== false` stiliaus koercija bet kokią
// ne-`false` reikšmę (`"no"`, `0`, `null`) paverstų `true` — konfigas atrodytų perskaitytas,
// o realiai reikštų priešingai. Nežinomas raktas taip pat yra klaida: tylus ignoravimas
// reikštų konfigą, kuris atrodo pakeistas, bet nieko nekeičia.
const gitAutomationPolicySchema = z.strictObject({
  auto_commit_enabled: z.boolean().optional(),
  auto_push_enabled: z.boolean().optional(),
  conventional_commits_required: z.boolean().optional(),
  pr_after_successful_task: z.boolean().optional(),
  pr_requires_create_flag: z.boolean().optional(),
  release_notes_after_final_audit: z.boolean().optional(),
  release_notes_path: z.string().optional(),
});

export function gitAutomationPolicyPath(runtimeRoot: string): string {
  return path.join(runtimeRoot, "config", "git-automation-policy.json");
}

/** Fail-closed pranešimų kanalas; numatytasis — stderr (Stop hook'o išvestį mato operatorius). */
export type GitAutomationPolicyErrorSink = (message: string) => void;

/**
 * NIEKADA NEMETA — tai Stop hook'o saugumo kontraktas (etalono task 0057): throw'as čia
 * nužudytų stop procesą neįrašius stop-status, tad orkestratorius liktų apakęs, o sesijos
 * darbas — necommit'intas dirty medyje. Vietoj to netinkamas konfigas grąžina fail-closed
 * politiką ir garsų pranešimą per sink'ą.
 */
export async function loadGitAutomationPolicy(
  fs: PolicyConfigFileSystemPort,
  runtimeRoot: string,
  onError: GitAutomationPolicyErrorSink = (message) => console.error(message),
): Promise<GitAutomationPolicy> {
  const configPath = gitAutomationPolicyPath(runtimeRoot);
  const raw = await fs.readTextFileIfExists(configPath);
  // Failo nėra = produkto numatytoji būsena (install be konfigo), ne gedimas.
  if (!raw) return defaultGitAutomationPolicy;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    return failClosed(configPath, error instanceof Error ? error.message : String(error), onError);
  }

  const result = validateWithSchema(gitAutomationPolicySchema, parsed);
  if (!result.ok) {
    return failClosed(configPath, result.errors.join("; "), onError);
  }
  return normalizeGitAutomationPolicy(result.data);
}

function failClosed(configPath: string, reason: string, onError: GitAutomationPolicyErrorSink): GitAutomationPolicy {
  onError(`AG git-automation-policy: ${configPath} netinkamas — auto-push/PR išjungti (fail-closed): ${reason}`);
  return { ...failClosedGitAutomationPolicy, config_error: reason };
}

/**
 * Sulieja VALIDUOTĄ dalinį konfigą su numatytaisiais. Nevaliduotam įvedimui (netikri
 * boolean, nežinomi raktai) grąžina {@link failClosedGitAutomationPolicy} — ta pati saugi
 * kryptis kaip {@link loadGitAutomationPolicy}, kad kvietėjas negalėtų apeiti schemos
 * kviesdamas normalizatorių tiesiogiai.
 */
export function normalizeGitAutomationPolicy(raw: unknown): GitAutomationPolicy {
  const result = validateWithSchema(gitAutomationPolicySchema, raw ?? {});
  if (!result.ok) return { ...failClosedGitAutomationPolicy, config_error: result.errors.join("; ") };
  const parsed = result.data;
  return {
    auto_commit_enabled: parsed.auto_commit_enabled ?? defaultGitAutomationPolicy.auto_commit_enabled,
    auto_push_enabled: parsed.auto_push_enabled ?? defaultGitAutomationPolicy.auto_push_enabled,
    conventional_commits_required:
      parsed.conventional_commits_required ?? defaultGitAutomationPolicy.conventional_commits_required,
    pr_after_successful_task: parsed.pr_after_successful_task ?? defaultGitAutomationPolicy.pr_after_successful_task,
    pr_requires_create_flag: parsed.pr_requires_create_flag ?? defaultGitAutomationPolicy.pr_requires_create_flag,
    release_notes_after_final_audit:
      parsed.release_notes_after_final_audit ?? defaultGitAutomationPolicy.release_notes_after_final_audit,
    release_notes_path: normalizeReleaseNotesPath(parsed.release_notes_path),
  };
}

export function isConventionalCommitTitle(title: string): boolean {
  return conventionalCommitPattern.test(title.trim());
}

export function enforceCommitTitlePolicy(title: string, changedFiles: string[], policy: GitAutomationPolicy): string {
  const trimmed = title.trim();
  if (!policy.conventional_commits_required) return trimmed || commitTitleFromFiles(changedFiles);
  if (isConventionalCommitTitle(trimmed)) return trimmed;
  return commitTitleFromFiles(changedFiles);
}

function normalizeReleaseNotesPath(value: unknown): string {
  if (typeof value !== "string") return defaultGitAutomationPolicy.release_notes_path;
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) return defaultGitAutomationPolicy.release_notes_path;
  if (normalized.split("/").includes("..")) return defaultGitAutomationPolicy.release_notes_path;
  return normalized;
}
