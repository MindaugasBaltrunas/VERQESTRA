// Bendros loop'o vykdymo konstantos.

/**
 * Bangos slot'o lease gyvavimo trukmė.
 *
 * Ji dengia visą 100 minučių dispatch'ą PLIUS atsargą, ir tą pačią reikšmę privalo naudoti abu
 * keliai — slot'o išdavimas ir vaiko atnaujinimas. Dvi skirtingos reikšmės reikštų, kad vienas
 * kelias laiko lease gyvu, o kitas jį jau nurašė: task'as tuo metu turėtų du savininkus.
 *
 * Atnaujinimas vyksta iškart prieš vaiko paleidimą. Periodinis heartbeat SĄMONINGAI nereikalingas,
 * kol vaiko vykdymo trukmė lieka žemiau pusės šios TTL.
 */
export const WAVE_SLOT_LEASE_TTL_MS: number = 3 * 60 * 60 * 1000;

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
