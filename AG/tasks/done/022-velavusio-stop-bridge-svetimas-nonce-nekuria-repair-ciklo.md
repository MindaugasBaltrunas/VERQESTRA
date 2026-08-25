## Žingsnis 0 — ar jau įgyvendinta?
Prieš keisdamas kodą patikrink, ar ## Tikslas ir ## Patikra jau tenkinami esamame kode.
Jei taip — NEDARYK jokių pakeitimų ir galutinę ataskaitą pradėk atskira eilute:
ALREADY_IMPLEMENTED: <failai/eilutės, įrodančios kad darbas jau padarytas>

## Sandbox taisyklės (privaloma — taupo turns)
- Po BET KOKIO `src` pakeitimo `dist` pasensta ir hook'ai blokuoja bash komandas. Pirma perbuild'ink TIKSLIA forma be pipe/redirect: `pnpm build`
- Patikroms naudok tik: `pnpm build` ir `pnpm test` (be `--`, be pipe į kitas komandas).
- `echo`, `sed`, `node -e` ir kompound komandos su neleistinais segmentais VISADA atmetamos — nekartok jų kitomis formomis; failams skaityti naudok Read/Grep tools.

# Task

## Spec source
openspec/changes/verqestra-backlog-v1
docs/audits/020-session-writes-ledger-diagnosis-2026-08-25.md (R2 giminingas radinys)

## Tikslas
Įrodyti arba paneigti žurnalu, kad `DISPATCH STOP BRIDGE FOREIGN` yra to paties task'o ankstesnio bandymo vėlavęs Stop hook'as, ir užfiksuoti pasirinktą sprendimo kryptį diagnozės dokumente. Produkcinis kodas šioje dalyje NEkeičiamas.

## Agentai
Privaloma grandinė: readme-guard -> architect -> documenter

## Failai
Leidžiama:
- `docs/audits/022-stop-bridge-foreign-nonce-diagnosis-2026-08-25.md`

Draudžiama:
- `src/**`
- `.env`
- `.env.*`
- `node_modules/**`
- `dist/**`

## Veiksmas
- Surink įrodymus iš `vq/logs/orchestrator.log` visiems 4 FOREIGN įvykiams (2026-08-25 08:04:55 task=010, 08:35:09 task=012, 10:10:53 task=007, 19:20:43 task=021-d-05): ar bridge nonce priklauso TO PATIES task'o ankstesniam bandymui, ar svetimam task'ui; kiekvienam nurodyk log eilutę ir koreliaciją su human-review/error.
- Perskaityk nonce gyvavimo grandinę (`claude-dispatch-process.ts:126-127`, `slot-task-runner.ts:78`, `stop-bridge.ts:90-91`, `claude-dispatch-outcome.ts:131-140`) ir aprašyk tikslią seką, kuria vėlavęs įrašas praranda darbo įrodymą.
- Užrašyk pasirinktą kryptį (1: bridge praturtinamas task tapatybe; 2: neaktyvaus nonce bridge žymimas `stale`; 3: abi) su pagrindimu ir įrodymu, kad `stopStateSchema` lieka atgaliai suderinama seniems įrašams.

## Patikra
- `pnpm lint`
- `pnpm test:grep "stop bridge"`

## Stop
Commit'ink iš karto, kai patikros žalios. Sustok nedelsiant, jei žurnalas hipotezę PANEIGIA (nonce priklauso svetimam task'ui) — tada dokumente užrašyk paneigimą ir nesiūlyk kodo keitimo, laukdamas operatoriaus.

## Neįtraukta
- Bet koks `src/**` keitimas — jis eina sekančiais task'ais (write-side `stale`, read-side `foreign-done` skilimas, regresinis testas).
- `slot-task-runner.ts` nonce valymo kontrakto keitimas.
- R1/R2 darbai (uždaryti 020-a-02 ir 021 grandinėje).
