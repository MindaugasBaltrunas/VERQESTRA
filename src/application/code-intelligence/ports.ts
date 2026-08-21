// code-intelligence klasterio IO portai (WBR VQ-301). Application kodas failų sistemą
// liečia TIK per šiuos kontraktus; realus adapteris — E4 infrastructure. Testai gali
// paduoti fs-backed arba in-memory implementaciją.

export type DirectoryEntry = {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
};

export type CodeIntelligenceFileSystemPort = {
  /** Katalogo įrašai; neegzistuojantis katalogas → tuščias sąrašas (etalono `.catch(() => [])`). */
  listDirectory(absoluteDir: string): Promise<DirectoryEntry[]>;
  /**
   * Kelio rūšis, STAT semantika (seka symlink'us) — ta pati forma kaip
   * `ReadinessAuditPorts.statKind` ir `nodeFsAdapter.statKind`.
   *
   * `absent` reiškia „nėra ARBA rūšies nustatyti nepavyko" ir yra SĄMONINGAI dviprasmis:
   * skambintojas iš jo neturi teisės spręsti, kad tai failas. Vienintelis saugus atsakas —
   * praleisti kelią, nes bandymas skaityti katalogą kaip failą mestų EISDIR.
   */
  statKind(absolutePath: string): Promise<"file" | "directory" | "absent">;
  readTextFile(absolutePath: string): Promise<string>;
  /** Baitai hash'avimui — tekstinė forma iškraipytų ne-UTF8 turinį. */
  readFileBytes(absolutePath: string): Promise<Uint8Array>;
  fileSize(absolutePath: string): Promise<number>;
  exists(absolutePath: string): Promise<boolean>;
  /** Atominis teksto įrašymas (tmp + rename semantika — adapterio atsakomybė). */
  writeTextFileAtomic(absolutePath: string, content: string): Promise<void>;
  makeDirectory(absoluteDir: string): Promise<void>;
};
