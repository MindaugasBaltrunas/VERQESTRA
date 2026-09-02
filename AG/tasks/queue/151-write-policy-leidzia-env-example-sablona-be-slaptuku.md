# Task

HUMAN-REVIEW-APPROVED: operatorius 2026-09-02 „aš visus tasks approve" (security vartai: .env ir slaptukų taisyklė)

## Spec source
openspec/changes/verqestra-backlog-v1/

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/domain/policies/write-policy.ts` prie `BLOCKED_ENV_FILE_PATTERN` (šiandien
21 eil.) turi aiškią išimtį `.env.example` basename'ui (grep `example` faile) IR
`src/tests/domain-write-policy.test.ts` turi atvejį, kad `evaluateWritePolicy(".env.example")`
grąžina `undefined`, o `.env`, `.env.local`, `config/.env.development` toliau
blokuojami — ALREADY_IMPLEMENTED: cituok išimties eilutę ir testą.

## Tikslas
Įrodymas (GeoGravity queue 1266 `infra_env_example_and_local_dev_docs`, 2026-09-02):
užduotis prašo sukurti `.env.example` su placeholder'iais (`JWT_SECRET=change-me-min-32-chars`),
kad kiekvienas `process.env['X']` kode turėtų dokumentuotą pavyzdį. Bet
`write-policy.ts:21` `BLOCKED_ENV_FILE_PATTERN = /^\.env(\..+)?$/i` blokuoja BET KOKĮ
`.env.<sufiksas>` basename'ą, taigi ir `.env.example`, o `evaluateWritePolicy`
(`:178-180`) grąžina „saugomas failas (env/secrets)" dar prieš turinio patikrą.
Rezultatas: Claude negali parašyti failo, bėgimas baigiasi be Write ir parkuojamas
human-review — taisyklė, sukurta slaptukams saugoti, blokuoja failą, kuris pagal
apibrėžimą slaptukų neturi ir yra industrijos standartas (`cp .env.example .env`).

Sprendimo kryptis: siaura, aiškiai įvardinta išimtis — basename `.env.example`
(case-insensitive, bet kuriame kataloge) praleidžiamas pro env patikrą. Visi kiti
`.env*` variantai lieka blokuojami. Turinio saugumą užtikrina esamas Stop hook'o
secret scan (`hooks.log`: „Secret scan ✅ — pakeistuose failuose slaptukų nerasta"),
tad išimtis nesukuria kelio realiam slaptukui patekti į repo be patikros.

Atmesta alternatyva: leisti `.env.*` su `example|sample|template` sufiksais
apskritai. Kiekvienas papildomas šablonas yra papildomas kelias, kurį reikia
pagrįsti; kol realaus poreikio yra tik `.env.example`, sąrašas lieka vieno įrašo.

## Agentai
readme-guard -> coder -> reviewer -> security -> tester

## Failai
Leidžiama:
- `src/domain/policies/write-policy.ts` (išimtis prieš BLOCKED_ENV_FILE_PATTERN patikrą)
- `src/tests/domain-write-policy.test.ts` (egzistuoja — env atvejai 55-57 eil.)

Draudžiama:
- `src/domain/policies/bash-command-policy.ts` (bash allowlist'as nekinta — `.env` skaitymo/rašymo per shell čia nesprendžiama)
- `src/interfaces/hooks/**` (hook adapteriai nekinta — taisyklė gyvena domain'e)
- `dist/**`
- `node_modules/**`

## Veiksmas
- `write-policy.ts`: eksportuota konstanta (pvz. `ALLOWED_ENV_TEMPLATE_BASENAMES = [".env.example"]`)
  su komentaru KODĖL (šablonas be slaptukų; turinį tikrina Stop secret scan); patikra
  `:178` praleidžia basename'ą, jei jis sąraše (lyginimas lowercase, kaip `BLOCKED_FILES`).
- Testų lūkestis (`domain-write-policy.test.ts`): (1) `.env.example` → `undefined`;
  (2) `config/.env.example` → `undefined`; (3) `.ENV.EXAMPLE` → `undefined` (case);
  (4) `.env`, `.env.local`, `.env.example.local`, `config/.env.development` → `saugomas failas`
  kaip iki šiol; (5) `.env.example.pem` → blokuojama per plėtinį (išimtis neapeina
  BLOCKED_EXTENSIONS).
- Security perspektyva ataskaitoje: patvirtinti, kad išimtis nepraleidžia jokio kelio
  su `..`, `node_modules/`, `.git/` — tos patikros eina PO env patikros ir lieka galioti.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei Stop hook'o secret scan
neskenuoja naujų (untracked) failų — tada išimtis atvertų nepatikrintą kelią ir
prieš ją reikia scan'o praplėtimo atskiru task'u.

## Neįtraukta
- `.env.sample` / `.env.template` variantai — nėra realaus poreikio; pridedami tik su
  pagrindimu.
- Bash allowlist'o keitimas `cp .env.example .env` tipo komandoms — operatoriaus veiksmas
  per `!`, ne agento.
- GeoGravity 1266 perrašymas — nebereikalingas po šio task'o; užduotis lieka eilėje
  su `.env.example` keliu.
