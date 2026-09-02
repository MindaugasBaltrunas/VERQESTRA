// Programavimo principų KATALOGAS — vienintelis sąrašas, iš kurio gimsta ir
// `coding-principles.json` schema, ir valdymo ekrano valdikliai, ir final audito patikra.
//
// Iki 2026-09-02 principai buvo išvardyti trijose vietose atskirai (schema, UI modelis, final
// auditas) ir SOLID neturėjo „L" — Liskov pakeičiamumo. Kiekvienas principas gauna tą patį
// `EnforcementLevel` (advisory / warn / block); numatytoji reikšmė — `advisory`, nes objektyvų
// detektorių turi tik `single_responsibility` (`file-length`), o likusieji į vykdytoją keliauja
// kaip preflight `policy_rules` nurodymas.
//
// Tvarka yra rodymo tvarka: SOLID penketas, tada bendrieji principai.

export const CODING_PRINCIPLES = [
  { id: "single_responsibility", label: "Single responsibility" },
  { id: "open_closed", label: "Open/closed principle" },
  { id: "liskov_substitution", label: "Liskov substitution" },
  { id: "interface_segregation", label: "Interface segregation" },
  { id: "dependency_inversion", label: "Dependency inversion" },
  { id: "dry", label: "DRY" },
  { id: "kiss", label: "KISS" },
  { id: "yagni", label: "YAGNI" },
  { id: "separation_of_concerns", label: "Separation of concerns" },
  { id: "composition_over_inheritance", label: "Composition over inheritance" },
  { id: "law_of_demeter", label: "Law of Demeter" },
  { id: "encapsulation", label: "Encapsulation" },
  { id: "immutability", label: "Immutability by default" },
  { id: "fail_fast", label: "Fail fast" },
  { id: "explicit_over_implicit", label: "Explicit over implicit" },
  { id: "least_astonishment", label: "Principle of least astonishment" },
] as const;

export type CodingPrincipleId = (typeof CODING_PRINCIPLES)[number]["id"];

export const CODING_PRINCIPLE_IDS: readonly CodingPrincipleId[] = CODING_PRINCIPLES.map((principle) => principle.id);
