// Worktree POLITIKA (etalonas: AG_loop orchestrator/git/worktree.ts; active-runtime nuo
// 2026-08-11 — antro worker slot'o izoliacija). Gryna: skaito ir validuoja politiką.
//
// 2026-08-24: iš čia PAŠALINTAS worktree komandų planuoklis (`planTaskWorktree`,
// `planWorktreeCleanup`, `WorktreePlan`, `gitCommandPlan`). Jis buvo be produkcinio kvietėjo —
// gyvasis kelias `worktree add`/`remove` argumentus statosi `infrastructure/git/worktrees`
// (`worktree-provision`, `worktree-removal`), ir tas kelias yra GRIEŽTESNIS: prieš destruktyvų
// `remove` jis tikrina dvi ribas (`assertInsideProject` projektui IR `WORKTREE_ROOT_DIR`),
// o planuoklis tikrino tik pirmąją. Tad tai ne „prarastas mechanizmas", o pakeistas aktyviu.

// `GitCommandPlan` PAŠALINTAS 2026-08-24 (audito patikra). Pirmą kartą jį palikau pagrindęs tuo,
// kad „jį naudoja `infrastructure/git/git-client#runGitPlan`" — bet `runGitPlan` pats kvietėjų
// neturėjo, tad grandinė buvo mirusi visa. Aktyvus kelias (`infrastructure/git/worktrees`) git
// argumentus statosi ir vykdo pats, be tarpinio plano tipo.
//
// 2026-08-30 (077): `root`/`branchPrefix`/`pathPrefix` PAŠALINTI iš tipo. Gyvos konstantos yra
// `.ag/worktrees` ir `ag/worker` (`worktree-layout.ts`), o abu produkciniai skaitytojai
// (`wave-scheduler-adapters.ts`, `router-adapters.ts`) skaitė TIK `.enabled`. Konfigo JSON su
// senais laukais toliau parsinamas — pertekliniai laukai tiesiog ignoruojami.

export type WorktreePolicy = {
  enabled: boolean;
};

export const defaultWorktreePolicy: WorktreePolicy = {
  enabled: false,
};

export type WorktreePolicyFsPort = {
  /** Failo tekstas arba `undefined`, kai failo nėra. */
  readTextFileIfExists(absolutePath: string): Promise<string | undefined>;
};

export async function loadWorktreePolicy(fs: WorktreePolicyFsPort, filePath: string): Promise<WorktreePolicy> {
  const raw = await fs.readTextFileIfExists(filePath);
  if (raw === undefined) return defaultWorktreePolicy;
  return parseWorktreePolicy(JSON.parse(raw) as unknown);
}

export function parseWorktreePolicy(raw: unknown): WorktreePolicy {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Invalid worktree policy: expected object.");
  }
  const record = raw as Record<string, unknown>;
  if (typeof record["enabled"] !== "boolean") {
    throw new Error("Invalid worktree policy: enabled must be boolean.");
  }
  return { enabled: record["enabled"] };
}
