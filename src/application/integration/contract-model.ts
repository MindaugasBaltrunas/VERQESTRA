// Contract diff duomenų kontraktai — bendri scan/extract/diff moduliams (atskirtas nuo
// contract-diff.ts, kad ekstraktorių importai nesudarytų ciklo). Behaviour etalon: AG_loop
// application/integration/contract-diff.ts tipų blokas (1:1).

export type ContractKind =
  /** TypeScript eksportuojamas simbolis (funkcija, tipas, interface, klasė, konstanta, re-eksportas). */
  | "ts-export"
  /** HTTP maršrutas: metodas + kelias. */
  | "api-route"
  /** Konfigūracijos raktas ir jo reikšmės tipas. */
  | "config-key"
  /** DB lentelė/modelis ir jo stulpeliai/laukai. */
  | "db-entity"
  /** Migracijos failas ir jo teiginiai. */
  | "db-migration";

export type ContractRevision = "before" | "after";

export type ContractSourceFile = {
  /** Repo-relative kelias (POSIX). */
  path: string;
  /**
   * Failo turinys toje revizijoje. `undefined` reiškia „failas revizijoje YRA, bet turinys
   * neprieinamas" — tai NĖRA tas pat, kas failo nebuvimas sąraše (tada failas revizijoje
   * neegzistavo). Pirmasis virsta `unverified`, antrasis — teisėtu pridėjimu/pašalinimu.
   */
  text?: string;
};

export type ContractDescriptor = {
  kind: ContractKind;
  /** Tapatybė tarp revizijų. Nesutampantis `id` reiškia kitą kontraktą, o ne pakeistą. */
  id: string;
  path: string;
  /** Deklaracijos antgalvis be kūno, normalizuotais tarpais. Jo pokytis = formos pokytis. */
  signature: string;
  /** Nariai, kurių DINGIMAS yra atėmimas: parametrai, savybės, stulpeliai, raktai, teiginiai. */
  members: string[];
  /** 1-based eilutė revizijos faile — įrodymo nuoroda. */
  line: number;
};

export type ContractEvidence = {
  revision: ContractRevision;
  path: string;
  line?: number;
  excerpt: string;
};

/**
 * `unverified` yra atskira reikšmė, o ne „nežinoma rizika": ji reiškia, kad suderinamumo
 * ĮRODYTI NEBUVO IŠ KO. Kartu su `breaking` ji blokuoja bangą.
 */
export type ContractBreakingRisk = "none" | "potential" | "breaking" | "unverified";

export type ContractChangeKind = "added" | "removed" | "changed" | "unverified";

export type ContractDiffEntry = {
  kind: ContractKind;
  id: string;
  change: ContractChangeKind;
  before?: ContractDescriptor;
  after?: ContractDescriptor;
  breaking_risk: ContractBreakingRisk;
  /** Kodėl būtent toks verdiktas — kiekviena eilutė yra konkretus, patikrinamas faktas. */
  reasons: string[];
  evidence: ContractEvidence[];
};

export type ContractDiffInput = {
  /** Failai PRIEŠ bangą. Failo nebuvimas sąraše = jis revizijoje neegzistavo. */
  before: readonly ContractSourceFile[];
  /** Failai PO bangos. */
  after: readonly ContractSourceFile[];
  /**
   * Bangos paliesti keliai. Kiekvienas kontraktus galintis nešti kelias, apie kurį modulis
   * negavo turinio nė vienoje revizijoje, virsta `unverified` įrašu — tai ir yra vartas
   * prieš „failų diff užtenka" prielaidą.
   */
  changedPaths?: readonly string[];
};

export type ContractDiffReport = {
  diff_version: number;
  entries: ContractDiffEntry[];
  /** Keliai, kurių kontraktų nebuvo iš ko patikrinti. */
  unverified_paths: string[];
  /** `true` tik kai nėra nė vieno `breaking` ar `unverified` įrašo. */
  compatible: boolean;
  /** Įrašai, dėl kurių banga negali būti priimta. */
  blocking: ContractDiffEntry[];
  diff_hash: string;
};
