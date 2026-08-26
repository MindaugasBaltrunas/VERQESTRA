# Spec Delta

## Added
- `Candidate.taskDerived?: true` (`render-candidates.ts`) — žyma penkiems kandidatams (`goal`, `acceptance-criteria`, `allowed-paths`, `checks`, `out-of-scope`), kurių `body` yra pilnas 1:1 to paties task failo lauko atspindys.
- `RenderExecutionContextOptions.excludeTaskDerived?: boolean` (`render-execution-context.ts`) — kai `true`, `taskDerived` kandidatai pašalinami iš `buildCandidates(pack)` rezultato PRIEŠ biudžeto metimo ciklą; numatyta reikšmė (nenurodyta arba `false`) elgesio nekeičia.
- `resolveCanonicalWorkerPrompt` (`execution-context-gate.ts`) vidinis žingsnis: kai gate rezultatas yra `attach` ir `input.contextPackText` sėkmingai parsinamas per `contextPackSchema`, prompt'o kontekstas surenkamas iš `renderExecutionContext(pack, { excludeTaskDerived: true }).markdown`, o ne iš `gate.executionContext` tiesiogiai; kitu atveju (parsinimo nesėkmė arba `contextPackText` nėra) naudojamas nepakeistas `gate.executionContext`.

## Changed
- `worker-prompt-compilation.ts` modulio antraštė — papildoma pastaba, kad task-body dubliavimo problema, kurią antraštė vadina „the SAME task twice", nuo šio change'o taikoma ir kontekstinei pusei (ne tik kūno IR/DSL kompresijai); nukrypimas nuo etalono, operatoriaus užsakymas 2026-08-26.
- `execution-context-gate.ts` modulio antraštė — analogiška pastaba apie `resolveCanonicalWorkerPrompt` dedup žingsnį.

## Acceptance Criteria
- Kai `resolveCanonicalWorkerPrompt` gauna `gate.kind === "attach"` IR validų `contextPackText`, grąžintame `prompt` lauke NĖRA `## Goal`, `## Acceptance criteria`, `## Allowed paths`, `## Checks`, `## Out of scope` blokų execution context sekcijoje (jie lieka TIK task kūne — raw arba compiled).
- Vartų (gate) fingerprint/staleness sprendimas (`attach`/`skip`/`refuse`) lieka TAPATUS esamam elgesiui — jis ir toliau skaičiuojamas nuo RAW `input.taskText` ir originalaus `gate.executionContext` disko turinio; jokie testai, tikrinantys `evaluateExecutionContextGate`, nekeičiami.
- Spec fragmentai, `Symbols`/`Contracts`/`Signatures`/`Target source`, `Impacted tests`, `Architecture nodes`/`Architecture boundaries`, `Spec evidence NOT retrieved`, `Spec heading fallbacks` blokai IR toliau atsiranda prompt'o execution context sekcijoje nepakitusia tvarka ir turiniu.
- `TRUST_BOUNDARY_RULE` eilutė lieka ir prieš execution context sekciją `buildWorkerPrompt` išvestyje (`execution-context-gate.ts:279-290`), ir paties konteksto dokumento header'yje (`render-execution-context.ts:231`) — nepašalinama nė vienoje vietoje.
- Kai `contextPackText` trūksta arba jo negalima parsinti pagal `contextPackSchema`, `resolveCanonicalWorkerPrompt` grąžina prompt'ą su NEPAKEISTU, PILNU `gate.executionContext` (dabartinis elgesys) — testas turi šį fallback kelią eksplicitiškai padengti.
- `renderExecutionContext(pack)` (be `excludeTaskDerived`) grąžina baitas-į-baitą TĄ PATĮ `markdown` kaip prieš šį change'ą tam pačiam pack'ui ir `maxChars` — regresinis testas ant bent vieno esamo fixture pack'o.
- Naujas arba atnaujintas testas parodo prompt'o dydžio (chars) sumažėjimą prieš/po dedup ant realaus pavyzdžio (task iš `docs/audits/` audito arba lygiavertis fixture), atspindint `sent_prompt_chars` naudos poveikį.
- `pnpm typecheck && pnpm test` žali; joks esamas `execution-context-gate`, `render-execution-context`, `render-candidates`, `worker-prompt-compilation` testas nesusilpninamas, tik papildomas.
