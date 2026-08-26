# Task

## Spec source
docs/audits/ (kompresoriaus auditas 2026-08-26)
src/application/context-pack/metrics.ts (deklaruoti laukai su „writer gap" pastabomis)

## Tikslas
Kiekviena kompresijos vėliava turi turėti shadow matavimą, kad sprendimų lentelė
(`decideCompression`) galėtų ištarti verdiktą, o ne „nematuojama". Šiandien matuojamas
tik `worker_task_ir`; `bash_output_digest` ir `dispatch_tool_schema` laukai deklaruoti
`metrics.ts`, bet rašytojo neturi, o `symbol_slices` pjūvių dydžiai rašomi TIK kai
vėliava įjungta — t. y. „ar verta įjungti" atsakymo PRIEŠ įjungiant nėra.

## Agentai
readme-guard -> architect -> schedule-domain -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/context-pack/**`
- `src/interfaces/hooks/**`
- `src/interfaces/http/ui-compression-view.ts`
- `ui-app/src/**` (tik verdikto laukai ir vertimai)
- `src/tests/**`

Draudžiama:
- `AG/**` (etalonas read-only)
- `vq/**`
- `.env`

## Dependencies
depends_on: 032-shadow-matuoja-prompta-kuri-worker-realiai-gauna.md

## Veiksmas
- FAKTAS: `metrics.ts:82-86` — `toolRawChars`/`toolDigestChars` deklaruoti su pastaba
  „declared for schema/reader compatibility, no writer". `persist.ts:94-107` —
  `symbol_source_chars`/`symbol_signature_chars` rašomi tik iš finalizuoto pack'o su
  tier'ais, t. y. tik kai `symbol_slices` jau įjungtas.
- `bash_output_digest`: PostToolUse kelyje (hook'ai) suskaičiuoti abu dydžius shadow
  režimu — koks raw tool output ir kokia būtų jo santrauka — NEkeičiant to, kas realiai
  perduodama, kol vėliava išjungta.
- `symbol_slices`: surinkimo metu shadow'u suskaičiuoti, kiek chars kainuotų SRC ir kiek
  SIG pakopos, net kai pack'as renderinamas be tier'ų.
- `dispatch_tool_schema`: išmatuoti pilnos ir sumažintos schemos dydžius dispatch
  paruošimo metu (shadow pora, kaip 032).
- `compact_dsl`: pora jau egzistuoja kompiliacijoje (`irChars` vs `compiledChars` su
  DSL statistika) — tik pratekinti ją iki `context-size.jsonl`, jei jos ten dar nėra.
- Visi nauji laukai NEPRIVALOMI (nesantis matavimas yra nesantis, ne 0) ir eina per
  `COMPRESSION_METRIC_FIELDS` lentelę — vieno įrašo taisyklė.
- `decideCompression` išplėsti: vėliava su savo shadow pora gauna realų verdiktą pagal
  tą pačią logiką kaip `worker_task_ir` (moka / nemoka / trūksta mėginių); be poros —
  lieka „unmeasured". UI vertimai naujoms priežastims.

## Patikra
- `pnpm typecheck`
- `pnpm test`
- `pnpm --dir ui-app test`

## Stop
Commit'ink, kai patikros žalios. Sustok, jei shadow matavimas kurioje nors vietoje
reikalautų realiai pakeisti perduodamą turinį arba pastebimai (matuojamai) sulėtintų
dispatch kelią — matavimas privalo būti nemokamas elgesio prasme.

## Neįtraukta
- Vėliavų įjungimas.
- Benchmark paketo kohortos.
- Prompt'o lygio dedup ir IR struktūra (029/030 — padaryta).
