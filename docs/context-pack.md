# Context pack

Context pack'as yra atsakymas į vienintelį klausimą: **ką agentas mato ir kodėl būtent tai.**
Jis surenkamas iš užduoties, spec fragmentų ir kodo grafo, telpa į vieną biudžetą ir
išsaugomas kaip du artefaktai.

```bash
node dist/cli.js context-pack <task-file> [--with-code-graph]
```

| Artefaktas | Kam |
|---|---|
| `vq/supervisor/context-pack.json` | mašinai: schema-validus paketas |
| `vq/supervisor/execution-context.md` | agentui: prioritetizuotas dokumentas |
| `vq/logs/context-size.jsonl` | telemetrijai: dydžiai, praradimai, kešo būsena |

## Kelias

1. **Task parse** — tikslas, leidžiami keliai, patikros, stop sąlyga, agentų grandinė.
2. **Biudžetas** — `optimizeTokenBudget` iš užduoties dydžio ir klasifikacijos;
   `vq/config/context-budget.json` yra lubos, ne tikslas.
3. **Kešas** — turinio fingerprint'as per užduotį, šaltinius, spec dokumentus, architektūrą ir
   politikas. `hit` grąžina BYTE-IDENTIŠKĄ pack'ą.
4. **Spec fragmentai** — paėmimas → reitingavimas → biudžeto taikymas (būtent tokia tvarka;
   sulieti pirmi du žingsniai reikštų, kad biudžetas leidžiasi surašymo, o ne vertės tvarka).
5. **Kodo grafas** — susiję failai, paliesti testai, simbolių fragmentai.
6. **Vienas biudžeto sprendimas** — visi droppinami šaltiniai varžosi kartą, pagal prioritetą.

## Trys taisyklės, kurias verta žinoti

**`allowed_paths` NIEKADA nekarpomi.** Renderis juos deklaruoja kaip kietą redagavimo ribą;
nukirptas sąrašas paverstų tą deklaraciją melu. `max_files` yra peržiūros slenkstis, ne
karpymo limitas.

**Nepilna specifikacija keliauja su ženklu.** Nukirptas fragmentas pažymimas
(`spec_fragment_truncated`) TAME PAČIAME bloke, ne atskirame įspėjimų sąraše, kurį budgeter'is
išmestų pirmiau už patį fragmentą.

**Retrieved turinys yra DUOMENYS.** Spec fragmentai ir source pjūviai renderinami
`<retrieved_data>` aptvaruose su pasitikėjimo ribos taisykle PRIEŠ turinį. Abejojant elementas
žymimas `untrusted`: klaidingas `untrusted` kainuoja truputį biudžeto, klaidingas `trusted`
įleidžia svetimą tekstą tarp instrukcijų.

## Kešo semantika

Kešo raktas mato DUOMENIS, ne kodą. Pakeitus bet ką, kas veikia pack'o TURINĮ (retrieval,
reitingavimą, biudžetą, `contextPackSchema` laukų prasmę), privaloma pakelti
`CONTEXT_CACHE_VERSION` — kitaip senas įrašas grįš kaip `hit` ir tyliai anuliuos pataisymą.
Renderio pakeitimams kelti nereikia: `execution-context.md` generuojamas iš naujo kiekvieno
`hit` metu.

## Kaip pamatyti, kas nutiko

`context-size.jsonl` neša tris ATSKIRUS praradimų skaičius:

| Laukas | Kuri stadija prarado |
|---|---|
| `dropped_item_count` | vienas prioritetinis biudžeto sprendimas |
| `spec_dropped_count` | retrieval (neišspręsti ref'ai, fragmentų limitas, dublikatai) |
| `code_context_dropped_count` | simbolių kopėčios (contract simbolių numetimas) |

Sulietas skaičius atimtų vienintelį dalyką, dėl kurio metrika naudinga: priskyrimą.

Pariteto kontraktai gyvena `src/tests/fixtures/characterization/context-pack-assembly.json` —
penki atvejai per tmpdir workspace, įskaitant biudžeto arbitražą ir kešo `miss`→`hit`
idempotenciją.
