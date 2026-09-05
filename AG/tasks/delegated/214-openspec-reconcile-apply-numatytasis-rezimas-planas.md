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
Jei `src/interfaces/cli/spec/openspec-reconcile.ts` `dryRun = !args.includes("--apply")`
(archyvavimas TIK su `--apply`), o `src/tests/interfaces-cli-spec-plan.test.ts` tvirtina, kad
be `--apply` `reconcileAutoOpenSpecBacklog` gauna `dryRun: true` — ALREADY_IMPLEMENTED: cituok
eilutę ir testą.

## Tikslas
Pilnas auditas, `docs/audits/full-audit-2026-09-05.md` P1-C2 (2026-09-05), `audit-cli.md` F3,
`audit-docs.md` 2: `openspec-reconcile.ts:25` `dryRun = args.includes("--dry-run")` —
numatytasis režimas ARCHYVUOJA (perkelia change'us į archive), `--apply` neegzistuoja.
Registras `commands-spec.ts:95` (`[--apply]`), `README.md:147` ir `docs/spec-workflow.md:52`
žada planą be flag'o. `verqestra openspec-reconcile`, paleistas peržiūrai, mutuoja
`AG/openspec/changes`. Semantika apversta ten, kur dokumentacija žada saugų kelią.

Kvietėjai (Grep `openspec-reconcile|reconcileAutoOpenSpecBacklog` per `src/`, 2026-09-05):
`commands-spec.ts:94` registracija (operatoriaus komanda) ir testai; loop'as/composition
`reconcileAutoOpenSpecBacklog` NEKVIEČIA (`converge`, `wave-outcome`, `empty-queue` — ne).
Elgesio pakeitimas saugus, bet stop-sąlyga žemiau lieka, jei Grep'as vykdymo metu rastų
naują kvietėją.

Sprendimas: numatytasis = dry-run (`would archive`), `--apply` = archyvuoja; `--dry-run`
lieka priimamas kaip aiškus sinonimas numatytojo (atgalinis suderinamumas skriptams).
Exit kontraktas (0/1/2) nekinta.

## Agentai
readme-guard -> debugger -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/interfaces/cli/spec/openspec-reconcile.ts`
- `src/tests/interfaces-cli-spec-plan.test.ts`

Draudžiama:
- `src/application/task-execution/openspec-reconcile.ts` (logika nekinta)
- `src/composition/cli/commands-spec.ts` (usage `[--apply]` jau teisinga)
- `docs/spec-workflow.md` (tampa teisingas be pakeitimo)
- `README.md`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `openspec-reconcile.ts:25`: `const apply = args.includes("--apply"); const dryRun = !apply;`
  `--dry-run` kartu su `--apply` → usage klaida, exit 2. Antraštėje (:5-7) įrašyti naują
  kontraktą: be `--apply` — tik ataskaita.
- Žmogui skirtoje išvestyje be `--apply` pridėti eilutę `dry run — re-run with --apply to
  archive`, kad planas nebūtų palaikytas įvykdytu veiksmu.
- Testai `interfaces-cli-spec-plan.test.ts` (fake `OpenSpecReconcileFsPort` fiksuoja
  `dryRun`): `[]` → `dryRun: true`, `would archive`; `["--apply"]` → `dryRun: false`,
  `archived`; `["--dry-run"]` → `true`; `["--apply","--dry-run"]` → 2; `--json` su/ be
  `--apply` — ataskaitos struktūra nepakitusi.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. STOP ir klausk, jei Grep'as randa `openspec-reconcile`
kvietėją loop'e/composition už `commands-spec.ts` registracijos ribų (pvz. `converge` ar
`empty-queue` adapteriuose) — tada numatytojo režimo apvertimas keistų automatinį elgesį ir
reikalauja operatoriaus sprendimo, ne tylaus pakeitimo.

## Neįtraukta
- README:147 ir `commands-spec.ts:95` eilutės — jau teisingos; drift 217 tik sutikrina.
- `docs/spec-workflow.md:52` — tampa teisingas.
- Application `reconcileAutoOpenSpecBacklog` numatytoji `dryRun` reikšmė — nekeičiama
  (kvietėjas paduoda eksplicitiškai).
