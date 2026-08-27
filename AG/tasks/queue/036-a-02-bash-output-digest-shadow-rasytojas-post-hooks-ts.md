# Task

## Spec source
- `openspec/changes/auto-036-shadow-matavimai-likusioms-keturioms-velavoms/` (spec.md: „Rašytojas `toolRawChars`/`toolDigestChars` laukams“)
- `src/application/context-pack/metrics.ts:84-86` — laukai jau deklaruoti, rašytojo nėra

## Tikslas
PostToolUse Bash kelias shadow režimu užrašo abu dydžius — koks raw tool output ir kokia būtų jo santrauka — į `context-size.jsonl` per `task_id`, NEkeisdamas to, kas realiai perduodama, kol `bash_output_digest` vėliava išjungta.

## Agentai
PRIVALOMA grandinė, tvarka nekeičiama:
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/interfaces/hooks/post-hooks.ts`
- `src/tests/interfaces-hooks-post-hooks.test.ts`

Draudžiama:
- `AG/**`
- `vq/**`
- `.env`
- `src/application/context-pack/metrics.ts`
- `ui-app/src/**`

## Veiksmas
- Esamame `recordBashDigestShadow` taške (kur jau turimos `rawText` ir `digest` reikšmės) papildomai užrašyti `toolRawChars`/`toolDigestChars` porą į `context-size.jsonl`; naudoti tik esamą metrikų lentelės kelią, jokių šalutinių laukų.
- Pirmiausia patikrinti FAKTĄ, ar `task_id` pasiekiamas PostToolUse Bash hook kontekste. Jei nepasiekiamas — NErašyti įrašo be `task_id` ir nekurti pakaitinio identifikatoriaus; sustoti ir raportuoti.
- Testuose padengti: shadow įrašas atsiranda su abiem dydžiais kai vėliava išjungta, o hook'o grąžinamas realus Bash output lieka bitiškai nepakitęs.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink tik kai abi patikros žalios. Sustok, jei matavimas reikalautų pakeisti perduodamą Bash output arba jei `task_id` hook kontekste nepasiekiamas — matavimas privalo būti nemokamas elgesio prasme.

## Neįtraukta
- `symbol_slices`, `dispatch_tool_schema`, `compact_dsl` rašytojai.
- `decideCompression` verdikto keitimas ir `ui-app` vertimai.
- `bash_output_digest` vėliavos įjungimas.
