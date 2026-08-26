# Design

## Approach
1. **Žymėjimas šaltinyje, ne pavadinimu.** `render-candidates.ts` `Candidate` tipui pridedamas neprivalomas laukas `taskDerived?: true`. Jį gauna lygiai penki kandidatai, kurių `body` yra 1:1 to paties task failo laukas: `goal`, `acceptance-criteria` (įsk. stop condition eilutę), `allowed-paths`, `checks`, `out-of-scope`. `buildCandidates` grąžinamo sąrašo TVARKA ir TURINYS nesikeičia — pridedamas tik metaduomenų laukas, kurio disko rendereris iki šiol nenaudojo.
2. **Antra, siauresnė kandidatų projekcija — tik prompt'ui.** `render-execution-context.ts` `RenderExecutionContextOptions` gauna `excludeTaskDerived?: boolean` (numatyta `false`/nebuvimas = esamas elgesys). Kai `true`, `buildCandidates(pack)` rezultatas prieš patenkant į drop-budget ciklą filtruojamas: `taskDerived === true` elementai pašalinami PRIEŠ `DROP_ORDER` logiką (jie niekada net netampa kandidatais budžetavimui, ne "numesti" — `context.dropped` jų NETURI, nes jie nebuvo bandyti dėti). Kadangi pašalinimas tik MAŽINA dokumentą, `maxChars` sprendimas (`resolveMaxChars`) lieka identiškas — joks papildomas simbolis niekada netaps trūkstamas, `throw` sąlyga (5 non-droppable) tampa dar sunkiau pasiekiama, ne lengviau, nes `allowed-paths`/`checks`/`acceptance-criteria`/`goal` yra ir taip `critical` = jau anksčiau niekada nebuvo droppable — jų pašalinimas iš `kept` prieš ciklą pakeičia tik tai, KUR jie gyvena (prompt'o kūne, o ne kontekste), o ne bendrą kritinio turinio kiekį, kurį worker'is gauna.
3. **Sujungimo vieta — `resolveCanonicalWorkerPrompt`.** Ši funkcija JAU turi `input.contextPackText` (naudojamas fingerprint/staleness tikrinimui per `contextPackSchema.safeParse` `packMayCarrySourceSlices` viduje). Kai `gate.kind === "attach"`: (a) fingerprint/staleness validacija PALIEKAMA nepakeista — ji ir toliau vyksta prieš `gate.executionContext` (originalų, PILNĄ disko artefakto turinį per `evaluateExecutionContextGate` → `validateExecutionContext`), nes pasitikėjimo grandinė (task_sha256, context_pack_sha256, stale source slices) turi likti pririšta prie realaus disko turinio, ne prie perskaičiuoto varianto; (b) TIK sujungimo su `taskText`/`compiledTask` metu, jei `contextPackText` egzistuoja ir sėkmingai parsinamas per `contextPackSchema.safeParse`, iškviečiamas `renderExecutionContext(pack, { excludeTaskDerived: true })` ir jo `markdown` (o ne `gate.executionContext`) perduodamas į `buildWorkerPrompt`. Jei `contextPackText` trūksta arba neparsinamas — kritimas atgal (fallback) prie NEPAKEISTO `gate.executionContext`: joks turinys niekada tyliai neprarandamas, blogiausiu atveju grįžtama prie šiandienos elgesio.
4. **Artefaktas diske nesikeičia.** Bet koks kodas, kuris kviečia `renderExecutionContext(pack)` BE naujos parinkties (t. y. disko rašymo kelias context-pack surinkimo pipeline'e — už leidžiamų failų ribos) gauna baitas-į-baitą tą patį `markdown`, nes numatyta reikšmė nefiltruoja nieko. `CONTEXT_CACHE_VERSION` kelti NEREIKIA (4-as invariantas iš užduoties).
5. **Antraščių atnaujinimas.** `worker-prompt-compilation.ts` ir `execution-context-gate.ts` viršutiniai komentarai papildomi pastaba, kad nuo 2026-08-26 (operatoriaus užsakymu) prompt'o KŪNAS ir pridedamas KONTEKSTAS nebeneša tų pačių task-derived laukų du kartus — tai nukrypimas nuo etalono, kuris šią dublė laikė norma.

## Data Flow
```text
ContextPack (jau turimas contextPackText)
        |
        v
 buildCandidates(pack)  -- nekeičiama tvarka/turinys, + taskDerived žyma 5 elementams
        |
        +--> [disko kelias, UŽ scope ribų]
        |         renderExecutionContext(pack)                → execution-context.md (nepakitęs)
        |
        +--> [PROMPT kelias, resolveCanonicalWorkerPrompt viduje]
                  gate = evaluateExecutionContextGate(input)   -- validacija prieš PILNĄ gate.executionContext
                  jei gate.kind === "attach":
                      pack = contextPackSchema.safeParse(input.contextPackText)
                      jei sėkmė: promptContext = renderExecutionContext(pack, {excludeTaskDerived:true}).markdown
                      jei nesėkmė: promptContext = gate.executionContext  (fallback, be pakeitimų)
                  buildWorkerPrompt({ taskText, compiledTask?, executionContext: promptContext })
```

## Risks
- **Fallback tylumas.** Jei `contextPackText` nuolat nepasiekiamas konkrečiam dispatch paviršiui, dedup niekada neįsijungia ir sutaupymo nebus, bet TESTAS turi šį fallback kelią patikrinti eksplicitiškai (kad tyli degradacija būtų matoma testuose, ne tik produkcijoje).
- **`maxChars` dreifas.** Jei kada nors `renderExecutionContext` disko iškvietimas pradės perduoti eksplicitinį `options.maxChars`, kuris skiriasi nuo `resolveMaxChars(pack, {})` numatytosios reikšmės, prompt'o pusės re-renderis (kviečiamas be `maxChars` override) gali naudoti kitokį limitą nei disko artefaktas. Šiuo metu tokio override'o call site'uose (matyti iš `resolveMaxChars` panaudojimo) nėra — rizika dokumentuojama, ne sprendžiama šiuo change'u.
- **Antraštės teksto grifas.** `render-execution-context.ts` `renderDocument` header'is turi eilutę `elements: N kept, M dropped` — kai `excludeTaskDerived: true`, task-derived elementai NĖRA `kept` sąraše, tad `N` sumažėja, bet jie taip pat NĖRA `dropped` (jie niekada nebuvo `candidates` sąraše šiam renderiui). Tai teisinga semantiškai (jie nebuvo "numesti dėl biudžeto"), bet reviewer'is turi patikrinti, kad tekstas neklaidina skaitytojo, jog trūksta turinio dėl per mažo limito.
- **Dviguba fingerprint verifikacija skirtingiems `markdown` turiniams.** `computeFingerprint` viduje esantis fingerprint'as (rodomas paties dokumento header'yje) SKIRSIS tarp disko ir prompt'o varianto, nes elementų rinkinys skiriasi — tai TYČIA (skirtingi dokumentai), bet reikia patikrinti, kad joks kodas UŽ leidžiamų failų ribų nebando lyginti prompt'e esančio fingerprint'o su disko artefakto fingerprint'u kaip lygybės invarianto (gate validacija to nedaro — ji naudoja `<!-- ag:execution-context ... -->` markerį, kuris NIEKADA nekeičiamas šiuo change'u, žr. `execution-context-fingerprint.ts`).
