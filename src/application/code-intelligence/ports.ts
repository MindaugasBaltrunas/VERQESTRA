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
  readTextFile(absolutePath: string): Promise<string>;
  /** Baitai hash'avimui — tekstinė forma iškraipytų ne-UTF8 turinį. */
  readFileBytes(absolutePath: string): Promise<Uint8Array>;
  fileSize(absolutePath: string): Promise<number>;
  exists(absolutePath: string): Promise<boolean>;
  /** Atominis teksto įrašymas (tmp + rename semantika — adapterio atsakomybė). */
  writeTextFileAtomic(absolutePath: string, content: string): Promise<void>;
  makeDirectory(absoluteDir: string): Promise<void>;
};
