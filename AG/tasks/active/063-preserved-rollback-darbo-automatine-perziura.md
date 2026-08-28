# Task

HUMAN-REVIEW-APPROVED: mindebaltru 2026-08-28 operatoriaus pavedimu („šios funkcijos verqestra visada peržiūrėti ir tvarkyti") po 1151 atvejo GeoGravity

## Spec source
openspec/changes/verqestra-backlog-v1

## Žingsnis 0 — ar jau įgyvendinta?
Jei po `ROLLBACK PRESERVED` orchestrator'ius automatiškai įvertina išsaugotą
darbą (patikros ant preserved ref turinio) ir žalią darbą grąžina/užbaigia
vietoj beveidžio human-review parkavimo — ALREADY_IMPLEMENTED.

## Tikslas
GeoGravity 2026-08-28, task 1151: dispatch'as du kartus baigėsi exit 124
(timeout), diagnozė → human_review, task-scoped rollback išsaugojo darbą į
`refs/verqestra/preserved/<sha>` (5 failai, +173/-30). Rankinė peržiūra
parodė, kad implementacija buvo PILNAI baigta su testais — timeout suvalgė
tik patikrų fazę. Be rankinės archeologijos šis darbas būtų prarastas, o
task'as perdarytas nuo nulio už pilną kainą.

Reikalinga funkcija: po kiekvieno `ROLLBACK PRESERVED` orchestrator'ius
VISADA peržiūri išsaugotą darbą ir jį sutvarko:

1. preserved diff atstatomas izoliuotoje kopijoje (worktree mechanizmas jau
   yra);
2. paleidžiamos task'o `## Patikra` komandos (arba quality-gates scope);
3. žalia → darbas commit'inamas, task'as uždaromas done su
   `PRESERVED-WORK-RECOVERED` žyma commit žinutėje;
4. raudona → human-review kaip dabar, bet parkavimo priežastis papildoma
   patikrų išvestimi ir preserved ref nuoroda — žmogus mato, KIEK darbo yra
   ir kas konkrečiai raudona.

## Agentai
readme-guard -> architect -> schedule-domain -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/task-execution/` (rollback/verify kelias)
- `src/application/scheduling/` (jei integracija eina per wave)
- `src/infrastructure/git/` (preserved ref atstatymas)
- `src/composition/loop/`
- `src/tests/`

Draudžiama:
- `dist/**`
- `node_modules/**`
- `ui-app/**`

## Veiksmas
- Architect: nustatyti, kur gyvena `ROLLBACK PRESERVED` sprendimas ir kaip
  prijungti patikrų žingsnį be antro LLM kvietimo (patikros yra
  deterministinės komandos).
- Riba: automatinis užbaigimas TIK kai patikros pilnai žalios IR pakeisti
  failai telpa į task'o allowlist; kitu atveju — informatyvus human-review.
- Testai: žalias preserved darbas → done su žyma; raudonas → human-review su
  patikrų uodega; preserved ref be turinio → human-review kaip dabar.

## Patikra
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test:only`

## Stop
Commit'ink, kai patikros žalios.

## Neįtraukta
Timeout'o šaknies (per didelių taskų) sprendimas — atskira autorystės
taisyklė. Preserved ref'ų valymo politika. UI rodymas.
