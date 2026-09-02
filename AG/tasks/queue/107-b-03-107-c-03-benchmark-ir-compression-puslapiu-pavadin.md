# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- 107-a-02-107-b-02-header-prekes-zenklas-nustoja-buti-h1-das

## Žingsnis 0 — ar jau įgyvendinta?
Jei `BenchmarkPage.tsx` (dabar 131-134 eil.) ir `CompressionPage.tsx` (dabar 154-157 eil.)
page-heading pavadinimai jau yra `<h1>` — ALREADY_IMPLEMENTED: cituok abu JSX blokus.

## Tikslas
Tęsti UI audito P2 uždarymą: po to, kai prekės ženklas nustojo būti `h1`, šie du maršrutai
laikinai neturi jokio `h1`. Jų page-heading pavadinimai turi tapti vieninteliu puslapio `h1`.
CSS `.page-heading h1` selektoriai jau egzistuoja — vizualinė išvaizda nesikeičia.

## Agentai
PRIVALOMA grandinė: readme-guard -> architect -> coder -> reviewer -> tester.

## Failai
Leidžiama:
- `ui-app/src/view/pages/BenchmarkPage.tsx`
- `ui-app/src/view/pages/BenchmarkPage.test.tsx`
- `ui-app/src/view/pages/CompressionPage.tsx`
- `ui-app/src/view/pages/CompressionPage.test.tsx`
- `ui-app/src/view/styles/dashboard.css` (jau paruoštas anksčiau; tikėtina, kad naujų taisyklių čia nereikės)
- `ui-app/src/i18n/I18nContext.tsx` (tikėtina, kad keisti nereikės: keičiasi tik elemento semantika)

Draudžiama:
- `ui-app/src/view/accessibility.test.tsx` (priklauso 107-a-02)
- `ui-app/src/view/pages/ReliabilityPage.tsx`
- `dist/**`
- `node_modules/**`

## Veiksmas
- `BenchmarkPage.tsx` page-heading pavadinimo elementą iš `h2` į `h1`.
- `CompressionPage.tsx` page-heading pavadinimo elementą iš `h2` į `h1`.
- Jei puslapių testai assert'ina heading lygį — atnaujink lygį; panelių `h2` nelieskite.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros žalios. Testų silpninti draudžiama — keičiasi tik lygio
skaičius. Jei tame pačiame puslapyje atsiranda antras `h1` — sustok ir pranešk.

## Neįtraukta
- `ReliabilityPage`, `TokenUsagePage` — sekantis darbas.
- Panelių `panel-header h2` hierarchija.
- Pilnas WCAG antraščių auditas.
