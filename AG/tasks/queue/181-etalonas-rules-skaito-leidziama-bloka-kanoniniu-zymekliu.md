# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- 178-glob-vidurio-dvi-zvaigzdutes-priima-nuli-katalogu-viena-kopija

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/domain/tasks/etalonas-rules.ts` `leidziamaBlockLines` (178-195 eil.) žymeklius atpažįsta per
`allowed-paths.ts` eksportuotą taisyklę (`isScopeMarkerLine` arba naują `isAllowMarkerLine`/
`isDenyMarkerLine`), o ne per `normalizeTaskHeading(...) === "leidziama:"`, IR `checkPatikra` (435-463 eil.)
komandą ima iš PIRMO backtick tokeno (ne `replace(/^`|`$/g, "")`) — ALREADY_IMPLEMENTED: cituok
abi vietas ir `domain-tasks-etalonas-rules.test.ts` testus.

## Tikslas
Pilnas auditas 2026-09-05 (`docs/audits/full-audit-2026-09-05.md`, D5, PG-2, PG-3; domain P2 #21-#23).
D5: du `Leidžiama:` skaitytojai. Kanoninis `allowed-paths.ts:20-23` toleruoja `Leid[žz]iama\b…:`
(`Leidžiama keisti:`, `Leidziama:`), o `etalonas-rules.ts:184-190` reikalauja TIKSLAUS normalizuoto
`leidziama:`. Task'as su LLM rašyba scope'ą gauna (preflight, diagnozė), bet
`production-file-without-test`, `ui-file-without-*`, `failai-wildcard-without-justification`,
`failai-prose-inside-leidziama` tyliai išjungiami (`leidziamaPaths` → `[]`). Korpuse 2026-09-05
tokių formų nėra (Grep `Leid[žz]iama\s+\S+:` per `AG/tasks/**` — 0), tad taisymas šiandien nieko
nenudažo, bet uždaro tylų apėjimą. Kryptis: etalonas-rules importuoja žymeklio atpažinimą iš
`allowed-paths` — VIENAS apibrėžimas.
PG-2 (#22): `checkPatikra` 455 eil. `item.replace(/^`|`$/g,"")` nuima backtick'us tik kraštuose:
`` - `pnpm test` (žr. pastabą) `` → `patikra-unknown-command`, nors etalonas (145-148 eil.) sako
„Kitokių komandų reikia — pagrindimas šalia", o CLAUDE.md mobile/benchmark task'ams liepia rašyti
`pnpm test:mobile`/`pnpm test:benchmark` į `## Patikra` — jie visada raudoni. Kryptis: komanda =
pirmas backtick tokenas; leistina forma su uodega — praeina; NEleistina forma praeina TIK su
pagrindimo tekstu tame pačiame bullet'e po tokeno, be jo — `patikra-unknown-command` kaip iki šiol.
#21: `isBackendProductionFile` 118-119 eil. `startsWith("src/") && !startsWith("ui-app/")` — antra
sąlyga negyva. #23: `allowed-paths.ts:38-42` doc „TIK `Leidžiama:` bloko tekstą", kodas be žymeklio
ima VISĄ sekciją iki `Draudžiama:`; tas pats paveikia `failai-scope-edit.ts:63`. Doc suderinti su
kodu (elgesys lieka — jis tyčinis 101-b-03 kontekste), o `failai-scope-edit` — patikrinti, kad
įterpta `> pastaba` su backtick'ais be žymeklio nelaikoma keliu ir kad testas tai pina.

## Agentai
readme-guard -> architect -> schedule-domain -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/domain/tasks/etalonas-rules.ts` (`leidziamaBlockLines` 178-195, `isBackendProductionFile` 116-124, `checkPatikra` 435-463 eil.)
- `src/domain/tasks/allowed-paths.ts` (žymeklio atpažinimo eksportas; 38-42 eil. doc)
- `src/domain/tasks/failai-scope-edit.ts` (63 eil. — žymeklio semantika ta pati)
- `src/tests/domain-tasks-etalonas-rules.test.ts`
- `src/tests/domain-tasks-failai-scope-edit.test.ts`
- `src/tests/domain-tasks.test.ts`

Draudžiama:
- `AG/tasks/examples/000-etalonas.md` (etalonas nekeičiamas)
- `src/application/quality-gates/preflight-rules.ts` (`checkPatikra` vartotojai — task 183)
- `src/domain/policies/check-command-allowlist.ts` (sandbox allowlist — hooks autorius)
- `dist/**`
- `node_modules/**`

## Veiksmas
- `allowed-paths.ts`: eksportuoti `isAllowMarkerLine(line)` / `isDenyMarkerLine(line)` (arba
  praplėsti `isScopeMarkerLine` grąžinant rūšį) ant esamų `ALLOW_MARKER`/`DENY_MARKER`; 38-42 eil.
  doc'ą pakeisti taip, kad sakytų tiesą apie „be žymeklio — visa sekcija iki `Draudžiama:`".
- `etalonas-rules.ts` `leidziamaBlockLines`: `active` įjungti per `isAllowMarkerLine`, išjungti per
  `isDenyMarkerLine`; `normalizeTaskHeading` palyginimas su literalu išnyksta. Pašalinti negyvą
  `!path.startsWith("ui-app/")` 119 eil.
- `etalonas-rules.ts` `checkPatikra`: komanda = pirmas `` `…` `` tokenas bullet'e; leistina forma su
  uodega — be pažeidimo; neleistina su uodega (bent 3 ne-tarpo simboliai po tokeno) — be pažeidimo;
  neleistina be uodegos — `patikra-unknown-command`. Citata pažeidime nurodo etalono 145-148 eil.
- `failai-scope-edit.ts` 63 eil.: naudoti tą patį žymeklio atpažinimą; testas — `> pastaba` su
  backtick'u be žymeklio nevirsta keliu.
- Korpuso patikra PRIVALOMA (task 157 pamoka): Grep'u per `AG/tasks/queue/*.md` ir `AG/tasks/done/*.md`
  rasti (a) `Leid[žz]iama` variantus su uodega, (b) `## Failai` sekcijas be žymeklio, (c) `## Patikra`
  bullet'us su uodega ar ne-allowlist komanda. Korpuso testas
  (`domain-tasks-etalonas-rules.test.ts:333`, queue + human-review) po pakeitimo privalo likti žalias;
  jei kuris queue task'as nudažomas raudonai — jo failas įtraukiamas į šio task'o ataskaitą, o
  pataisa negali būti taisyklės susilpninimas; 2026-09-05 (a)/(b) rasta 0, (c) — patikrinti vykdant.
- Testai: `Leidžiama keisti:` task'as su produkciniu failu be testo → `production-file-without-test`;
  `Leidziama:` (be ž) → tas pats; `` - `pnpm test` (pastaba) `` → be pažeidimo;
  `` - `pnpm test:mobile` — mobile paketas ne pnpm test dalis `` → be pažeidimo;
  `` - `pnpm typecheck` `` → `patikra-unknown-command`.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei korpuso testas (queue) raudonuoja dėl task'o,
kurio failo nėra šio scope — tada ataskaitoje įvardyk failą ir pažeidimą; taisyklės silpninti negalima.

## Neįtraukta
- `preflight-rules.ts`/`preflight.ts` sekcijų matcher'iai (QG-2) ir broad-scope — task 183.
- `isWildcardPath` (107-109 eil.) suvienodinimas su `matchesAllowedPath` — lieka etalono apibrėžimas;
  broad-scope sprendimą priima task 183 preflight pusėje.
- Sandbox komandų allowlist (`check-command-allowlist.ts`) — hooks autorius; `pnpm test:mobile`
  vykdymo leidimas sandbox'e nėra šio task'o klausimas.
- `agent-selection.ts` `LEADING_LABEL` godumas (`agentai-readme-guard-not-first` false positive) — task 188.
