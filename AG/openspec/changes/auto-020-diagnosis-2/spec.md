# Spec Delta

## Added

- Nauja gryna fallback taisyklė `session-stage-planning.ts` viduje (šalia `resolveLedgerGap`, eil. ~111-118 aplinkoje): priima `dispatchNonce`, esamą planą, `gitStatusPaths` (ne-runtime purvūs produkto keliai), `allowedPaths` ir ownership/baseline informaciją; grąžina fallback kandidatų sąrašą arba tuščią, jei bent viena iš 4 sąlygų neįvykdyta.
- Naujas `allowedPaths` laukas `planSessionStaging` įvesties tipe, užpildomas `on-stop-context.ts:resolveStagePlan` iš `vq/state/current-task-file` per esamą `task-state-store.ts` + `parse-task.ts:parseTask`.
- Nauja žurnalo eilutė `on-stop.ts:logStagingEvidence` viduje: `STAGING LEDGER FALLBACK: task=<id> +N files: <paths>` — rašoma kiekvieną kartą, kai fallback'as pritaikomas (be išimčių, negrupuojama, negesinama).

## Changed

- `session-stage-planning.ts:planSessionStaging` grąžinamas tipas praplečiamas informacija apie tai, kurie keliai pateko per fallback'ą (kad `on-stop.ts` turėtų ką logint), nekeičiant esamo `resolveLedgerGap`/ledger elgesio.
- `on-stop-context.ts:resolveStagePlan` (eil. ~135-161) praplečiamas: papildomai skaito `current-task-file`, parse'ina allowed paths ir perduoda juos į `planSessionStaging` kartu su jau egzistuojančia įvestimi.

## Acceptance Criteria

1. **Teigiamas (018 regresijos) scenarijus:** `dispatchNonce` netuščias, `sessionWrites` tuščias, `git status` turi 2 produkto kelius, abu telpa į aktyvaus task'o allowed paths → abu keliai patenka į grąžintą `paths` aibę IR pažymimi kaip fallback kandidatai; `logStagingEvidence` parašo `STAGING LEDGER FALLBACK` eilutę su abiem keliais.
2. **Neigiamas (siaurinimo) scenarijus:** ta pati sąranka, bet vienas iš 2 purvinų kelių yra **už** allowed paths ribų → fallback'as neįsijungia **visiškai** (nė vienas iš 2 kelių nepatenka per fallback'ą), o ne dalinai (t. y. nebūna taip, kad vienas pridedamas, o kitas ne).
3. **Interaktyvios sesijos scenarijus:** `dispatchNonce` tuščias → fallback'as neįsijungia nepriklausomai nuo kitų sąlygų.
4. **Foreign/baseline dirt scenarijus:** kandidatas pažymėtas kaip `foreign` ownership sidecar'e arba yra task'o aktyvacijos baseline'o purve → fallback'as jo neįtraukia (net jei kitos sąlygos tenkinamos).
5. **Tylumo draudimas:** kiekvienas fallback'o suveikimas privalo turėti atitinkamą žurnalo eilutę testų aplinkoje (grep'inamas string `STAGING LEDGER FALLBACK`); testas turi patikrinti, kad be suveikimo šios eilutės nėra.
6. Nė vienas iš esamų `resolveLedgerGap` ar clean-baseline rescue testų nesulaužomas — abu saugikliai lieka nepriklausomi ir toliau veikia savo esamose sąlygose.
