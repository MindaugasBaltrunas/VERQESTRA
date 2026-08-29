## Žingsnis 0 — ar jau įgyvendinta?
Prieš keisdamas kodą patikrink, ar ## Tikslas ir ## Patikra jau tenkinami esamame kode.
Jei taip — NEDARYK jokių pakeitimų ir galutinę ataskaitą pradėk atskira eilute:
ALREADY_IMPLEMENTED: <failai/eilutės, įrodančios kad darbas jau padarytas>

## Sandbox taisyklės (privaloma — taupo turns)
- Po BET KOKIO `src` pakeitimo `dist` pasensta ir hook'ai blokuoja bash komandas. Pirma perbuild'ink TIKSLIA forma be pipe/redirect: `pnpm build`
- Patikroms naudok tik: `pnpm build` ir `pnpm test` (be `--`, be pipe į kitas komandas).
- `echo`, `sed`, `node -e` ir kompound komandos su neleistinais segmentais VISADA atmetamos — nekartok jų kitomis formomis; failams skaityti naudok Read/Grep tools.
- Rašymo darbą atlik PATS šioje sesijoje (Write/Edit) ir neatidėk jo vėlesniam laikui: headless sesija po paskutinio tavo žingsnio baigiasi, o bėgimas be nė vieno Write/Edit parkuojamas human-review. `## Agentai` grandinė yra orkestratoriaus maršruto metaduomuo — jei subagentas negrąžina rezultato šiame bėgime, įgyvendink pakeitimą tiesiogiai.

# Task

HUMAN-REVIEW-APPROVED: mindebaltru 2026-08-29 GeoGravity w1/w2 audito TOP-3 — 41 sunaikintas w2 slot'as dėl dviejų deterministinių bootstrap spragų (P0)

## Spec source
openspec/changes/verqestra-backlog-v1

## Žingsnis 0 — ar jau įgyvendinta?
Jei worktree runtime bootstrap: (a) `dist` kopijai atkuria/toleruoja
trūkstamą `.buildstamp` (arba jį kopijuoja kartu su dist) ir (b) deps
install kviečia pnpm absoliučiu keliu arba per `corepack`/process.execPath
šalia, o ne per plikas PATH — ALREADY_IMPLEMENTED su eilučių įrodymu.

## Tikslas
GeoGravity log auditas (2026-08-29, 38 h langas): **41 iš 44 `WAVE SLOT
FAILED` (93 %) yra dvi deterministinės bootstrap spragos**, nužudžiusios
w2 slot'us dar prieš jokį darbą:

1. **21 ×** `runtime bootstrap nepavyko: kopijuotas dist neturi
   .buildstamp (…/w2-…/dist/.buildstamp) — ENOENT … utime` — kopijos
   medyje `.buildstamp` nėra arba jo utime krenta.
2. **20 ×** `runtime bootstrap nepavyko: produkto deps install 'pnpm
   install --frozen-lockfile' kopijos medyje grąžino exit 127 (38
   šaknys)` — **exit 127 = komanda nerasta**: vaiko aplinkos PATH neturi
   pnpm.

Abi 100 % atkuriamos; kartu su tool-budget spraga (jau uždaryta 062) jos
paaiškina, kodėl w2 per 102 provizionavimus GeoGravity nesuintegravo NĖ
VIENO commit'o.

Taisymas:
- `.buildstamp`: bootstrap'as kopijuodamas dist kopijuoja ir
  `.buildstamp`; jei jo nėra šaltinyje — kuria kopijoje iš šaltinio dist
  mtime (bootstrap'as negali lūžti dėl žymos nebuvimo, kai pats dist
  pilnas). ENOENT ant utime — kurti failą, ne mesti.
- pnpm kelias: install kviečiamas absoliučiu keliu, išvestu iš tėvo
  proceso aplinkos (pvz. `process.env.npm_execpath` / pnpm vieta, kuria
  startavo orchestratorius), su aiškia klaida „pnpm nerastas: <kelias>"
  vietoj plikos 127.

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/infrastructure/git/worktrees/worktree-runtime.ts`
- `src/infrastructure/process/dist-freshness.ts` (TIK jei .buildstamp
  toleravimo taisyklė gyvena čia)
- `src/tests/infrastructure-worktree-runtime.test.ts` (numatomas; jei
  testas gyvena kitur — tas failas vietoje šio, įrašyti į ataskaitą)

Draudžiama:
- `src/application/**`
- `src/composition/**`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Architect: patvirtinti abiejų gedimų tikslų kodą `worktree-runtime.ts`
  ir pasirinkti pnpm kelio šaltinį (npm_execpath vs corepack shim).
- Tester: (a) šaltinio dist be .buildstamp → bootstrap sėkmingas, žyma
  sukurta kopijoje; (b) pnpm kelio nėra → klaida įvardija ieškotą kelią;
  (c) sėkmingas kelias nepakitęs.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios.

## Neįtraukta
tool-budget.json kopijavimas (062 — padaryta). Orphan valymas (079).
Vaikų stderr diagnostika (080).
