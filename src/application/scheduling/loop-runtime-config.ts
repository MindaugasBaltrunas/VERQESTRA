// Bendros loop'o vykdymo konstantos.

import { MAX_DISPATCH_WALL_CLOCK_MS } from "../token-governance/turn-budget.js";

/**
 * Bangos slot'o lease gyvavimo trukmė.
 *
 * Invariantas, ne skaičius: TTL privalo pergyventi ILGIAUSIĄ dispatch'ą, kurį konfigas apskritai
 * gali išvesti ({@link MAX_DISPATCH_WALL_CLOCK_MS}), plius atsargą. Iki 2026-09-05 čia gulėjo
 * 3 h literalas su prierašu „dengia visą 100 minučių dispatch'ą" — tiesa numatytajam langui,
 * netiesa konfigui, kurio kompozicinės lubos yra 4 h: lease baigdavosi vaikui dar dirbant, ir
 * `loop-guard` ar antras loop startas jį atlaisvindavo kaip negyvą.
 *
 * Tą pačią reikšmę privalo naudoti abu keliai — slot'o išdavimas ir vaiko atnaujinimas. Dvi
 * skirtingos reikšmės reikštų, kad vienas kelias laiko lease gyvu, o kitas jį jau nurašė:
 * task'as tuo metu turėtų du savininkus.
 *
 * Atnaujinimas vyksta VIENĄ kartą, iškart prieš vaiko paleidimą. Periodinis heartbeat
 * SĄMONINGAI nereikalingas ne dėl atsargos dydžio, o dėl to, kad gyvumo signalas yra savininko
 * PID: `worker-lease-rules.ts#leaseGuardsTask` reikalauja `isLeaseActive && !isLeaseOwnerProcessDead`,
 * tad miręs savininkas atlaisvinamas iškart, nelaukiant TTL. TTL lieka tik fallback'as tam
 * atvejui, kai PID nieko nebepasako — ilgesnis TTL negyvų lease'ų nelaiko.
 */
export const WAVE_SLOT_LEASE_TTL_MS: number = MAX_DISPATCH_WALL_CLOCK_MS + 60 * 60 * 1000;

/** Kiek našlaičių darbo kopijų šalinama per vieną praėjimą; likusios laukia kito rato. */
export const ORPHAN_WORKTREE_REAP_LIMIT = 20;

/**
 * Kopija tampa eskalacijai tinkama tik po tiek laiko nuo sukūrimo.
 *
 * Para yra riba, po kurios „gal dar dirba" nustoja būti tikėtina paaiškinimu: iki jos nešvari
 * kopija paliekama stovėti, nes klaidingai pašalintas neintegruotas darbas yra neatstatomas.
 */
export const ORPHAN_ESCALATION_MIN_AGE_MS = 24 * 60 * 60 * 1000;

/** Archyvo katalogas eskaluotų kopijų diff'ams. */
export const ORPHAN_ARCHIVE_DIR = ["state", "worktree-archive"] as const;
