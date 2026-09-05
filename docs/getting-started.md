# Getting started

VERQESTRA yra spec-first orkestratorius apribotiems AI kodavimo agentams. Šis puslapis yra
trumpiausias kelias nuo švaraus checkout'o iki veikiančio ciklo.

## 1. Aplinka

- Node ≥ 22, pnpm 11 (`packageManager` laukas `package.json` užrakina tikslią versiją — ir
  CI, ir corepack ją ima iš ten, niekur kitur ji nerašoma).
- Git repozitorija: dalis vartų (`spec-drift`, `security-verify`, worktree izoliacija) remiasi
  `git status`, tad ne-git kataloge jie sąmoningai atsisako dirbti, o ne spėlioja.

```bash
pnpm install     # šaknies paketas + AG/benchmark + ui-app darbo sritys
pnpm test        # lint → build → ~2200 testų → ui-app; vartai bėga PIRMI
```

Jei `pnpm test` žalias, aplinka tinkama. Jei ne — nieko toliau daryti neverta: visi kiti
keliai remiasi `dist/`, kurį sukuria būtent šis žingsnis.

## 2. Kur kas gyvena

| Kelias | Kas tai |
|---|---|
| `src/` | produktas (sluoksniai `shared → domain → application → infrastructure → interfaces → composition`) |
| `AG/tasks/` | darbo eilė (`queue`, `active`, `done`, `failed`, `human-review`, …) |
| `AG/spec/`, `AG/openspec/` | spec kontraktai: mašinai ir žmogui |
| `AG/benchmark/` | atskiras paketas, matuojantis šį orkestratorių per CLI (BENCH-1) |
| `ui-app/` | React dashboard'as (`pnpm build:ui` → `ui-app/dist`) |
| `vq/` | RUNTIME: konfigai, būsena, žurnalai, kešas. Nėra git'e. |
| `templates/` | ką `verqestra install` įdiegia į projektą |

`vq/` nebuvimas git'e yra sprendimas, o ne aplaidumas: tai vieno diegimo būsena, o jos šaltinis
yra `templates/`.

## 3. Konfigų sėjimas

Švarus checkout'as `vq/config` neturi, tad politikų loaderiai ima savo default'us, o
`quality-gates` — vienintelis, kuris reikalauja EKSPLICITINĖS politikos — atsisako dirbti
(exit 2). Tai fail-closed elgesys: kokybės vartai neturi teisės išsigalvoti, ką paleisti.

```bash
node dist/cli.js install .        # įdiegia šablonus (esamų failų NEPERRAŠO)
node dist/cli.js install . --dry-run   # tik parodo, ką rašytų
```

Po to `vq/config/quality-policy.json` yra tavo — redaguok jį, o ne kodą.

## 4. Pirmas ciklas

```bash
node dist/cli.js status                     # eilė, einamasis task'as, tokenai, stop įrodymas
node dist/cli.js preflight AG/tasks/queue/0001-mano.md   # vartai PRIEŠ dispatch'ą
node dist/cli.js context-pack AG/tasks/queue/0001-mano.md --with-code-graph
node dist/cli.js loop                       # pilnas ciklas
```

`preflight` ir `context-pack` galima paleisti atskirai — tai ta pati logika, kurią naudoja
`loop`, tik be vykdymo. Naudinga, kai nori pamatyti, KĄ agentas gaus, prieš jam mokant.

## 5. Dashboard'as

```bash
pnpm build:ui
node dist/cli.js ui
```

Serveris klauso TIK loopback'e ir kiekvieno starto metu generuoja naują token'ą, kurį įrašo į
atiduodamą `index.html`. Perkrautas serveris nebepriima senų naršyklės skirtukų — tai savybė.

## 6. Hook'ai (self-hosting)

`.claude/settings.json` prijungia VERQESTRA vartus prie Claude Code gyvavimo ciklo. Kas iš to
seka praktikoje:

| Įvykis | Kas nutinka |
|---|---|
| `PreToolUse` Bash | komanda tikrinama prieš komandų politiką (`rm -rf` blokuojamas) |
| `PreToolUse` Write/Edit | readme-guard: prieš kodo keitimą privaloma per Read perskaityti `README.md` |
| `PostToolUse` | rašymų ledger'is, KPI įvykiai, guard'ų fan-out (neblokuoja niekada) |
| `Stop` | kokybės vartai → guard'ai → **commit** |

**Auto-push pagal nutylėjimą ĮJUNGTAS**: `auto_push_enabled: true` yra ir diegimo šablone
(`templates/vq/config/git-automation-policy.json`), ir kodo default'e
(`src/application/policy-governance/git-automation-policy.ts`). Stop hook'as po commit'o iškart
push'ina į remote. Vadinasi, commit'as NĖRA vien lokalus: `git reset` atsuka tik tavo medį, o
remote'e pakeitimas jau yra ir atšaukiamas tik atskiru veiksmu.

Kad Stop tik commit'intų lokaliai, `vq/config/git-automation-policy.json` įrašyk
`"auto_push_enabled": false` — vienos eilutės pakeitimas tame faile.

Kaip išjungti visus hook'us: ištrinti `.claude/settings.json`. Kaip išjungti vieną — pašalinti jo
įvykio bloką. Failas yra konfigas, ne kodas.

## Toliau

- [`spec-workflow.md`](spec-workflow.md) — nuo spec'ifikacijos iki eilės užduočių.
- [`context-pack.md`](context-pack.md) — ką agentas mato ir kodėl būtent tai.
- [`release.md`](release.md) — vartai, kurie sprendžia, ar galima išleisti.
