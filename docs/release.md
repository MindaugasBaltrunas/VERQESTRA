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
