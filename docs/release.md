# Release

Išleidimas VERQESTRA'oje yra vartų grandinė, o ne sprendimas. Kiekvienas vartas atsako į vieną
klausimą ir palieka artefaktą, kurį galima perskaityti vėliau.

## Grandinė

| Komanda | Klausimas | Artefaktas |
|---|---|---|
| `build-gate` | ar `dist` atitinka `src` | exit kodas + ataskaita |
| `quality-gates` | ar sukonfigūruotos patikros žalios | `vq/state/quality-gates-status.json` |
| `security-verify` | ar pakeisti failai nepažeidžia saugumo politikos | `vq/state/security-verify-result.json` |
| `spec-drift` | ar pakeitimai telpa į spec scope | `vq/state/spec-drift-result.json` |
| `milestone-check` | ar milestone pasiektas | `vq/state/milestone-check-result.json` |
| `release-check` | ar galima pakuoti | `vq/state/release-check-result.json` |
| `readiness-audit` | ar produktas apskritai pilnas | `vq/state/readiness-audit-result.json` |
| `final-audit` | galutinis verdiktas iš visų aukščiau | `vq/state/final-audit-result.json` |

## build-gate

Hook'ai ir loop vaikai vykdo NE `src`, o `dist`. Pasenęs `dist` reiškia, kad procesas paklūsta
kodui, kurio niekas nebeturi. Vartas NIEKADA neperstato pats — vartas, kuris pataiso savo paties
radinį, sunaikina įrodymą ir pakeičia medį po operatoriaus kojomis. Jis tik praneša:

```bash
node dist/cli.js build-gate   # 0 = šviežias, 1 = pasenęs, 2 = klaida
```

Stale ataskaita eina į `stderr`: tai gedimo pranešimas, o CI `stdout` skaito kaip duomenis.

## release-check

```bash
node dist/cli.js release-check
```

Penkios dalys: `build`, `tests`, `milestone`, `docs`, `package_layout`. Dvi savybės, kurias
verta žinoti:

- Milestone dalis NEPERLEIDŽIA kokybės vartų. `release-check` ką tik pastatė ir ištestavo tą
  patį medį; antras paleidimas kainuotų visą build'ą ir galėtų duoti KITĄ atsakymą tam pačiam
  medžiui.
- `source_state` yra viso šaltinio hash'as. Jis leidžia vėliau pasakyti, ar verdiktas vis dar
  aprašo TĄ medį, ar jau pasenęs.

### release-check CI'uje

`.github/workflows/ci.yml` turi ATSKIRĄ `release-check` job'ą, ne dar vieną `test` job'o žingsnį:

```yaml
- run: pnpm install --frozen-lockfile
- run: pnpm build                      # dist/cli.js — vartas paleidžiamas iš jo
- run: node dist/cli.js release-check  # 0 = ok, 1 = failed, 2 = klaida
```

Trys priežastys, kodėl atskirai:

- `release-check` PATS paleidžia `pnpm build` ir `pnpm test:compiled`. `test` job'e jis
  perstatytų medį, kuris ką tik buvo pastatytas ir ištestuotas — antras build'as toje pačioje
  eilėje nieko naujo neįrodo. Atskiras job'as tuos pačius du paleidimus daro lygiagrečiai.
- Klausimas kitas: `test` klausia „ar kodas veikia", `release-check` — „ar galima pakuoti".
  Suplakti į vieną, raudonas `package_layout` atrodytų kaip krentantis testas.
- Verdiktas tikslesnis už exit kodą, tad `vq/state/release-check-result.json` keliauja į
  artefaktus su `if: always()`. Be `always()` jis nebūtų įkeltas būtent tada, kai reikalingas.

Švariame klone `milestone` dalis lieka lengva savaime: `AG/spec/changes` ir `vq/` nėra
versijuojami, tad `spec_alignment` ir `local_policy` gauna tuščią scope ir pažymimi `skipped`,
o `quality` ateina iš to paties build'o ir testų exit kodų.

## readiness-audit

Skirtingai nuo kitų, šis vartas matuoja produkto PILNUMĄ, ne pakeitimo kokybę: aplankai,
konfigai, dokumentuotos komandos, testai, docs. Jis sąmoningai sako „dar ne", kol ko nors
trūksta — priešingu atveju jis tik patvirtintų tai, kas jau yra.

Komandų dalis tikrina DVI kryptis: README, siūlantis komandą, kurios nėra
(`implementation:<vardas>`), ir registras, turintis komandą, kurios README nemini
(`documentation:<vardas>`). Abu yra melas operatoriui, tik iš skirtingų pusių.

## Paketo forma

`package.json` `files` sąrašas yra kontrakto dalis: be jo `npm pack` išsiųstų ir `src`, ir
testus, o be `!dist/tests` — dar ir sukompiliuotą testų balastą. `release-check` tikrina ir
sąrašą, ir tai, kad kiekvienas jo įrašas turi atitikmenį diske: deklaruotas, bet neegzistuojantis
kelias tyliai iškristų iš tarball'o.

## Kai vartas raudonas

Pirmas klausimas ne „kaip apeiti", o „ką jis pamatė". Kiekvienas vartas rašo verdikto failą su
`issues` sąrašu; jis tikslesnis už exit kodą. Testai neweakinami, kad praeitų: jei testas
teisus, o kodas ne — taisomas kodas.
