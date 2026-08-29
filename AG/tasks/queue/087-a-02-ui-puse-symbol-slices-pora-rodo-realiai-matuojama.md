# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Tikslas
UI pusėje užtikrinti, kad `symbol_slices` vėliava nebebūtų amžinai „unmeasured". `FEATURE_PAIR_SELECTORS` (`src/interfaces/http/ui-compression-view.ts:265`) ima porą iš `symbol_source_chars` vs `symbol_signature_chars` per `fixedFieldPair`, kuris reikalauja `raw > 0`. Jei ankstesnis rašytojo pusės task'as SRC dydžio SIG režimu neįvedė (žr. jo ataskaitą ir realų `vq/logs/context-size.jsonl`), poros laukus pakeisti į realiai egzistuojančius; jei įvedė — patikrinti, kad pora dabar matuojasi, ir padengti testu.

## Agentai
PRIVALOMA grandinė (be praleidimų, readme-guard pirmas):
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/interfaces/http/ui-compression-view.ts`
- `src/tests/ui-compression-view.test.ts`

Draudžiama:
- `src/application/context-pack/assemble/tiers.ts`
- `src/application/context-pack/assemble/persist.ts`
- `src/application/context-pack/metrics.ts`
- `dist/**`
- `node_modules/**`

## Veiksmas
- Architect: perskaityti rašytojo pusės task'o rezultatą ir kelis realius `vq/logs/context-size.jsonl` įrašus; nuspręsti, ar `symbol_slices` porai reikia kitų laukų, ar užtenka esamos, ir pagrindimą įrašyti į ataskaitą.
- Coder: pritaikyti sprendimą; `fixedFieldPair` kontraktas (`ui-compression-view.ts:245`) nesikeičia — keičiasi tik jam paduodama laukų pora.
- Tester: `src/tests/ui-compression-view.test.ts` tvirtina, kad SIG režimo mėginys duoda matuojamą `symbol_slices` porą, o kitų keturių vėliavų suvestinės nepakito.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink tik kai abi patikros žalios. SUSTOK ir klausk, jei teisingam poros matavimui prireiktų keisti `ContextSizeSample` schemą arba rašytojo pusę — tai jau kito scope darbas.

## Neįtraukta
Rašytojo pusės (`tiers.ts`/`persist.ts`) matavimo keitimas. `CONTEXT_CACHE_VERSION` kėlimas. Tier parinkimo ir kompresijos elgsenos keitimas. `worker_prompt_chars` — task 086.
