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
openspec/changes/verqestra-backlog-v1 — tasks.md eilutė „Automatizuoti project status ir converge perleidimą po kiekvieno commit'o su telemetry įrašu". Tai 1 dalis iš 2 (wiring — atskiras task'as).

## Tikslas
Sukurti application sluoksnio use-case `runCommitConvergence`, kuris po commit'o per portus perleidžia project status ir converge patikrą ir grąžina telemetry įrašą. Jokio IO pačiame use-case'e.

## Agentai
Privaloma grandinė: readme-guard -> coder -> reviewer

## Failai
Leidžiama:
- `src/application/release-readiness/commit-convergence.ts`
- `src/application/release-readiness/index.ts`
- `src/tests/converge-readiness-backlog.test.ts`

Draudžiama:
- `src/composition/**`
- `src/infrastructure/**`
- `.env`
- `.env.*`
- `node_modules/**`
- `dist/**`

## Veiksmas
- Parašyti `commit-convergence.ts`: `CommitConvergencePorts` (project status perleidimas, converge paleidimas, telemetry įrašo rašymas, laikrodis) ir `runCommitConvergence(ports, input)`, grąžinantis `{ status, converge, telemetry }`; jokių `node:` importų, ≤500 eilučių, `exactOptionalPropertyTypes` stiliumi (opcionalūs laukai per sąlyginius spread'us).
- Prijungti eksportus prie `src/application/release-readiness/index.ts` šalia esamo `converge-check` eksporto.
- Padengti `src/tests/converge-readiness-backlog.test.ts` fake portais: sėkmingas perleidimas, nesuartėjęs converge (telemetry vis tiek rašomas), telemetry įrašo formos patikra.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink iš karto, kai abi patikros žalios — necommit'intas darbas jau kartą buvo prarastas. Sustok po commit'o; composition wiring į šį task'ą NEĮEINA.

## Neįtraukta
- `src/composition/quality/**` adapteriai ir Stop hook wiring (atskiras task'as).
- Realus failų rašymas ar git kvietimai.
- LLM kvietimai, queue loop vykdymas, MCP/vector DB integracijos.
