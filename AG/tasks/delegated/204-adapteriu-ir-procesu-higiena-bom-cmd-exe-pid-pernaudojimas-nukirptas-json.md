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
Jei VISI keturi: `src/infrastructure/adapters/claude-model-env.ts` `parseEnv` nuima UTF-8 BOM
(U+FEFF) prieš pirmą eilutę; `src/infrastructure/process/run-process.ts:150-157` komentaras
įvardija `cmd.exe /d /s /c` kelią `.cmd/.bat` formoms (ne „jokio shell'o"); `src/infrastructure/process/
process-tree.ts` `runWindowsProcessTreeKill` survivors sąrašą pertikrina per pakartotinį medžio
sąrašą; `src/infrastructure/adapters/claude-adapter.ts:55-57,67` `parseStructuredOutput` gauna
NEnukirptą stdout arba nukirpimą pažymi — ALREADY_IMPLEMENTED: cituok keturias vietas.

## Tikslas
Pilnas auditas 2026-09-05 (`docs/audits/full-audit-2026-09-05.md`, P2 Infrastructure; infrastructure
F9, F10, F11, F14):
- F9 `claude-model-env.ts:142-177`: `parseEnv` regex `^(?:export\s+)?([A-Za-z_]…)` nepraleidžia BOM
  pirmoje eilutėje, `readTextFileIfExists` jo nenuima → Windows Notepad išsaugotas `vq/config/models.env`
  tyliai praranda PIRMĄ raktą (`CLAUDE_HAIKU_MODEL` → default). Testų su BOM nėra
  (`infrastructure-launcher.test.ts:45-69`).
- F10 `run-process.ts:155-157`: `.cmd/.bat` (pnpm/npm/yarn) Windows'e eina `cmd.exe /d /s /c` — komentaras
  „args lieka atskiri argv elementai, be shell sluoksnio" netiesa: `%VAR%` cmd plečia. Čia taisomas
  KOMENTARAS; `%`/`^` atmetimas allowlist'e — task 205 (`check-command-allowlist.ts` jam priklauso).
- F11 `process-tree.ts:207-230`: `survivors = targets.filter(alive)` po žudymo — PID gali būti PERNAUDOTAS
  kito proceso → klaidingas „still alive" sąrašas timeout/abort žinutėje (melagingas įrodymas).
- F14 `claude-adapter.ts:55-57`: `normalize` nukerpa stdout iki `maxOutputBytes` (1 MB), o
  `parseStructuredOutput` parsina JAU nukirptą tekstą → validus CLI JSON tyliai dingsta. Failas
  PARKED/REFERENCE, poveikis ribotas, bet neteisingas kelias lieka pavyzdžiu.

## Agentai
readme-guard -> debugger -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/infrastructure/adapters/claude-model-env.ts` (`parseEnv` BOM)
- `src/infrastructure/process/run-process.ts` (tik :150-157 komentaras)
- `src/infrastructure/process/process-tree.ts` (`runWindowsProcessTreeKill` survivors)
- `src/infrastructure/adapters/claude-adapter.ts` (parse prieš normalize)
- `src/tests/infrastructure-launcher.test.ts`
- `src/tests/infrastructure-process.test.ts`
- `src/tests/infrastructure-adapters.test.ts`

Draudžiama:
- `src/infrastructure/process/quality-check-runner.ts` (ta pati `.cmd` forma, komentaro ten nėra)
- `src/domain/policies/check-command-allowlist.ts` (task 205)
- `src/infrastructure/adapters/adapter-runtime.ts` (`normalize` nekinta)
- `dist/**`
- `node_modules/**`

## Veiksmas
- F9: `parseEnv` — nukirpti vedantį U+FEFF simbolį (regex `^` + BOM, TS šaltinyje rašomas escape forma, ne literalu) prieš skaidymą; testas: eilutė `BOM + "CLAUDE_HAIKU_MODEL=x\nB=y"`
  → abu raktai; `loadModelsEnv` su BOM failu → `claudeHaikuModel === "x"`.
- F10: komentaras `:150-157` sako: `.exe` — tiesioginis spawn be shell'o; `.cmd/.bat` — per `cmd.exe`, kur
  `%VAR%` ir `^` interpretuojami, todėl argumentų higiena gyvena allowlist'e (nuoroda į
  `check-command-allowlist.ts`). Jokio kodo keitimo.
- F11: po kiekvieno bandymo `survivors = targets.filter(alive)` papildomai sankirta su
  `new Set([rootPid, ...await listTree(rootPid)])` — PID, kurio nebėra medyje, laikomas NEbegyvu, net jei
  `alive(pid)` dėl pernaudojimo grąžina true; komentaras įvardija likusią lenktynę. Testai
  (`infrastructure-process.test.ts:96-130` fake'ai): pernaudotas PID (alive true, medyje nėra) →
  nepatenka į survivors; tikras gyvas palikuonis (alive true, medyje yra) → patenka.
- F14: `execute` → `parseStructuredOutput(result.stdout)` skaičiuojamas PRIEŠ `normalize` (iš neapkirpto
  runner rezultato), o normalizuotas įrašas gauna tą `structuredOutput`; jei pats runner'is jau nukirpo
  (`stdoutTruncated`) — `structuredOutput` neteikiamas ir `reason` gauna `claude_output_truncated` sufiksą.
  Testas `infrastructure-adapters.test.ts:175-190` papildomas: ilgas validus JSON su mažu
  `maxOutputBytes` → `structuredOutput` yra.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei F14 reikalauja keisti `AdapterRuntime.normalize`
kontraktą (`adapter-runtime.ts`) — tada F14 lieka Neįtraukta, likę trys commit'inami.

## Neįtraukta
- `%VAR%`/`^` atmetimas spawn argumentuose — task 205.
- POSIX našlaičiai po runner'io SIGKILL (`detached: true`, F11 pirma pusė) — reikia Job Object/cgroup
  klasės sprendimo, atskiras task'as.
- `quality-check-runner.ts` — nekinta.
