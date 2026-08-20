// Grynos rollback taisyklės (etalonas: AG_loop orchestrator/git/rollback-scope.ts grynoji
// pusė, task 890). Faktų surinkimas prieš realų repo — infrastructure/git/rollback-scope.

export type PushedRollbackFacts = {
  head?: string;
  stableRef: string;
  branch: string;
  upstreamExists: boolean;
  totalCommitsSince: number;
  unpushedCommitsSince: number;
};

export type PushedRollbackDecision = { blocked: boolean; detail?: string };

/**
 * Grynas sprendimas: ar rollback iki `stableRef` paliestų commit'us, jau publikuotus
 * remote? Blokuoja, kai bent vienas `stableRef..HEAD` commit'as yra upstream'e
 * (`totalCommitsSince > unpushedCommitsSince`) — jau push'intas task commit'as niekada
 * neperrašomas. Be commit'intų pakeitimų nuo stable (`head === stableRef`, arba nėra
 * šakos/upstream) push'into darbo būti negali — niekada neblokuojama.
 */
export function pushedRollbackBlock(facts: PushedRollbackFacts): PushedRollbackDecision {
  if (!facts.head || facts.head === facts.stableRef) return { blocked: false };
  if (!facts.branch || !facts.upstreamExists) return { blocked: false };
  const pushed = facts.totalCommitsSince - facts.unpushedCommitsSince;
  if (facts.totalCommitsSince > 0 && pushed > 0) {
    return {
      blocked: true,
      detail: `${pushed}/${facts.totalCommitsSince} commit(s) since stable-ref already pushed to origin/${facts.branch}`,
    };
  }
  return { blocked: false };
}

export function isCommitSha(value: string): boolean {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value);
}
