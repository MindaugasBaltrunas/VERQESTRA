// policy-governance klasterio IO portai: konfigo failų skaitymas. Adapteriai — E4.

export type PolicyConfigFileSystemPort = {
  /** Failo tekstas arba `undefined`, kai failo nėra (nebuvimas — atsakymas, ne klaida). */
  readTextFileIfExists(absolutePath: string): Promise<string | undefined>;
};
