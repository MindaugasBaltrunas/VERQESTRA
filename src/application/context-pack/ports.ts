// context-pack klasterio IO portai (WBR VQ-302). Klasterio failų skaitymas, log append
// ir laikrodis — tik per šiuos kontraktus; adapteriai — E4.

export type ContextPackFileSystemPort = {
  /** Failo tekstas arba `undefined`, kai failo nėra (nebuvimas — atsakymas, ne klaida). */
  readTextFileIfExists(absolutePath: string): Promise<string | undefined>;
  /** Baitai hash'avimui. Meta, kai failo nėra. */
  readFileBytes(absolutePath: string): Promise<Uint8Array>;
  exists(absolutePath: string): Promise<boolean>;
  /** Best-effort log append; klaidą meta — kvietėjas sprendžia, ar ją nutylėti. */
  appendTextFile(absolutePath: string, text: string): Promise<void>;
};

export type ClockPort = {
  /** ISO-8601 laiko žyma operatoriaus log eilutėms. */
  timestamp(): string;
};

/** Testų/kompozicijos default'as: realus laikrodis. Application sluoksniui Date leidžiamas. */
export const systemClock: ClockPort = {
  timestamp: () => new Date().toISOString(),
};
