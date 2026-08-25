# Design

## Approach

Stop hook'o fallback įsijungia tik kai **visos** sąlygos galioja vienu metu (siaurinantis, ne platinantis saugiklis):

1. sesija yra dispatch'inta (`AG_DISPATCH_NONCE` netuščias) — interaktyvioje sesijoje fallback'as išjungtas;
2. planas neturi nė vieno produkto kelio (tik lifecycle) **arba** `git status` turi produkto kelių, kurių plane nėra;
3. **visi** ne-runtime purvini `git status` keliai telpa į aktyvaus task'o `## Failai / Leidžiama` aibę;
4. joks kandidatas nėra įrodytai svetimas (`owners` sidecar'o `foreign`) ir nėra task'o aktyvacijos baseline'o purve.

Sąlyga 3 yra griežtai binarinė: vienas kelias už allowed paths ribų išjungia visą fallback'ą, o ne dalį jo — daline stage'inimu rizikuotume paimti svetimą darbą.

Taisyklė gyvena `session-stage-planning.ts` šalia jau esančio `resolveLedgerGap` (eil. 111-118), naudodama tą pačią funkcijų šeimą, kad nebūtų dubliuotos logikos tarp dviejų saugiklių. Ji lieka gryna (jokio failų sistemos ar git I/O tiesiogiai) — visus duomenis (git status, allowed paths, ownership) gauna kaip parametrus.

## Data Flow

```text
vq/state/current-task-file → task-state-store.ts → parse-task.ts:parseTask → allowedPaths
git status (jau surinktas on-stop-context.ts) → dirty product paths
session-writes.json → ledger paths (esama planSessionStaging įvestis)
                        ↓
on-stop-context.ts:resolveStagePlan → planSessionStaging(input + allowedPaths)
                        ↓ (gryna taisyklė, šalia resolveLedgerGap)
{ paths, fallbackApplied: boolean, fallbackPaths: string[] }
                        ↓
on-stop.ts:logStagingEvidence → "STAGING LEDGER FALLBACK: task=<id> +N files: ..." (kai suveikia)
                        ↓
esamas git add / commit staging mechanizmas (nekeičiamas)
```

## Risks

- **Netikslus allowed paths šaltinis.** Jei `parse-task.ts` grąžina per plačią aibę (pvz. katalogo lygio leidimą), fallback'as gali stage'inti daugiau nei norėta — mitigacija: sąlyga 3 lieka griežtai binarinė (visas arba nieko), o egzistuojantis parseris jau naudojamas kitur be pakeitimų.
- **Dubliavimas su `resolveLedgerGap`.** Abu saugikliai sprendžia panašią problemą skirtingomis sąlygomis (švarus baseline vs. dispatch'inta sesija) — reikia aiškiai atskirti jų suveikimo sritis testuose, kad jie nesusikirstų viena kitos rezultatuose.
- **Tylus platėjimas laikui bėgant.** Kadangi fallback'as liečia stage'inimą, bet koks būsimas jo sąlygų sušvelninimas turi likti matomas per privalomą žurnalo žymą (`logStagingEvidence`) — testas turi tikrinti, kad suveikimas NIEKADA nebūna tylus.
- **R2 lieka atviras.** Šis change nesumažina R2 (commit'as nespėja prieš rollback'ą) rizikos — 018 tipo scenarijus fallback'u savaime neišsisprendžia, nes ten trūkstamų kelių plane nebuvo.
