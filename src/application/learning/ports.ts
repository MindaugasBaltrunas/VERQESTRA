// learning klasterio IO portai (VQ-305 3/3-f). Struktūrinis ContextPackFileSystemPort
// poaibis — vienas E4 fs adapteris dengia abu kontraktus.

export type LearningFsPort = {
  /** Failo tekstas arba `undefined`, kai failo nėra (nebuvimas — atsakymas, ne klaida). */
  readTextFileIfExists(absolutePath: string): Promise<string | undefined>;
  /** Append; klaidą meta — kvietėjas sprendžia, ar ją nutylėti (learning — best-effort). */
  appendTextFile(absolutePath: string, text: string): Promise<void>;
  writeTextFile(absolutePath: string, content: string): Promise<void>;
  makeDirectory(absoluteDir: string): Promise<void>;
};
