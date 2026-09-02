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

## Priklausomybės
- 101-discovered-docs-prijungti-su-cache-tapatybe-arba-pasalinti

## Žingsnis 0 — ar jau įgyvendinta?
Jei `src/domain/policies/agent-selection.ts` `parseAgentBlock` legacy šaka
(dabar 102-108 eil.) frazei „PRIVALOMA grandinė šia tvarka: readme-guard ->
documenter -> reviewer" grąžina LYGIAI `["readme-guard", "documenter",
"reviewer"]` (be „privaloma"/„grandinė"/„šia"/„tvarka:" tokenų) ir tai
pin'ina testas — ALREADY_IMPLEMENTED: cituok parse kodą ir testo assert'ą
kaip įrodymą.

## Tikslas
Gyvas įrodymas (2026-09-01 ~18:0x, Apžvalgos „Aktyvus vykdymas" 097
dispatch'e): agentų grandinės juosta rodo čipus `privaloma → grandinė → šia
→ tvarka: → readme-guard → documenter → reviewer` — pirmi keturi yra task'o
teksto SAKINIO ŽODŽIAI, ne agentai. Šaknis patikrinta ir yra DOMAIN pusėje
(UI nekaltas — `AgentChainProgress` sąžiningai renderina tai, ką gauna):
`parseAgentBlock` (`src/domain/policies/agent-selection.ts:80-110`) legacy
šaka 104 eil. kiekvieną `parseAgentChain` strėlių segmentą DAR skaido per
whitespace (`.flatMap((part) => part.split(/\s+/))`), tad segmentas
„PRIVALOMA grandinė šia tvarka: readme-guard" virsta penkiais „vaidmenimis";
`TRAILING_PROSE` (55 eil.) kerpa tik nuo `.`/`;`/`(`, o dvitaškis 53-54 eil.
komentare deklaruotas kaip „etiketės skirtukas, po kurio eina pats agentas"
— bet VEDANČIOS etiketės nukirpimo implementacijos NĖRA. Pasekmės dviejose
vietose: (1) UI grandinė — `parseChainFromTaskFile`
(`interfaces/ui-model/agent-activity.ts:42-45`) grąžina
`[primary, ...supporting]` žalią; (2) pack'o `agents` laukas
(`assemble.ts:123-129` → `context-pack-schema.ts:133`) užsiteršia prozos
tokenais. Routing'as NEnukenčia — `effectiveAgentRole`/
`validateAgentSelection` (120-133) filtruoja per registrą, todėl klaida
matoma tik vaizde ir pack'e. Kryptis: laisvo teksto žodžiai NIEKADA netampa
grandinės nariais — strėlėtame segmente agentas yra tik po paskutinio
dvitaksio/etiketės (dokumentuotos 53-54 intencijos implementacija), o
prozos eilutės be strėlių nebegimdo rolių sąrašo iš kiekvieno žodžio;
alternatyva/priedas — žinomų agentų allowlist filtras projekcijoje (kaip
`knownRoles` daro validacijai). KEŠO PAREIGA: `agents` yra pack'o turinio
laukas, o parse pakeitimas yra LOGINIS — tas pats task tekstas duos kitą
pack'ą, tad pagal CLAUDE.md „Pack'o semantika ir kešas" privaloma pakelti
`CONTEXT_CACHE_VERSION` (todėl priklausomybė nuo 101, kuris deklaruoja tą
patį `context-cache-model.ts`).

## Agentai
readme-guard -> debugger -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/domain/policies/agent-selection.ts`
- `src/tests/domain-policies.test.ts`
- `src/interfaces/ui-model/agent-activity.ts` (tik jei pasirenkamas
  papildomas allowlist sluoksnis projekcijoje; kitaip neliečiamas)
- `src/tests/interfaces-ui-model-agent-activity.test.ts` (regresija su
  realia fraze)
- `src/application/context-pack/context-cache-model.ts` (TIK
  `CONTEXT_CACHE_VERSION` kėlimas su komentaro eilute apie priežastį)

Draudžiama:
- `ui-app/**` (UI pusė teisinga — renderina gautą grandinę; jokių hotspot
  failų, task'as laisvas nuo 104-110/137 grandinės)
- `src/application/context-pack/assemble/assemble.ts` (vartotojas — jo
  kontraktas nekinta)
- Kiti `parseAgentBlock` vartotojai
  (`src/application/quality-gates/preflight.ts`,
  `src/application/task-execution/adapter-routing.ts`) — elgesys jiems tik
  švarėja, kodo keisti nereikia
- `dist/**`
- `node_modules/**`

## Veiksmas
- `agent-selection.ts`: legacy šakos (102-108) ir/ar `parseAgentChain`
  token valymo pataisa pagal Tikslo kryptį — būtini elgesio taškai:
  (1) „PRIVALOMA grandinė šia tvarka: a -> b -> c" → `[a, b, c]`;
  (2) kv formos (`primary: coder`) ir esamos legacy formos (pliki vardai,
  bullet'ai, emfazė, kableliai) elgiasi kaip iki šiol — 42-49 eil.
  taisyklės ir „baitinis kontraktas" klaidų tekstuose (138-139 komentaras)
  nekinta; (3) prozos sakinys be strėlių (pvz. „readme-guard eina pirmas ir
  grąžina ribų santrauką.") nebeišskaido kiekvieno žodžio į roles —
  sprendimo forma (vedančios etiketės kirpimas / whitespace split tik
  ne-strėlėtoms trumpoms eilutėms / allowlist) — vykdytojo, su doc
  komentaru, atnaujinančiu 51-55 eil. intencijos aprašą.
- `CONTEXT_CACHE_VERSION` (+1) su priežasties komentaru — loginis pack
  turinio (`agents`) pakeitimas, hash'ai jo nemato.
- Testų lūkestis: (1) `domain-policies.test.ts` — reali incidento frazė →
  tik trys agentai; prozos sakinys be strėlių → jokių prozos tokenų;
  esamos formos (kv, bullet, emfazė, kableliai) baitiškai nepakitusios;
  (2) `interfaces-ui-model-agent-activity.test.ts` — task tekstas su
  incidento fraze → `chain` be prozos čipų; (3) esami agentų atrankos ir
  validacijos testai žali be silpninimo.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios. Stop ir klausk, jei pataisa neišvengiamai
keistų `validateAgentSelection` klaidų tekstus (jie deklaruoti kaip baitinis
kontraktas) arba jei paaiškėtų vartotojas, kuris SĄMONINGAI remiasi prozos
tokenais selection'e.

## Neįtraukta
- UI (`AgentChainProgress`) pakeitimai — komponentas teisingas; užbaigtos
  būsenos klausimas — 106 task'as.
- `## Agentai` sekcijų turinio valymas esamuose task failuose — parseris
  privalo atlaikyti istorinę prozą, ne reikalauti jos perrašymo.
- Agentų registro (`vq/config/agents.json` / `.claude/agents/*.md`)
  turinio keitimai — allowlist šaltinis, jei naudojamas, imamas esamas.
