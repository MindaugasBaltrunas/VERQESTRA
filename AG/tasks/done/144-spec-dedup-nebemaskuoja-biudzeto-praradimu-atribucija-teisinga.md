# Task

## Spec source
openspec/changes/verqestra-backlog-v1/

## Priklausomybės
- 143-pack-semantics-descriptor-apima-visas-derinimo-konstantas
- 138-agentu-grandines-parseris-nebedaro-cipu-is-prozos-zodziu
- 101-discovered-docs-prijungti-su-cache-tapatybe-arba-pasalinti

> 2026-09-02 skėlimas ir scope legalizavimas. Vykdytojas task'ą suskaidė: ši dalis (144-a)
> yra `droppedCount` be `duplicate` ir `CONTEXT_CACHE_VERSION` kėlimas; likusi dedup
> klasifikacija pagal nekirptą turinį ir fazės 1 ref'ų dedup — atskiras task'as
> `144-a-02-144-b-spec-dedup-pagal-nekirpta-turini-po-biudzeto` (queue).
> Diagnozė parkavo dėl `src/tests/context-pack-code-index-identity.test.ts` už `## Failai`
> ribų: jis pin'ina keliamą versiją literalu (etalono 9 taisyklė, įvesta po šio task'o
> parašymo). Darbas iš šakos `ag/worker/f21453c9-…/144-…-7d1e5e76/a1` (commit fbefea2)
> perkeltas į main rankiniu būdu; versija main'e jau buvo 11 (138), tad čia 11 → 12.

## Tikslas
RAG auditas 7 (2026-09-01), radinys R2 (P3): `spec-phase.ts` `droppedCount`
sumuoja ir `duplicate` numetimus, nors lauko dokumentacija sako „PRARASTŲ
ref'ų skaičius" — dublikatas pagal apibrėžimą praradimas nėra; metrika
(`spec_dropped_count`) perdeda. Metrika skaičiuoja `unresolved + dropped BE
duplicate`; `duplicate` numetimai lieka `spec_fragment_warnings`. Elgesys
keičia pack'o turinį, tad `CONTEXT_CACHE_VERSION` keliama.

## Agentai
readme-guard -> debugger -> coder -> reviewer -> tester

## Failai
Leidžiama:
- `src/application/context-pack/assemble/spec-phase.ts`
- `src/application/context-pack/context-cache-model.ts` (TIK
  `CONTEXT_CACHE_VERSION` kėlimas su istorijos įrašu)
- `src/tests/context-pack-spec-dropped-count.test.ts` (naujas)
- `src/tests/context-pack-guards.test.ts` (versijos pin'as)
- `src/tests/context-pack-code-index-identity.test.ts` (versijos pin'as;
  pridėta 2026-09-02 legalizuojant scope)

Draudžiama:
- `src/application/code-intelligence/retrieval/spec-fragments.ts` (144-b)
- `src/tests/code-intelligence.test.ts` (144-b)
- `src/tests/context-pack-rag-audit-4.test.ts` (144-b)
- `src/tests/context-pack-assemble.test.ts` (101 scope)
- `src/application/context-pack/context-cache-key.ts` (143 scope)
- `dist/**`
- `node_modules/**`

## Veiksmas
- `spec-phase.ts`: `droppedCount` skaičiuoja `unresolved + dropped BE duplicate`.
- `context-cache-model.ts`: `CONTEXT_CACHE_VERSION` +1 su istorijos įrašu, kodėl
  senas įrašas meluotų (kitas `spec_dropped_count` tam pačiam task'ui).
- Testai: naujame faile `duplicate` numetimas metrikos nepadidina, o
  `unresolved`/`char_budget` skaičiuojami; abu versijos pin'ai atnaujinti.

## Patikra
- `pnpm build`
- `pnpm test`

## Stop
Commit'ink, kai patikros žalios.

## Neįtraukta
- Dedup klasifikacija pagal nekirptą turinį ir fazės 1 ref'ų dedup — 144-b.
- `MAX_SPEC_RETRIEVAL_WARNINGS` lubų dydis ir `WARNING_SEVERITY` tvarka —
  nekvestionuojami.
