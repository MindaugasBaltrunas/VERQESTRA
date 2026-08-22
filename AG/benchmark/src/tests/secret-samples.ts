/**
 * Synthetic credentials for the redaction tests.
 *
 * Every value is assembled from parts instead of being written out, so no line
 * of this repository ever holds a complete token-shaped literal. That is not
 * cosmetic. The Stop-hook secret scan is line-based and deliberately has no
 * "this one is fine" annotation, because a scanner that can be annotated away is
 * a scanner that eventually is; `src/interfaces/hooks/secret-scan.ts`
 * composes its own patterns for exactly the same reason.
 *
 * The assembled values have the exact shape the redaction rules match, so the
 * tests prove what they would have proved with the literals in place.
 */
function compose(...parts: readonly string[]): string {
  return parts.join("");
}

export const SYNTHETIC_SECRETS = {
  anthropicApiKey: compose("sk-", "ant-api03-AbCdEfGhIjKlMnOpQrStUv"),
  openaiApiKey: compose("sk-", "1234567890abcdefghij"),
  githubToken: compose("ghp", "_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"),
  githubFineGrainedPat: compose("github", "_pat_11ABCDEFG0abcdefghijkl_MNOPQRSTUVWX"),
  slackBotToken: compose("xoxb", "-123456789012-abcdefghij"),
  awsAccessKeyId: compose("AKIA", "IOSFODNN7EXAMPLE"),
  googleApiKey: compose("AIza", "SyA1234567890abcdefghijklmnopqrst"),
  jsonWebToken: compose(
    "eyJhbGciOiJIUzI1NiJ9.",
    "eyJzdWIiOiIxIn0.",
    "dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk",
  ),
} as const;

/** A private key block, split across the marker the scanner matches. */
export const SYNTHETIC_PRIVATE_KEY = compose(
  "-----BEGIN RSA ",
  "PRIVATE KEY-----\nMIIEow==\n-----END RSA PRIVATE KEY-----",
);

/** A second GitHub token, for asserting that every occurrence is redacted. */
export function anotherGithubToken(filler: string): string {
  return compose("ghp", "_", filler.repeat(30));
}
