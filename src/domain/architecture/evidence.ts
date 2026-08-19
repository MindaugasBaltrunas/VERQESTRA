// Pure architecture-evidence domain module. Value types only — no fs/process/git imports and
// no side effects. The FS-backed ledger adapter (E4) persists these shapes.
// Behaviour etalon: AG_loop domain/architecture/evidence.ts.

export type EvidenceEntry = {
  node_id: string;
  source: string;
  excerpt: string;
  timestamp: string;
};

export type UnknownEntry = {
  node_id: string;
  reason: string;
  timestamp: string;
  repair_attempts: number;
};
