// Human-review gate EVIDENCE detectors: eight per-category keyword/path rules. Behaviour
// etalon: AG_loop domain/tasks/human-review.ts (all regex history and false-positive
// annotations preserved — every pattern here was tuned by a production incident).
// Pure: (normalized text, normalized paths) in, evidence strings out.

export function dependencyEvidence(text: string, paths: string[]): string[] {
  const evidence: string[] = [];
  const dependencyPaths = paths.filter((file) =>
    /(^|\/)package\.json$|(^|\/)pnpm-lock\.yaml$|(^|\/)package-lock\.json$|(^|\/)yarn\.lock$|(^|\/)bun\.lockb?$|(^|\/)requirements\.txt$|(^|\/)pyproject\.toml$|(^|\/)poetry\.lock$|(^|\/)pipfile$|(^|\/)composer\.json$|(^|\/)composer\.lock$|\.csproj$|(^|\/)directory\.packages\.props$/.test(
      file,
    ),
  );
  evidence.push(...dependencyPaths.map((file) => `path:${file}`));
  // (?!-\w): hyphenated junginiai („dependency-boundary check") yra architektūros kalba,
  // ne paketų valdymas — 883 false positive 2026-07-03.
  if (/\b(add|install|upgrade|bump|remove|replace)\b.{0,40}\b(dependency|package|library|npm|pnpm|pip|composer|nuget)\b(?!-\w)/.test(text)) {
    evidence.push("text:dependency-change");
  }
  return evidence;
}

export function databaseEvidence(text: string, paths: string[]): string[] {
  const evidence: string[] = [];
  const dbPaths = paths.filter((file) =>
    /migrations?\/|(^|\/)prisma\/|schema\.prisma$|(^|\/)db\/|(^|\/)database\/|\.sql$|(^|\/)alembic\//.test(file),
  );
  evidence.push(...dbPaths.map((file) => `path:${file}`));
  // migration/migrate signalizuoja tik su DB kontekstu šalia (862/864 false positive).
  if (
    /\b(database|db schema|schema\.prisma|alembic|knex|typeorm|prisma)\b/.test(text) ||
    /\b(?:db|database|data|schema|sql)[\s-]+migrations?\b/.test(text) ||
    /\bmigrations?[\s-]+(?:sql|scripts?|schemas?|tables?)\b/.test(text) ||
    /\bmigrate\s+(?:db|database|data|schemas?|tables?)\b/.test(text)
  ) {
    evidence.push("text:database-change");
  }
  return evidence;
}

export function securityEvidence(text: string, paths: string[]): string[] {
  const evidence: string[] = [];
  // Bare `session` pašalintas: realias auth sesijas dengia auth|oauth|jwt path segmentai,
  // o tekste `session` signalizuoja tik su auth kontekstu (GeoGravity 2026-07 regresija).
  const securityPaths = paths.filter((file) =>
    /auth|security|permission|permissions|acl|rbac|secret|secrets|encrypt|encryption|crypto|oauth|jwt|password|payment/.test(file),
  );
  evidence.push(...securityPaths.map((file) => `path:${file}`));
  if (
    /\b(auth|authentication|authorization|permission|permissions|rbac|secret|secrets|encrypt|encryption|crypto|oauth|jwt|password|payment|payments)\b/.test(text) ||
    /\b(?:auth|login|user)[\s-]+sessions?\b/.test(text) ||
    /\bsessions?[\s-]+(?:tokens?|cookies?|expiry|expiration|hijack\w*|fixation|storage)\b/.test(text)
  ) {
    evidence.push("text:security-sensitive-change");
  }
  return evidence;
}

export function deployEvidence(text: string, paths: string[]): string[] {
  const evidence: string[] = [];
  // Plikas `release` substring gaudė lokalius readiness įrankius (861 false positive) —
  // deploy rizika iš release pusės: releases/ katalogas arba semantic-release konfigai.
  const deployPaths = paths.filter((file) =>
    /(^|\/)\.github\/workflows\/|deploy|deployment|(^|\/)releases?\/|\.releaserc|release\.config\.|helm|k8s|kubernetes|terraform|pulumi|cloudformation|docker-compose\.prod/.test(
      file,
    ),
  );
  evidence.push(...deployPaths.map((file) => `path:${file}`));
  if (/\b(production deploy|deploy to prod|deployment|release automation|terraform apply|kubectl apply|helm upgrade)\b/.test(text)) {
    evidence.push("text:deploy-risk");
  }
  return evidence;
}

export function destructiveDataEvidence(text: string, paths: string[]): string[] {
  const evidence: string[] = [];
  if (/\b(drop table|truncate|delete from\s+\w+\s*;|delete all|wipe data|purge data|destroy data|destructive migration)\b/.test(text)) {
    evidence.push("text:destructive-data-operation");
  }
  if (paths.some((file) => /seed|cleanup|purge|delete|truncate|drop/.test(file) && /db|data|migration|sql/.test(file))) {
    evidence.push("path:destructive-data-candidate");
  }
  return evidence;
}

export function billingEvidence(text: string, paths: string[]): string[] {
  const evidence: string[] = [];
  // Tik commerce-specifiniai path segmentai (buvęs \bplan\b gaudė test-plan.md — 856-02).
  const billingPaths = paths.filter((file) => /billing|invoice|subscription|stripe|checkout|pricing/.test(file));
  evidence.push(...billingPaths.map((file) => `path:${file}`));
  // "checkout" be `git ` priešakyje (VCS komanda — task 890 fp); "subscription" tik
  // commerce frazėse (RxJS/SSE subscription — programavimo terminas).
  if (
    /\b(billing|invoice|stripe|pricing|charge customer|refund)\b/.test(text) ||
    /(?<!git )\bcheckout\b/.test(text) ||
    /\b(?:paid|billing|premium|monthly|annual|customer|pricing)\s+subscriptions?\b/.test(text) ||
    /\bsubscriptions?\s+(?:plans?|tiers?|billing|prices?|pricing|fees?|payments?|renewals?)\b/.test(text) ||
    /\b(?:cancel|renew|upgrade|downgrade)\s+(?:an?\s+|the\s+)?(?:user\s+|customer\s+)?subscriptions?\b/.test(text)
  ) {
    evidence.push("text:billing-change");
  }
  return evidence;
}

export function outboundCommunicationEvidence(text: string, paths: string[]): string[] {
  const evidence: string[] = [];
  const outboundPaths = paths.filter((file) => /email|mailer|notification|sms|push|webhook|newsletter/.test(file));
  evidence.push(...outboundPaths.map((file) => `path:${file}`));
  if (/\b(send email|email users|sms|push notification|notify users|newsletter|outbound message|webhook to users)\b/.test(text)) {
    evidence.push("text:outbound-communication");
  }
  return evidence;
}

export function learningPolicyEvidence(text: string, paths: string[]): string[] {
  const evidence: string[] = [];
  // NEtaikom laisvo `policy` substring path'e — jis gaudė sprendimų-politikos sluoksnį,
  // kuris nėra learning-memory (task 854 false positive). Learning keliai visada turi
  // learning/memory/recommendation segmentą po ag/ šaknimi.
  const learningPaths = paths.filter((file) => /learning|memory|recommendation/.test(file) && file.startsWith("ag/"));
  evidence.push(...learningPaths.map((file) => `path:${file}`));
  if (/\b(learning memory|memory policy|policy recommendation|auto-apply policy|change policy)\b/.test(text)) {
    evidence.push("text:learning-policy-change");
  }
  return evidence;
}
