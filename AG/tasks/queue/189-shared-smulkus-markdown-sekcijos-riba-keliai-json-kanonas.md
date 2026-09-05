# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Žingsnis 0 — ar jau įgyvendinta?
Tikrinti po punktą: (1) `src/shared/markdown.ts` `extractSection` sekcijos pabaigą (127 eil.) randa
per trim'intą eilutę, kaip pradžią (90 eil.); (2) `src/shared/paths.ts:95` `..foo` šaknyje NElaikomas
„escapes project root"; (3) `paths.ts:40-53` `normalizeProjectPath("./proj", "./proj/a.ts")` grąžina
`a.ts`; (4) `src/shared/json.ts` doc'as sako tiesą apie `Date`/`Map`/`Set`/`toJSON` arba kodas juos
serializuoja kaip `JSON.stringify`. Visi — ALREADY_IMPLEMENTED su citatomis; kitaip daromi likę.

## Tikslas
Pilnas auditas 2026-09-05 (`docs/audits/full-audit-2026-09-05.md`, P2 Domain „markdown.ts:90 vs 127";
`audit-domain.md` #24-#27).
- #24 `markdown.ts:90 vs 127` `extractSection` antraštę randa per `line.trim() === heading`, o pabaigą
  per `^#{1,6}\s` BE trim: įtraukta `  ## Patikra` pradeda sekciją, bet įtraukta `  ## Stop` jos
  neužbaigia → `## Patikra` turinys prisiima svetimą sekciją. Kryptis: abi pusės trim'intos.
  `src/tests/markdown-readers-real-corpus.test.ts` (korpusas) privalo likti žalias — jei kuris
  korpuso failas dėl to keičia sekcijų ribas, tai įrodymas, ne regresija; įrašyti ataskaitoje.
- #25 `paths.ts:95` `relative.startsWith("..")` → failas `..foo` šaknyje = „escapes project root";
  teisinga sąlyga: `relative === ".." || relative.startsWith("../")` (POSIX forma po normalizavimo).
- #26 PLAUSIBLE `paths.ts:40-53` `normalizedRoot` (su `./`) ilgis ≠ `comparableRoot` (be `./`):
  `normalizeProjectPath("./proj","./proj/a.ts")` → `"ts"`. Visi kvietėjai paduoda absoliučią šaknį,
  tad nepasiekiama šiandien — pradėti nuo testo; jei žalias, punktas ALREADY_IMPLEMENTED.
- #27 `json.ts:38-41,72-79` doc „exactly like JSON.stringify", bet `Date`/`Map`/`Set`/`toJSON`
  objektai virsta `{}` tyliai. Kryptis: kviesti `toJSON`, kai jis yra (kaip `JSON.stringify`), ir
  doc'e įvardyti `Map`/`Set` (`{}` — sutampa su `JSON.stringify`). Hash'ų stabilumas: kanoninio
  rezultato pokytis paveiktų tik įėjimus su `Date`/`toJSON` — Grep'u patikrinti, ar kuris
  `canonicalJsonStringify` kvietėjas tokius paduoda (`route-model.ts:181` politika — gryni objektai).

## Agentai
readme-guard -> debugger -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/shared/markdown.ts` (`extractSection` 90/127 eil.)
- `src/shared/paths.ts` (40-53, 95 eil.)
- `src/shared/json.ts` (38-41, 72-79 eil.)
- `src/tests/shared-markdown.test.ts`
- `src/tests/markdown-section-bounds.test.ts`
- `src/tests/shared-paths.test.ts`
- `src/tests/characterization-shared-primitives.test.ts`

Draudžiama:
- `src/shared/lock-steal.ts` ir `src/shared/owned-lock.ts` (task 182)
- `src/tests/markdown-readers-real-corpus.test.ts` (korpuso vartas — skaitomas, nekeičiamas)
- `src/domain/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `markdown.ts`: pabaigos sąlyga per `line.trim()`; `findSectionBounds` — ta pati taisyklė, jei ji
  turi savo kopiją. Testai `shared-markdown.test.ts`/`markdown-section-bounds.test.ts`: įtraukta
  `  ## Stop` užbaigia `## Patikra`; fenced `## X` neužbaigia (esamas elgesys).
- `paths.ts`: `..foo` šaknyje → normalus kelias; `../x` → escape; `..` → escape. #26 testas su
  `./proj` šaknimi; jei raudonas — `comparableRoot`/`normalizedRoot` ilgį skaičiuoti nuo tos pačios
  formos.
- `json.ts`: `toJSON` palaikymas; testai `characterization-shared-primitives.test.ts` — `Date` duoda
  ISO string'ą kaip `JSON.stringify`; esami hash charakterizacijos atvejai (gryni objektai) nekinta.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei `canonicalJsonStringify` kvietėjų Grep'as
randa `Date`/`toJSON` įėjimą, kurio hash'as persistuojamas (kešo raktas, wave decision hash) — tada
pokytis reikalauja versijos kėlimo svetimame scope.

## Neįtraukta
- `shared/lock-steal.ts`/`owned-lock.ts` — task 182.
- `domain/tasks/etalonas-rules.ts` sekcijų parseris (`enumerateTaskSections`) — task 181, jei jį
  paveiks `extractSection` pokytis, tai matysis korpuso teste.
- `shared/result.ts`, `errors.ts`, `hash.ts`, `ids.ts`, `numbers.ts`, `schema.ts`, `exit-codes.ts` —
  auditas: švaru.
