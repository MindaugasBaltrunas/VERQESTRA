// Architektūros stilių KATALOGAS — visi stiliai, kuriuos operatorius gali pasirinkti valdymo
// ekrane (`architecture-style.json#style`).
//
// Du sąrašai sąmoningai: `KNOWN_STYLES` (stack-decision-matrix) yra tai, ką planuoklis moka
// IŠVESTI iš signalų ir siūlyti kaip alternatyvas — jis siauras, nes kiekvienas jo įrašas turi
// išvedimo šaką. Šis katalogas yra tai, ką operatorius gali PASIRINKTI sąmoningai; jis platesnis
// ir privalo apimti visą `KNOWN_STYLES` (paritetą pin'ina testas), kad išvestas stilius visada
// būtų ir pasirenkamas.
//
// Iki 2026-09-02 pasirinkimų sąrašas gyveno tik naršyklėje (`PolicyControlsPanel`), keturių
// įrašų ir su `modular_monolith`, kurio domain'as nežinojo, o be `modular-feature` ir `pipeline`,
// kuriuos domain'as išveda. Vienas šaltinis čia; UI jį gauna kaip `allowed_values`.

import { KNOWN_STYLES } from "./stack-decision-matrix.js";

export const ARCHITECTURE_STYLES = [
  "layered",
  "clean_architecture",
  "hexagonal",
  "onion",
  "modular-feature",
  "modular_monolith",
  "microservices",
  "event_driven",
  "cqrs",
  "pipeline",
  "mvc",
  "microkernel",
  "serverless",
] as const;

export type ArchitectureStyle = (typeof ARCHITECTURE_STYLES)[number];

export function isArchitectureStyle(value: unknown): value is ArchitectureStyle {
  return typeof value === "string" && (ARCHITECTURE_STYLES as readonly string[]).includes(value);
}

/** Išvedami stiliai, kurių kataloge NĖRA — teisinga būsena yra tuščias sąrašas (žr. testą). */
export function inferableStylesMissingFromCatalog(): string[] {
  return KNOWN_STYLES.filter((style) => !isArchitectureStyle(style));
}
