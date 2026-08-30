# Task

## Spec source
openspec/changes/verqestra-backlog-v1

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/interfaces/hooks/pre-hooks.ts` funkcija `etalonasStructureBlock`
(~202 eil.) active/delegated keliams prieš `validateTaskAgainstEtalonas`
jau taiko `stripVerificationPreamble` (grep `stripVerificationPreamble`
tame faile duoda radinį) IR konformance testas
(`src/tests/interfaces-hooks-pre-hooks.test.ts:405`) active bucket'o failus
validuoja po strip, o violations kaupia į VIENĄ sąrašą per visus failus su
assert'u gale — ALREADY_IMPLEMENTED: nurodyk eilutes hook'e ir teste.

## Tikslas
Nuo 071/071-a-02 etalono struktūros vartai galioja queue IR active/delegated
bucket'ams: pre-write hook'as
(`src/interfaces/hooks/pre-hooks.ts:124`,
`ETALONAS_VALIDATED_TASK_PATH_PATTERN = queue|active|delegated`) ir
konformance testas (`src/tests/interfaces-hooks-pre-hooks.test.ts:405` —
validuoja queue ir active žalią failo tekstą). Bet active bucket'o failas
dispatch'o metu TEISĖTAI nešioja `verificationPreamble`
(`src/application/quality-gates/preflight-rules.ts:147`; instaliuoja
`src/composition/loop/coordinator-adapters.ts:139-145`), o dispatch'o forma
vartų nepraeina — mandatory-section-order skelbia, kad Spec source sekcija
eina po Žingsnis 0 preambulės bloko. Pasekmė 2026-08-30: kol vienas
workeris dispatch'ina (jo active failas SU preambule), kito workerio/loop'o
`pnpm test` vartai raudonuoja klaidingai — lenktynės tarp slotų. Antra yda:
ir hook'as ima tik pirmą violation (`pre-hooks.ts:214` — `[0]`), ir
konformance testas assert'ina per pirmą failą — fail-fast maskavo kitus
pažeidimus, 2026-08-30 tris kartus iš eilės atsidengė po vieną. Sprendimas:
active/delegated bucket'ams validuoti
`stripVerificationPreamble(prospectiveText)` (interfaces →
application/quality-gates importas leidžiamas pagal sluoksnių lentelę;
strip yra fence-aware ir testuotas —
`src/tests/quality-gates-preflight.test.ts:455-479`), queue — žalią tekstą
kaip dabar; konformance teste violations rinkti į vieną sąrašą per visus
failus ir assert'inti gale. Invariantas su 092: queue visada kanoninė
forma, dispatch'o forma leidžiama tik active/delegated bandymo lange.

## Agentai
readme-guard -> architect -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/interfaces/hooks/pre-hooks.ts` (dabar 343 eil. — telpa į 500 vartą)
- `src/tests/interfaces-hooks-pre-hooks.test.ts` (dabar 432 eil.)
- `src/tests/interfaces-hooks-pre-hooks-dispatch-form.test.ts` (numatomas
  naujas: jei nauji testai netelpa į esamą failą iki 500 eil. — nauji
  atvejai eina čia pagal `interfaces-hooks-pre-hooks-known-ids.test.ts`
  konvenciją; jei vardas parenkamas kitoks — tas failas vietoje šio,
  įrašyti į ataskaitą)

Draudžiama:
- `src/domain/tasks/etalonas-rules.ts` (taisyklių turinys nekeičiamas)
- `src/application/quality-gates/preflight-rules.ts` (tik importuojamas,
  nekeičiamas)
- `src/application/task-execution/**` (092 scope)
- `src/interfaces/http/**` (092 scope)
- `dist/**`
- `node_modules/**`

## Veiksmas
- `src/interfaces/hooks/pre-hooks.ts` (`etalonasStructureBlock`, 202-224
  eil.): iš kelio nustatyti bucket'ą (pattern'as 124 eil. jį jau skiria);
  active/delegated atveju į `validateTaskAgainstEtalonas` paduoti
  `stripVerificationPreamble(text)`, queue atveju — žalią tekstą kaip
  dabar. Importas iš `../../application/quality-gates/preflight-rules.js`.
- `src/tests/interfaces-hooks-pre-hooks.test.ts` (405-431 eil.): active
  bucket'o failų tekstą prieš validaciją pravaryti per strip; queue —
  žalią; violations iš VISŲ failų (abiejų bucket'ų) kaupti į vieną sąrašą
  ir assert'inti gale, kad vienas nevalidus failas nebemaskuotų likusių.
- Nauji testų atvejai: (1) rašymas į `AG/tasks/active/...` su preambule ir
  validžiu kanoniniu kūnu PRAEINA; (2) rašymas į `AG/tasks/queue/...` su
  preambule BLOKUOJAMAS; (3) rašymas į active su preambule ir nevalidžiu
  kūnu BLOKUOJAMAS su kūno taisyklės žinute (ne preambulės artefaktu).

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei strip taikymui
prireiktų keisti `validateTaskAgainstEtalonas` signatūrą ar taisyklių
turinį `etalonas-rules.ts` — tai už šio task'o ribų.

## Neįtraukta
Etalono taisyklių turinio keitimas `etalonas-rules.ts` — vartai keičia tik
tai, KOKS tekstas paduodamas validacijai. Preambulės nuėmimas perėjimų iš
dispatch'o lango metu (queue/human-review/done visada kanoninė forma) — 092.
`done`/`human-review` bucket'ų validacijos įjungimas — sąmoningas 071
sprendimas, lieka.
