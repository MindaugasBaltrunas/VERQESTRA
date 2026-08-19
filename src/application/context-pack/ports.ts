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
  /** Artefakto įrašymas (context-pack.json / execution-context.md persist kelias). */
  writeTextFile(absolutePath: string, content: string): Promise<void>;
  makeDirectory(absoluteDir: string): Promise<void>;
};

/**
 * Deterministinio context-cache saugyklos portas (spec RAG-2; E4 implementacija).
 * Grynoji rakto pusė gyvena context-cache-key.ts — portas gauna jau suskaičiuotą raktą.
 * Elgesio kontraktas (etalonas: AG_loop orchestrator/runtime/context-cache.ts):
 *  - collectSources: task/source/spec/architecture/policy įrodymai su sha256 (arba
 *    `absent` sentinelis) — best-effort, niekada nemeta;
 *  - lookup: `verifyCodeIndex` kviečiamas LAZY, tik kai įrašas egzistuoja ir naudojo
 *    indeksą; drift/versijos neatitikimas evict'ina ir grąžina miss;
 *  - save: `stale` code-index deskriptoriaus įrašas NESAUGOMAS (ne turinio identitetas);
 *    talpa ribojama seniausius išmetant.
 */
export type ContextCachePort = {
  collectSources(input: {
    taskPath: string;
    taskText: string;
    targets: string[];
    specSources: string[];
  }): Promise<import("./context-cache-model.js").ContextCacheSource[]>;
  lookup(
    key: import("./context-cache-key.js").ContextCacheKey,
    verifyCodeIndex: () => Promise<string>,
  ): Promise<import("./context-cache-key.js").ContextCacheLookup>;
  save(input: {
    key: import("./context-cache-key.js").ContextCacheKey;
    taskId: string;
    contextPackJson: string;
    codeIndexDescriptor: string;
    selectedChars: number;
    selectedTokenEstimate: number;
    droppedItemCount: number;
  }): Promise<{ stored: boolean; reason?: "code_index_stale" }>;
};

export type ClockPort = {
  /** ISO-8601 laiko žyma operatoriaus log eilutėms. */
  timestamp(): string;
};

/** Testų/kompozicijos default'as: realus laikrodis. Application sluoksniui Date leidžiamas. */
export const systemClock: ClockPort = {
  timestamp: () => new Date().toISOString(),
};
