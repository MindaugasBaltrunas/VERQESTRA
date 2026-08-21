// Slaptukų aptikimo GRYNOSIOS taisyklės (etalonas: AG_loop hooks/secret-scan.ts pattern'ai
// 1:1). Failų rinkimas, gitignore filtras ir žurnalai — hook adapteryje; čia tik tekstas ir
// verdiktas.
//
// SELF-MATCH apsauga: env raktų literalai konstruojami su atskiru `=`, kad šis šaltinis (ir
// jo dist) pats nesimatchintų savo pattern'ui — kitaip kiekvienas šio failo pakeitimas
// blokuotų Stop hook'ą.

const envAssignment = (name: string): string => `${name}=`;

export type SecretPattern = { name: string; pattern: RegExp };

export const SECRET_PATTERNS: readonly SecretPattern[] = Object.freeze([
  // `\b` prieš "sk-" išvengia false positive nekaltuose identifikatoriuose (pvz.
  // "task-classification-policy" turi substring "sk-classification..."). Tikri raktai eina po
  // kabutės, tarpo, lygybės ar eilutės pradžios — ten `\b` yra.
  { name: "openai-api-key", pattern: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { name: "github-token", pattern: /ghp_[A-Za-z0-9_]{20,}/ },
  { name: "github-oauth-token", pattern: /gh[ousr]_[A-Za-z0-9_]{20,}/ },
  { name: "github-fine-grained-pat", pattern: /github_pat_[A-Za-z0-9_]{20,}/ },
  { name: "google-api-key", pattern: /AIza[A-Za-z0-9_-]{30,}/ },
  { name: "slack-bot-token", pattern: /xoxb-[A-Za-z0-9-]{20,}/ },
  { name: "aws-access-key", pattern: /AKIA[0-9A-Z]{16}/ },
  { name: "private-key", pattern: /BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY/ },
  { name: "database-url", pattern: new RegExp(envAssignment("DATABASE_URL")) },
  { name: "jwt-secret", pattern: new RegExp(envAssignment("JWT_SECRET")) },
  { name: "stripe-secret-key", pattern: new RegExp(envAssignment("STRIPE_SECRET_KEY")) },
]);

/** Vienos eilutės radinys: pirmas atitikęs pattern'as (eilutė gali turėti tik vieną kaltinimą). */
export function matchSecretPattern(line: string): SecretPattern | undefined {
  return SECRET_PATTERNS.find(({ pattern }) => pattern.test(line));
}

/**
 * Vieno failo turinio skenavimas. Radinio formatas `<file>:<line>:possible-secret:<name>` yra
 * kontraktas su `vq/logs/secret-scan.log` skaitytojais, tad keičiamas tik kartu su jais.
 */
export function findSecretsInText(filePath: string, content: string): string[] {
  const findings: string[] = [];
  content.split(/\r?\n/).forEach((line, index) => {
    const matched = matchSecretPattern(line);
    if (matched) findings.push(`${filePath}:${index + 1}:possible-secret:${matched.name}`);
  });
  return findings;
}
