## Žingsnis 0 — ar jau įgyvendinta?
Prieš keisdamas kodą patikrink, ar ## Tikslas ir ## Patikra jau tenkinami esamame kode; jei taip — NEDARYK jokių pakeitimų ir galutinę ataskaitą pradėk atskira eilute:
ALREADY_IMPLEMENTED: <failai/eilutės, įrodančios kad darbas jau padarytas>
Jei task'as yra auditas/patikra, užbaigta be keistinų radinių — ataskaitą pradėk atskira eilute:
AUDIT_COMPLETE: <ką patikrinai ir kodėl keisti nieko nereikia>

## Sandbox taisyklės (privaloma — taupo turns)
- Po BET KOKIO `src` pakeitimo `dist` pasensta ir hook'ai blokuoja bash komandas. Pirma perbuild'ink TIKSLIA forma be pipe/redirect: `pnpm build`
- Patikroms naudok tik: `pnpm build` ir `pnpm test` (be `--`, be pipe į kitas komandas).
- `echo`, `sed`, `node -e` ir kompound komandos su neleistinais segmentais VISADA atmetamos — nekartok jų kitomis formomis; failams skaityti naudok Read/Grep tools.
- Rašymo darbą atlik PATS šioje sesijoje (Write/Edit) ir neatidėk jo vėlesniam laikui: headless sesija po paskutinio tavo žingsnio baigiasi, o bėgimas be nė vieno Write/Edit parkuojamas human-review — NEBENT ataskaita prasideda sąžiningu ALREADY_IMPLEMENTED arba AUDIT_COMPLETE markeriu su įrodymais (žr. Žingsnį 0). `## Agentai` grandinė yra orkestratoriaus maršruto metaduomuo — jei subagentas negrąžina rezultato šiame bėgime, įgyvendink pakeitimą tiesiogiai.

# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/interfaces/http/ui-lifecycle.ts` `ensureUiRunning` `already-running` šakoje lygina
serverio įrašo laiką su `dist/.buildstamp` ir rašo `UI SERVES STALE DIST` eilutę — ALREADY_IMPLEMENTED:
cituok palyginimą ir log eilutę.

## Tikslas
Sveikatos patikra `docs/audits/ui-app-overview-2026-09-02.md` §2026-09-03: UI serveris (pid 26376)
startavo 10:25 su tuometiniu `dist/`; iki 22:35 `dist/.buildstamp` perrašytas kelis kartus
(142-B, 154 — `src/application/analytics` kohortų pataisa). Node kodo neperkrauna, tad gyvas API
vykdo 10:25 versiją: 154 pataisa dashboard'o kohortų puslapyje neveikia, nors merge'as `done`.
Ciklas per dieną perstartuotas tris kartus (14:15, 17:03, 22:24) ir kiekvieną kartą autostart'as
(`commands-ops.ts:261` → `ensureUiRunning` → `resolveUiPort` `already-running`,
`ui-port-store.ts:304-311`) esamą serverį pripažino be jokio klausimo apie jo amžių. Bundle'ui
staleness'as jau matuojamas (`bundleStalenessFields`); serverio KODUI — ne. Pirmas žingsnis —
ĮVARDYTI, ne restartuoti: restartas nutrauktų operatoriaus SSE sesiją ir yra atskiras sprendimas.

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/interfaces/http/ui-lifecycle.ts` (`ensureUiRunning` `already-running` šaka)
- `src/interfaces/http/ui-port-store.ts` (`already-running` rezultatas neša įrašo `updated_at`/`pid`, 304-311 eil.)
- `src/composition/ui/lifecycle-adapters.ts` (portas `readBuildStamp` virš `dist-freshness.ts` `buildStampPath`)
- `src/tests/composition-ui-autostart.test.ts`
- `src/tests/interfaces-http-ui-lifecycle-stale.test.ts` (numatomas naujas)

Draudžiama:
- `src/infrastructure/process/dist-freshness.ts` (importuojamas, nekeičiamas)
- `src/composition/cli/commands-ops.ts` (kvietėjas nekinta — sprendimas gyvena `ensureUiRunning`)
- `src/interfaces/http/ui-dashboard-view.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `ui-port-store.ts`: `already-running` rezultatas papildomas neprivalomu `record?: { pid, updated_at }`
  iš `readUiServerRecord` (kai rastas per persistuotą įrašą; per override/derived — be įrašo).
- `lifecycle-adapters.ts`: portas `readBuildStamp(): Promise<string | undefined>` — `dist/.buildstamp`
  turinys (ISO), trūkstamas → `undefined`.
- `ui-lifecycle.ts` `ensureUiRunning`: `already-running` su įrašu ir stamp'u → jei
  `buildstamp > updated_at`, rašyti `UI SERVES STALE DIST: pid=… started=… buildstamp=… — restart
  the UI (or POST /api/ui/rebuild does NOT reload server code)` į `io`/orchestrator log per esamą
  log portą; be įrašo ar stamp'o — tyla (nežinia nėra pasenimas). Elgsena (serveris paliekamas)
  nekinta.
- Testai: stamp'as naujesnis → eilutė; senesnis/lygus → nėra; trūkstamas stamp'as ar įrašas →
  nėra; `available` kelias nepaliestas (esami `composition-ui-autostart` testai žali).

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei `already-running` rezultato praplėtimas
lūžtų `UiPortResolution` kontrakto vartotojams UI pusėje (`ui-command`, `verqestra ui`) — tada
laukas dedamas kaip atskiras skaitymas `ensureUiRunning` viduje, ne į rezoliuciją.

## Neįtraukta
- Automatinis UI restartas, kai dist pasenęs — operatoriaus politika po šio signalo duomenų.
- Dashboard'o kortelė „serverio kodas pasenęs" (`ui-dashboard-view.ts`) — antras žingsnis po log'o.
- Bundle'o perstatymas po ui-app merge'o — task 161.
