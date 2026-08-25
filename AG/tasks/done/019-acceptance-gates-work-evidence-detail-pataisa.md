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
AG/openspec/changes/verqestra-backlog-v1/tasks.md

## Tikslas
P2 kosmetika (2026-08-25 optimizavimo auditas): `evaluateAcceptance`
(`src/domain/metrics/acceptance-gates.ts`) `work_evidence` vartas visada rašo
`detail: "no dispatch usage recorded"` — net kai vartas PRAĖJO. Ataskaitos
skaitytojui praėjęs vartas atrodo kaip radinys. Detail tekstas turi priklausyti nuo
`passed` (pvz. `N dispatch attempt(s) recorded` kai praėjo). Elgesio (accepted
verdikto) nekeisti — keičiasi tik žmogui skirtas tekstas.

## Agentai
readme-guard -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/domain/metrics/acceptance-gates.ts`
- `src/tests/**`

Draudžiama:
- `.env`
- `.env.*`
- `node_modules/**`
- `dist/**`

## Dependencies
depends_on: none

## Veiksmas
- `work_evidence` gate `detail` formuoti pagal `passed` ir `dispatch_attempts` reikšmę.
- Patikrinti, ar joks skaitytojas neparsina šios detail eilutės kaip kontrakto (grep per src ir testus); jei parsina — nekeisti be atskiro sprendimo ir sustoti.
- Testai: praėjusio ir kritusio varto detail tekstai skiriasi ir teisingi.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Sustoti, kai patikros praeina; accepted verdiktas nepakitęs.

## Neįtraukta
- Kiti acceptance vartai ir jų taisyklės.
- Benchmark totals/comparison logika (task 018).
- Queue loop vykdymas.
