# Galutinis auditas — cutover (VQ-80A)

**Data:** 2026-08-22 · **Apimtis:** visa migracija E0–E8 · **Etalonas:** `D:\React\AG_loop`, užšaldytas

## Verdiktas

**Migracija baigta. Cutover įvykdytas.** VERQESTRA yra kanoninis produktas; AG_loop užšaldytas
ir nebevykdo darbo. Vienas įrodymas lieka atviras ir yra įvardytas: benchmark kaštų matavimas
(žr. „Kas lieka atvira").

## Ką reiškia „baigta"

| Kriterijus | Reikalavimas | Faktas |
|---|---|---|
| Coverage ledger | 0 `pending` (COV-3) | **0** (45 migrated + 11 wont-migrate) |
| Elgesio paritetas | visi VQ-003 rinkiniai žali | **166 atvejai / 12 rinkinių / 177 testai** |
| Šaknies suite | žalias | **1381/1381** |
| `ui-app` | žalias | **393/393** |
| `AG/benchmark` | = VQ-001 baseline | **701/704** (3 skip — Windows symlink) |
| Self-hosting | ciklas savo repo | **VQ-702: eilė → dispatch → vartai → commit** |
| `readiness-audit` | ok | **ok** visose penkiose kategorijose |
| `final-audit` | 9 patikros | **8 ok**, 1 atvira (benchmark evidence) |
| Etalonas | užšaldytas | **VQ-804: hook'ai išjungti, README archyvuotas** |

## Ko ši migracija išmokė

Vertingiausia dalis nėra skaičiai — juos galima pasiekti ir kopijuojant. Vertinga tai, **ką
atidengė prijungimas**, ir kad kiekvienas radinys turėjo tą pačią formą.

### Trys defektų klasės, kurios kartojosi

**1. „Parašyta, ištestuota, NEPRIJUNGTA."** Modulis su savo test suite'u, kurio niekas nekviečia.
Testai žali, funkcionalumo nėra.

- `hook-on-stop` — 317 eilučių, savas suite'as, be CLI įėjimo (VQ-701)
- `build-gate`, `release-check`, `milestone-check` — logika `application`, be kvietėjo (E5 likutis)
- `verqestra install` — komanda registre, `templates/` katalogo nėra (VQ-701)
- PostToolUse guard fan-out — portas neprivalomas, tad praleidžiamas TYLIAI (VQ-504 65/N)

**2. Veidrodis: „prijungta prie to, ko nėra."** Nuoroda į kelią, komandą ar failą, kurio šioje
sistemoje neegzistuoja.

- sandbox taisyklės liepė `pnpm --dir AG/orchestrator …` (VQ-703)
- sugeneruotų užduočių ribos rodė į `AG/orchestrator/**` (VQ-703)
- benchmark ataskaitos reprodukcijos komanda `ag benchmark report` (VQ-802)
- `.claude/settings.json` Stop eilutė kvietė neegzistuojantį `hook-on-stop` (VQ-701)

**3. Vartas, kuris visada sako tą patį.** Blogesnis už jo nebuvimą, nes kuria įsitikinimą.

- `ui-app typecheck` (`tsc --noEmit` ant solution tsconfig) — visada žalias, netikrino nieko
- `final-audit` šviežumo patikra — visada „stale", nes du skirtingi „šaltinio" apibrėžimai
- `readiness-audit` komandų skaitytuvas — nematė komandų su komentaru, kaltino README melu

### Kodėl testai jų nerado

Visi trys tipai yra **siūlės**: tarp modulio ir registro, tarp kodo ir aplinkos, tarp dviejų
skaitytojų to paties fakto. Testas įrodo, kad komponentas elgiasi taip, kaip parašyta. Siūlė
neturi savo komponento, tad neturi ir savo testo — ją atidengia tik paleidimas.

Iš to plaukia praktinė taisyklė, užrašyta visose šio darbo anotacijose:
**maršrutas be kliento nėra patikrintas kontraktas.**

## Nukrypimai nuo etalono

Aštuoni, visi užrašyti trijose vietose (commit'as, etalono `tasks.md`,
`migration-coverage.json`), visų kryptis griežtinanti. Pilnas sąrašas su priežastimis —
[`E8-parity.md`](E8-parity.md).

Vienas nukrypimas yra procesinis, ne elgsenos: VQ-003f fixture'as gyvena tik VERQESTRA pusėje,
nes po E0 etalonas tapo read-only. Jo `etalon` reikšmes užrašė recorder'is, paleidęs AG_loop
`dist` — etalono repo nebuvo paliestas nė vienu baitu iki pat VQ-804.

## Kas lieka atvira

| # | Kas | Kodėl neuždaryta |
|---|---|---|
| 1 | **Benchmark kaštų verdiktas** | Užšaldyti baseline dokumentai neturi NĖ VIENO token matavimo (72 sample'ai, visi `deterministic-control`). Palyginimas „VERQESTRA vs AG_loop kaštai" neturi antros pusės. Operatoriui pateikti trys variantai — [`E8-benchmark-audit.md`](E8-benchmark-audit.md) |
| 2 | **`agent-solo` telemetrija** | Režimas kviečia `claude --print`, o voką spausdina tik `benchmark-drive`. 1:1 su etalonu; darbas eilėje (task 008) |
| 3 | **Stop hook ↔ dispatch lenktynės** | VQ-702 atviras radinys: paskutinis commit'as nespėja iki tėvinio proceso pabaigos. Fail-closed, bet reikalauja rankinio užbaigimo. Darbas eilėje (task 002) |

Nė vienas iš trijų nekliudo cutover'iui: pirmi du yra MATAVIMO, ne produkto veikimo klausimai,
o trečias turi teisingą fail-closed kryptį ir įvardytą užduotį.

## Backlog

`backlog-audit: complete` — 13 užduočių, visos 13 kategorijų padengtos, kiekviena eilutė turi
šaltinį (audito radinį arba užrašytą ribą). Sugeneruota per patį produktą
(`verqestra task-generate --change verqestra-backlog-v1`).

## Operatoriaus patvirtinimas

Cutover sprendimas: **operatorius, 2026-08-22 — „užšaldom ir baigiam migraciją".**
VQ-804 įvykdytas tuo pačiu nurodymu; hook'ų atšaukimo kelias paliktas
(`.claude/settings.frozen-backup.json`).
