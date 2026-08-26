# Task

## Spec source
openspec/changes/verqestra-backlog-v1
docs/audits/ (slot-2 auditas 2026-08-26, radinys 3, antra pusė)

## Tikslas
Nustoti skelbti sankirta glob'us, kurie įrodomai negali sutapti, ir atskirti RIBOTĄ glob'ą
nuo neribotos apimties `wildcard-scope` spragoje. Dabar bet koks šablonas atima
lygiagretumą, net kai jo ribos aiškios.

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/domain/scheduling/scope-lock-rules.ts`
- `src/application/scheduling/conflict-detector.ts`
- `src/tests/scheduling-conflict-detector.test.ts`
- `src/tests/scope-lock-rules.test.ts`

Draudžiama:
- `.env`
- `node_modules/**`
- `dist/**`

## Dependencies
depends_on: none

## Veiksmas
- MATAVIMAS (tikras detektorius, 2026-08-26): `src/tests/a-*.test.ts` vs
  `src/tests/b-*.test.ts` gauna verdiktą `persidengiantis glob/glob scope`, nors nė vienas
  failas negali atitikti abiejų šablonų. Priežastis — `scope-lock-rules.ts:175-183` lygina
  KIETUS PREFIKSUS (`solidPrefix`), tad du šablonai tame pačiame kataloge visada laikomi
  susikertančiais.
- Tai fail-closed sprendimas, ne aplaidumas: komentaras `:179-181` teisingai paaiškina, kodėl
  tuščias prefiksas reiškia „gali persidengti". Šio task'o riba — pridėti ĮRODOMO
  nepersidengimo atvejį, o ne susilpninti taisyklę.
- Pridėti patikrą: du glob'ai su tuo pačiu kietu prefiksu, kurių likusios dalys
  negali sutapti nė viename kelyje, NĖRA sankirta. Ko įrodyti nepavyksta — lieka sankirta.
- Antra pusė: `wildcard-scope` spraga uždedama BET KOKIAM šablonui. Atskirti ribotą
  (`src/tests/a-*.test.ts` — vienas katalogas, fiksuotas plėtinys) nuo neribotos
  (`src/tests/**`, `**/x.ts`). Spraga privalo likti tik antrai grupei.
- Be šios antros pusės pirmoji NIEKO nepakeis: spraga vienoje pusėje daro porą nuoseklia
  net be sankirtos. Abi dalys arba viena kartu, arba task'as neduoda matomo rezultato.
- Testai: nepersidengiantys glob'ai → `independent`; persidengiantys → sankirta; ribotas
  glob'as → be spragos; `**` → spraga lieka; `**/index.ts` vs `src/**` → sankirta (esamas
  fail-closed atvejis nesugadintas).

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Sustok nedelsiant, jei sprendimas reikalautų leisti porą,
kurios nepriklausomumo įrodyti nepavyksta — klaidingas `independent` reiškia du vykdytojus
tame pačiame faile, o tai brangiau už prarastą lygiagretumą.

## Neįtraukta
- Užduočių `## Failai` konvencija (task 034).
- `worktree-policy.json` įjungimas.
- Worker prašymo numatytosios reikšmės keitimas.
