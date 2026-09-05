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
Jei `src/interfaces/cli/dispatch/dispatch.ts` `--adapter` reikšmę ima per
`flagValue(args, "--adapter")` iš `../spec/flag-value.js` (ne per `startsWith("--adapter=")`),
o task failas parenkamas praleidžiant flag'ų reikšmes; `codex-dispatch.ts` nebeturi savo
`flagValue` kopijos; `retry-guard.ts` `--task-id=<id>` inline formą priima; `on-stop-bridge.ts` be
`args[0]` grąžina 2 su usage — ALREADY_IMPLEMENTED: cituok kiekvieno failo eilutes ir testus
`src/tests/interfaces-cli-dispatch.test.ts`.

## Tikslas
Pilnas auditas, `docs/audits/full-audit-2026-09-05.md` P1-C3 ir P2 CLI (2026-09-05), pilna
ataskaita `audit-cli.md` F4, F14, F15, F17:
- `dispatch.ts:55` parsina TIK `--adapter=<kind>`; registras `commands-ops.ts:372` ir
  `README.md:199` rodo `--adapter <kind>`. `verqestra dispatch task.md --adapter codex` →
  `requestedAdapter="dry-run"` tyliai; `verqestra dispatch --adapter codex task.md` →
  `taskFile="codex"` (:43 ima pirmą ne-`--` token'ą, kuris yra flag'o reikšmė).
- `codex-dispatch.ts:43` tas pats: `--adapter codex 123` → `taskId="codex"`; :69 turi
  savo `flagValue` kopiją, nors `spec/flag-value.ts` jau yra bendras modulis abiem formoms.
- `retry-guard.ts:50-56` `argValue` priima tik tarpo formą — `--task-id=<id>` tyliai
  ignoruojamas.
- `on-stop-bridge.ts:21-26` be argumentų rašo `status="unknown"` ir grąžina 0; registras
  (`commands-ops.ts:414`) ir README skelbia `<status>` privalomą.
Bendra priežastis: keturi skirtingi flag parseriai `interfaces/cli` scope'e. Šis task'as
suvienodina `dispatch/` katalogo komandas per bendrą `flag-value.ts`; likę parseriai
(`claude-dispatch/dispatch-invocation.ts`, `task-generate.ts`) — task 216.

## Agentai
readme-guard -> debugger -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/interfaces/cli/dispatch/dispatch.ts`
- `src/interfaces/cli/dispatch/codex-dispatch.ts`
- `src/interfaces/cli/dispatch/retry-guard.ts`
- `src/interfaces/cli/dispatch/on-stop-bridge.ts`
- `src/tests/interfaces-cli-dispatch.test.ts`

Draudžiama:
- `src/interfaces/cli/spec/flag-value.ts` (importuojamas, nekeičiamas)
- `src/interfaces/cli/dispatch/claude-dispatch/dispatch-invocation.ts` (task 216)
- `src/composition/cli/commands-ops.ts` (usage eilutės — drift task'as 217)
- `README.md`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Bendra pagalbinė funkcija (vietoje `dispatch.ts` arba `flag-value.ts` KAIMYNYSTĖJE — bet
  `flag-value.ts` nekeičiamas): `positionalArgs(args, valueFlags)` — token'ai be `--`, kurie
  nėra išvardytų flag'ų reikšmės; naudojama `dispatch.ts` ir `codex-dispatch.ts`.
- `dispatch.ts`: `requestedAdapter = flagValue(args, "--adapter") ?? "dry-run"`; `taskFile` =
  pirmas pozicinis; usage eilutėje (:46) nurodyti abi formas.
- `codex-dispatch.ts`: ištrinti lokalų `flagValue` (:69+), importuoti iš `../spec/flag-value.js`;
  `taskId` = pirmas pozicinis, praleidžiant `--adapter`/`--context-pack` reikšmes; usage
  eilutėje (:51) rodyti `--adapter codex --context-pack <file>` (abi formos veikia).
- `retry-guard.ts`: `argValue` → `flagValue` iš `../spec/flag-value.js` (abi formos).
- `on-stop-bridge.ts`: `args[0]` tuščias → `deps.io?.error(...)`/stderr usage
  `Usage: verqestra on-stop-bridge <status> [reason]` ir `return 2` be `writeStopBridge`;
  jei `OnStopBridgeCommandDeps` neturi `io`, pridėti neprivalomą `io?: CliIo` — composition
  kvietėjas (`commands-ops.ts:416`) lieka suderinamas be pakeitimo.
- Testai `interfaces-cli-dispatch.test.ts`: `dispatch ["t.md","--adapter","codex"]` ir
  `["--adapter","codex","t.md"]` → adapteris codex, taskFile `t.md`; `codex-dispatch
  ["--adapter","codex","--context-pack","cp.json","0007"]` → taskId `0007`; `retry-guard
  ["--task-id=0042"]` = `["--task-id","0042"]`; `on-stop-bridge []` → 2, `writeStopBridge`
  nekviestas; esami inline-formos testai nepakitę.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei `on-stop-bridge` exit 2 be argumentų
lūžtų realiam kvietėjui — Grep'ink `on-stop-bridge` per `src/` ir `.claude/settings.json`;
šiandien registro antraštė (:9) sako, kad į Stop grandinę jis NEprijungtas.

## Neįtraukta
- `claude-dispatch --task-id=<id>` inline forma (`dispatch-invocation.ts`) ir
  `task-generate --change=<id>` — task 216.
- `learning.ts` lokalus `argValue` — task 215 (tas pats failas ten keičiamas).
- Registro usage `codex-dispatch <task-id> [--adapter codex]` be `--context-pack` — drift 217.
- `benchmark-*` griežti parseriai — sąmoningai atskiri (fiksuotas invocation vektorius), task 213
  tik prideda vienaskaitos aliasus.
