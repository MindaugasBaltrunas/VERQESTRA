// Worktree politikos PERJUNGIMO modulis dashboard'ui (be HTTP maršruto ir be UI, AG 088).
//
// Trys dalykai, kurie yra šio modulio kontraktas:
//
//   1. TIK `enabled` KEIČIASI. Konfigas skaitomas kaip generinis JSON objektas, o ne per domeno
//      schemą: kiti esami laukai (pvz. `root`, `branchPrefix`) keliauja per `{ ...raw }` spread'ą
//      nepaliesti, tad šis modulis niekada tyliai neatkuria to, ką 077 vėliau pašalins.
//   2. `.gitignore` LIEČIAMAS TIK ĮJUNGIANT IR TIK JEI ŠAKNIS DAR NEPADENGTA. Išjungimas failo
//      neskaito ir nerašo — „niekada" reiškia nė vieno efekto, ne efektą su tuščiu rezultatu.
//      Įjungimas prideda eilutę gale su komentaru; esamas turinys niekada nekeičiamas.
//   3. „PADENGTA" TURI VIENĄ APIBRĖŽIMĄ — `git check-ignore` (portas `rootIsIgnored`, už kurio
//      composition suriša TĄ PATĮ `worktreeRootIsIgnored`, kuriuo remiasi provisioning'as). Todėl
//      `gitignore_ok` yra MATUOJAMAS, o ne literalas: iki 112 jis grįždavo `true` besąlygiškai, ir
//      UI rodydavo „padengta" tada, kai provisioning'as krisdavo. Eilutės paieška faile liko tik
//      kaip RAŠYMO idempotencijos sargas ir tik PAŽODINĖ (žr. `hasLiteralWorktreeGitignoreLine`).

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
  /**
   * Ar git REALIAI ignoruoja worktree šaknį (`git check-ignore`), o ne ar faile yra panašiai
   * atrodanti eilutė. Portas, nes patikra gyvena `infrastructure`, o šis modulis — `interfaces`:
   * tiesa ateina per composition, ne per importą.
   */
  rootIsIgnored(projectRoot: string): Promise<boolean>;
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

/**
 * `ok` — MATUOTA `git check-ignore` tiesa po viso perjungimo; `status` — kas buvo padaryta su
 * failu. Du atskiri laukai sąmoningai: „nieko nerašėme" ir „padengta" yra skirtingi teiginiai, ir
 * būtent jų sulipdymas į vieną `true` buvo 112 klaida.
 */
type GitignoreOutcome = {
  ok: boolean;
  status: "ok" | "appended" | "literal-line-present" | "untouched";
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

/**
 * Ar PAŽODINĖ worktree eilutė jau yra faile. Lyginama BE `trim()`: git tarpus vertina pažodžiui,
 * tad ` .ag/worktrees/` (priekinis tarpas) yra kitas, nesuveikiantis šablonas — trim'as tokį failą
 * laikydavo padengtu, ir teisinga eilutė niekada nebūdavo pridėta. Nukerpamas tik `\r` (CRLF).
 */
function hasLiteralWorktreeGitignoreLine(content: string): boolean {
  return content.split("\n").some((line) => line.replace(/\r$/, "") === WORKTREE_GITIGNORE_LINE);
}

/** Prideda eilutę gale su komentaru; esamas turinys (įskaitant jo formatavimą) nekeičiamas. */
function appendWorktreeGitignoreLine(content: string): string {
  const withoutTrailingBlankLines = content.replace(/\n+$/, "");
  const prefix = withoutTrailingBlankLines.length > 0 ? `${withoutTrailingBlankLines}\n\n` : "";
  return `${prefix}${WORKTREE_GITIGNORE_COMMENT}\n${WORKTREE_GITIGNORE_LINE}\n`;
}

/**
 * Įjungimo šaka: pasirūpina, kad šaknis TIKRAI būtų ignoruojama, ir grąžina matuotą būseną.
 *
 * Rašoma tik tada, kai git šaknies neignoruoja IR pažodinės eilutės faile nėra. Antra sąlyga yra
 * sargas ne-git medžiui (ten `check-ignore` visada sako „ne"): be jos kiekvienas perjungimas dėtų
 * dar vieną tą pačią eilutę. Po įrašymo patikra KARTOJAMA — atsakymas apie failą, kurį ką tik
 * pakeitėme, negali remtis prieš tai matuota reikšme.
 */
async function ensureWorktreeRootIgnored(
  ports: WorktreePolicyPorts,
  projectRoot: string,
): Promise<GitignoreOutcome> {
  if (await ports.rootIsIgnored(projectRoot)) return { ok: true, status: "ok" };

  const gitignoreFile = path.join(projectRoot, ".gitignore");
  const current = (await ports.readGitignore(gitignoreFile)) ?? "";
  // Eilutė faile yra, bet git jos nemato: dubliuoti ją būtų beprasmiška, o meluoti apie dengimą —
  // žalinga. Grąžinamas sąžiningas `false` su įvardyta priežastimi žurnale.
  if (hasLiteralWorktreeGitignoreLine(current)) return { ok: false, status: "literal-line-present" };

  await ports.writeGitignore(gitignoreFile, appendWorktreeGitignoreLine(current));
  return { ok: await ports.rootIsIgnored(projectRoot), status: "appended" };
}

export async function setWorktreePolicyEnabled(
  ports: WorktreePolicyPorts,
  input: SetWorktreePolicyEnabledInput,
): Promise<SetWorktreePolicyEnabledResult> {
  const configFile = path.join(input.runtimeRoot, "config", "worktree-policy.json");
  const raw = parseRawConfig(await ports.readConfigFile(configFile));
  const updated = { ...raw, enabled: input.enabled };
  await ports.writeConfigFile(configFile, `${JSON.stringify(updated, null, 2)}\n`);

  // Išjungiant `.gitignore` NELIEČIAMAS: nei skaitomas, nei rašomas per šio modulio failų portus.
  // `rootIsIgnored` tai nepažeidžia — tai read-only klausimas git'ui apie repozitorijos būseną, be
  // jokio efekto failui. `gitignore_ok` ir čia atsako į TĄ PATĮ klausimą („ar šaknis padengta"), o
  // ne į „ar ką tik ką nors padarėme": literalas `true` išjungiant būtų lygiai tas pats melas, kurį
  // taiso 112, ir operatorius po išjungimo/įjungimo poros gautų du skirtingus atsakymus apie tą
  // pačią nepakitusią repozitoriją.
  const gitignore = input.enabled
    ? await ensureWorktreeRootIgnored(ports, input.projectRoot)
    : { ok: await ports.rootIsIgnored(input.projectRoot), status: "untouched" as const };

  ports.log(
    `WORKTREE POLICY: enabled=${input.enabled} gitignore=${gitignore.status} ignored=${gitignore.ok}`,
  );
  return { enabled: input.enabled, gitignore_ok: gitignore.ok };
}
