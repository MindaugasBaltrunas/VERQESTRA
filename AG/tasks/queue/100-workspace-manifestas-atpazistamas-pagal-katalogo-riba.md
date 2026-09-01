# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/application/code-intelligence/code-map/index-projection.ts`
`packageDirectories` (dabar 83 eil.) tikrina katalogo ribą — t. y.
`file.path === "package.json" || file.path.endsWith("/package.json")` (ar
ekvivalentiška basename patikra) vietoj plikos
`file.path.endsWith("package.json")` — IR egzistuoja testas, kad
`foo/notpackage.json` NEsukuria darbo srities — ALREADY_IMPLEMENTED: cituok
pataisytą eilutę ir testo assert'us kaip įrodymą.

## Tikslas
Workspace manifestas atpažįstamas pagal netikslų suffix'ą (patikrinta
2026-09-01, `src/application/code-intelligence/code-map/index-projection.ts`):
`packageDirectories` 83 eil. — `if (!file.path.endsWith("package.json"))
continue;` — suffix'as be katalogo ribos atitinka ir `foo/notpackage.json`,
`mypackage.json` ir pan. Pasekmės mechanizmas (operatoriaus reprodukcija
2026-09-01, patvirtinta prieš `layerForPath` 97-105 eil.):
`foo/notpackage.json` klaidingai įtraukia `foo` į darbo sričių sąrašą; tada
`foo/src/a.ts` gauna owner=`foo`, `src/` prefiksas nusiimamas, liekana `a.ts`
be `/` → segmentas `root` → sluoksnis tampa `foo/root` vietoj `foo`.
Klaidingas sluoksnis keičia diagramos struktūrą ir aprėpties matavimą.
Pataisymo kryptis: basename lygybė — `file.path === "package.json" ||
file.path.endsWith("/package.json")`; kelias indekse yra POSIX formos (žr.
`toPosixPath` naudojimą 98 eil.), tad `/` riba pakanka. Tai atskiras defektas
nuo 098 (briaunų aprėpties) — liečia kitą failą ir kitą mechanizmą.

## Agentai
readme-guard -> debugger -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/code-intelligence/code-map/index-projection.ts`
- `src/tests/code-intelligence-index-projection.test.ts` (numatomas naujas —
  SĄMONINGAI atskiras nuo `code-intelligence-code-map.test.ts`, kurį
  lygiagrečiai deklaruoja task 098; jei konvencija pareikalautų kito vardo —
  tas failas vietoje šio, įrašyti į ataskaitą, bet NE
  `code-intelligence-code-map.test.ts`)

Draudžiama:
- `src/tests/code-intelligence-code-map.test.ts` (deklaruotas task 098 —
  bendras kelias atimtų lygiagretumą)
- `src/application/code-intelligence/code-map/coverage.ts` ir `generator.ts`
  (task 098 scope)
- `src/application/code-intelligence/indexing/**` (indekso statyba neliečiama)
- `dist/**`
- `node_modules/**`

## Veiksmas
- `src/application/code-intelligence/code-map/index-projection.ts`
  (`packageDirectories`, 83 eil.): pakeisti suffix patikrą į basename lygybę su
  katalogo riba (`file.path === "package.json" ||
  file.path.endsWith("/package.json")`).
- `src/tests/code-intelligence-index-projection.test.ts` (naujas): testų
  lūkestis — (1) regresija: indekso failas `foo/notpackage.json` NEsukuria
  darbo srities, t. y. `foo/src/a.ts` sluoksnis lieka `foo` (per
  `projectCodeMapFromIndex` arba `layerForPath` su išvestu sąrašu);
  (2) tikras `foo/package.json` darbo sritį sukuria — `foo/src/a.ts` →
  `foo/<segmentas>`; (3) šaknies atvejis: `package.json` be katalogo toliau
  duoda šaknies darbo sritį (esamas elgesys nelūžta).

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei pataisius patikrą
`pnpm test` atskleistų, kad koks nors ESAMAS testas ar fixture rėmėsi
klaidingu suffix elgesiu (pvz. tyčinis `*package.json` vardas fixture) — tai
reikštų, kad kas nors vartoja bug'ą kaip elgesį.

## Neįtraukta
- `layerForPath` logikos keitimai — algoritmas teisingas, klaidingas tik jo
  įėjimo (`packages`) išvedimas.
- Briaunų aprėpties matavimas (`coverage.ts`/`generator.ts`) — atskiras
  defektas, task 098.
- Esamų `layerForPath` testų perkėlimas iš
  `code-intelligence-code-map.test.ts` į naują projekcijos testų failą —
  paliekama kaip yra, kad nesikirstų su 098 scope; konsolidacija galima
  atskiru task'u, kai abu uždaryti.
