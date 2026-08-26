# Task

## Spec source
openspec/changes/verqestra-backlog-v1
docs/audits/ (slot-2 auditas 2026-08-26, radinys 3)

## Tikslas
Pakeisti užduočių `## Failai` konvenciją taip, kad backend užduotys deklaruotų konkrečius
testų failus vietoj `src/tests/**`. Kol ten stovi wildcard, dvi užduotys niekada negali
suktis lygiagrečiai, net jei liečia visiškai skirtingus modulius.

## Agentai
readme-guard -> architect -> documenter -> reviewer

## Failai
Leidžiama:
- `AG/tasks/queue/032-baigties-priezastis-skiria-nieko-neraseg-nuo-atsukto.md`
- `AG/tasks/queue/033-skaidymas-negimdo-tusciu-tesinio-vaiku.md`
- `templates/**`
- `CLAUDE.md`

Draudžiama:
- `src/**`
- `.env`
- `node_modules/**`

## Dependencies
depends_on: none

## Veiksmas
- MATAVIMAS (tikras `evaluateWriteSetIndependence`, 2026-08-26): dvi užduotys su
  KONKREČIAIS keliais gauna verdiktą `write set'ai nesikerta nė vienoje dimensijoje` —
  lygiagretumas veikia. Tos pačios užduotys su `src/tests/**` gauna
  `1 įrodymo spraga: wildcard-scope`, ir spraga VIENOJE pusėje daro porą nuoseklia net be
  jokios sankirtos.
- Realus pavyzdys iš eilės: `032 × 033` blokuojami dviem priežastimis vienu metu —
  `persidengiantis glob/glob scope: 'src/tests/**' vs 'src/tests/**'` PLIUS dvi
  `wildcard-scope` spragos. Abi kyla iš tos pačios eilutės `## Failai`.
- Pakeisti `032` ir `033` `## Failai` sekcijas: vietoj `src/tests/**` įrašyti konkrečius
  testų failus, kuriuos jos realiai liečia (pvz. `src/tests/task-execution-run.test.ts`).
  Jei tikslus vardas nežinomas — įrašyti numatomą; klaidingas konkretus kelias yra
  taisomas, o wildcard'as tyliai atima lygiagretumą.
- Įrašyti konvenciją ten, kur ją mato užduočių autorius: `## Failai` deklaruoja konkrečius
  kelius; `**` leidžiamas TIK kai apimtis tikrai neribota, ir tada užduotis sąmoningai
  atsisako lygiagretumo.
- Konvencija privalo paaiškinti KAINĄ, ne tik taisyklę: be jos kitas autorius vėl parašys
  `src/tests/**`, nes taip trumpiau.

## Patikra
- `pnpm typecheck`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Sustok, jei paaiškėtų, kad `templates/` ar `CLAUDE.md` nėra
ta vieta, kur gyvena užduočių šablonas — tada vietą nurodo operatorius.

## Neįtraukta
- Konflikto detektoriaus tikslumo taisymas (task 035).
- `worktree-policy.json` įjungimas — atskiras operatoriaus sprendimas.
- `AG_MAX_WORKERS` keitimas.
