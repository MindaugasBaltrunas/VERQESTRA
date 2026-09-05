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
Tikrinti po punktą: (1) `src/domain/architecture/node-verification-rules.ts:72-83`
`findForbiddenDistImports` gaudo `export … from "…/dist/…"`, `import("…/dist/…")` ir `require(...)`;
(2) `src/domain/diagnosis/log-digest.ts:135` retry raktai lyginami tiksliu task id (`010` NEgauna
`0100-…`); (3) `src/domain/tool-results/bash-output-replacement.ts:331-333` `pnpm test 2>&1` NElaikomas
grandine; (4) `src/domain/metrics/usage.ts:98-101` `llm_calls` neskaičiuoja 429/zero-usage įrašų
(kaip `domain/tokens/usage-ledger.ts:108-112`). Visi — ALREADY_IMPLEMENTED su citatomis; kitaip daromi likę.

## Tikslas
Pilnas auditas 2026-09-05 (`docs/audits/full-audit-2026-09-05.md`, P2 Domain; `audit-domain.md`
#28, #30, #31, #32).
- #31 `node-verification-rules.ts:72-83` `findForbiddenDistImports` tik `^import … from`;
  `export … from "…/dist/…"`, dinaminis `import("…/dist/…")` ir `require("…/dist/…")` praleidžiami —
  mazgo verifikacija dist importų nemato pusėje formų (ta pati klasė kaip T2 `architecture-gates`).
- #32 `log-digest.ts:135` `key.includes(taskId)`: task `010` gauna `0100-…`, `1010-…` retry įrašus
  diagnozės prompte — svetima istorija klaidina diagnozę. Kryptis: raktas = task id arba
  `taskId` + skirtukas (`:`/`-` po numerio), ne substring.
- #30 `bash-output-replacement.ts:331-333` `isChainedCommand = /[;|&]/` laiko `pnpm test 2>&1`
  grandine → niekada nekeičiama; `bash-command-policy.ts:277` tą patį `>&` laiko NE separatoriumi.
  Kryptis: `2>&1`/`>&` redirect'ai nėra grandinė; tikra grandinė — `;`, `&&`, `||`, `|` ne po `>`.
  `bash-command-policy.ts` nekeičiamas (hooks autorius) — čia suderinama su jo semantika.
- #28 `metrics/usage.ts:98-101` vs `tokens/usage-ledger.ts:108-112` — dvi „LLM kvietimo"
  definicijos: benchmark'as skaičiuoja 429/zero-usage įrašus kaip `llm_calls`, ledger'is — ne.
  Kryptis: benchmark'as perima ledger'io apibrėžimą (chargeable), `usage-ledger.ts` nekinta;
  `characterization-benchmark-verdicts.test.ts` charakterizacija — jei kuris verdiktas keičiasi, tai
  įrodymas, kad zero-usage įrašai iškraipė matavimą; įrašyti ataskaitoje.

## Agentai
readme-guard -> debugger -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/domain/architecture/node-verification-rules.ts` (72-83 eil.)
- `src/domain/diagnosis/log-digest.ts` (135 eil.)
- `src/domain/tool-results/bash-output-replacement.ts` (331-333 eil.)
- `src/domain/metrics/usage.ts` (98-101 eil.)
- `src/tests/domain-vq204.test.ts`
- `src/tests/characterization-benchmark-verdicts.test.ts`

Draudžiama:
- `src/domain/tokens/usage-ledger.ts` (apibrėžimo šaltinis, nekinta)
- `src/domain/policies/bash-command-policy.ts` (hooks autorius)
- `src/domain/policies/architecture-style.ts` (task 188)
- `src/tests/architecture-gates.test.ts` (T2 — testų autorius)
- `dist/**`
- `node_modules/**`

## Veiksmas
- `node-verification-rules.ts`: vienas regex rinkinys `import|export … from`, `import(`, `require(`
  su `/dist/` keliu; testai `domain-vq204.test.ts` visoms keturioms formoms + neigiamas (`dist` žodis
  komentare).
- `log-digest.ts:135`: `key === taskId || key.startsWith(\`${taskId}:\`) || key.startsWith(\`${taskId}-\`)`
  (pagal realų rakto formatą — patikrinti `retry-counts.json` rašytoją Grep'u ir įrašyti formatą
  doc'e); testas `010` vs `0100-x`.
- `bash-output-replacement.ts`: redirect'ų išėmimas prieš grandinės tikrinimą; testas —
  `pnpm test 2>&1` = ne grandinė, `pnpm build && pnpm test` = grandinė, `a | b` = grandinė.
- `usage.ts`: `llm_calls` = chargeable įrašai (be 429/zero-usage), doc'e nuoroda į
  `usage-ledger.ts:108-112` kaip apibrėžimo šaltinį.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei `characterization-benchmark-verdicts.test.ts`
verdiktas keičiasi realiam benchmark korpusui — charakterizacijos perrašymas yra operatoriaus
sprendimas, ne vykdytojo.

## Neįtraukta
- `architecture-gates.test.ts` importų formų aprėptis (T2) — testų autorius.
- `bash-command-policy.ts` separatorių semantika — hooks autorius; čia tik suderinama su ja.
- `git/changes.ts`, `graph-hash.ts` — task 194.
