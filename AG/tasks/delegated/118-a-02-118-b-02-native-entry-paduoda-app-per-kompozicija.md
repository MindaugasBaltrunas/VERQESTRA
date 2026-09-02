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

## Priklausomybes
- 118-native-shell-paleidzia-app-su-realiais-portais (native-runtime kompozicijos modulis)

## Tikslas
`mobile-app/native/index.js:6` registruoja App be jokiu props, o `App.tsx` 42-45 eil. komentaras
zada adapterius, kurie niekada neatsirado. Sis darbas padaro entry point'a injekcijos tasku:
registruojamas App gauna props is 118 sukurtos native kompozicijos, o komentaras ivardija realia
busena. Portu ciа NEkonstruoji ir nefeikini: jei kompozicija kokio porto dar neduoda (read portu
adapteriu nera; credentials/writeGate/speech - task'ai 119-121), ekranai toliau saziningai sako, ko
truksta - tai dizainas, ne bug'as.

## Agentai
Privaloma grandine: readme-guard -> architect -> coder -> reviewer -> tester.

## Failai
Leidziama:
- `mobile-app/native/index.js`
- `mobile-app/native/src/App.tsx`
- `mobile-app/native/src/tests/native-shell-scaffold.test.ts`

Draudziama:
- `mobile-app/native/src/composition/native-runtime.ts`
- `mobile-app/native/src/core.ts`
- `mobile-app/src/**`

## Veiksmas
- index.js: registerRootComponent gauna App su native kompozicijos sukonstruotais props (wrapper
  komponentas arba bind - tavo pasirinkimas), isaugant CommonJS entry pastaba 1-2 eil.
- App.tsx: pakeisk TIK 42-45 eil. komentara - jis nebezada "remaining adapter tasks", o ivardija
  realia busena (transportai uzvielinti per kompozicija; read portu adapteriu dar nera;
  writeGate/credentials/speech - 119-121). AppProps kontraktas nekinta.
- native-shell-scaffold.test.ts atnaujink taip, kad jis tikrintu entry kelia per kompozicija, be
  jokio silpninimo. Papildomai paleisk pnpm test:mobile-native ir irasyk rezultata i ataskaita.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai abi patikros ir mobile native testai zali. Stop ir klausk, jei entry point'ui
pasirodytu butina keisti AppProps kontrakta arba imti nauja dependency.

## Neitraukta
- Read portu HTTP adapteriai (mobile-app/src) - atskiras task'as.
- expo-secure-store, biometrika, speech adapteriai - task'ai 119, 120, 121.
