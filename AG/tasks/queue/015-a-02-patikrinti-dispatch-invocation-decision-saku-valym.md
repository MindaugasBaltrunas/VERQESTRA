# Task

## Spec source
openspec/changes/verqestra-backlog-v1/ (tasks.md eilutė: dispatch flow matavimas)

## Tikslas
Užbaigti 2026-08-25 audito P0-1 valymus `dispatch-invocation.ts`: patvirtinti, kad negyva `decision.task_id?.trim()` šaka pašalinta, o tuščio decision atveju log'e nerašomas klaidinantis hardcoded `sonnet` — vietoje jo `none`. Jei abu jau sutvarkyti, padengti elgesį testu, o kodo nekeisti.

## Agentai
PRIVALOMA grandinė šia tvarka: readme-guard -> coder -> reviewer -> tester. readme-guard eina pirmas ir grąžina ribų santrauką.

## Failai
Leidžiama:
- `src/interfaces/cli/dispatch/claude-dispatch/dispatch-invocation.ts`
- `src/interfaces/cli/dispatch/claude-dispatch/dispatch-routing-plan.ts`
- `src/tests/**`

Draudžiama:
- `src/composition/agent/dispatch-adapters.ts`
- `migration-coverage.json`
- `.env`
- `.env.*`
- `dist/**`
- `node_modules/**`

## Veiksmas
- PASTABA (2026-08-25): failas perkeltas iš klaidingo `AG/tasks/tasks/queue/` kelio (split
  rašytojo dvigubinimo bug'as, pataisytas `coordinator-execution-adapters.ts`); turinys nekeistas.
- Peržiūrėti `dispatch-invocation.ts` tapatybės kandidato šaką (44-65 eil.) ir `dispatch-routing-plan.ts` `selected=` log'us (69, 75 eil.); pataisyti tik tai, kas realiai dar klaidina.
- Pridėti testą `src/tests/`: kai decision tuščias (nei attempt, nei veidrodis), log'o eilutėje figūruoja `none`, o ne konkretus modelis.
- Jei radinių nėra — nekeisti produkcinio kodo ir ataskaitoje aiškiai pasakyti, kad kodas jau teisingas.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Sustoti, kai patikros praeina ir tuščio decision log'o elgesys padengtas testu. Tada commitinti ir sustoti. Sustoti nedelsiant, jei taisymas reikalautų keisti `dispatch-ports.ts` kontraktą.

## Neįtraukta
- `resolveAttempt` rezoliucija (atskira užduotis).
- `migration-coverage.json` įrašas (atskira užduotis).
- Turn budget lubų keitimas (task 016).
