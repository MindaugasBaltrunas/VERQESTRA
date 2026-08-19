// Lazy source-slice extraction (task 0022). Behaviour etalon: AG_loop
// application/context-pack/source-slice.ts; FS — per ContextPackFileSystemPort;
// klaidos tekste build komanda — engine-neutrali (CLI vardas prisistato E5).
//
// The code index deliberately stores no file contents: it records where a declaration
// lives (`file` + `line`/`endLine`) and what it looks like from the outside (`signature`).
// When a context compiler needs the EXACT source of one declaration this module reads
// precisely those lines from the working tree, on demand.
//
//   1. HASH-VERIFIED. Before any text is returned, the file's current sha256 is compared
//      against `CodeIndexFile.hash`. A mismatch is rejected as `stale_file` — never silently
//      served, never "close enough".
//   2. BOUNDED. Only the requested line range is decoded and returned.
//
// Every failure is a typed `Result` error, so a compiler that cannot get an exact slice
// can fall back to the signature or the file reference instead of guessing.

import { createHash } from "node:crypto";
import path from "node:path";
import type { CodeIndexData, CodeIndexFile } from "../code-intelligence/indexing/types.js";
import { toPosixPath } from "../../shared/paths.js";
import { err, ok, type Result } from "../../shared/result.js";
import type { ContextPackFileSystemPort } from "./ports.js";

export type SourceSliceRequest = {
  /** Repo-relative path, exactly as the index stores it (`CodeIndexFile.path`). */
  file: string;
  /** 1-based first line, inclusive. */
  line: number;
  /** 1-based last line, inclusive. Defaults to `line` (single-line declaration). */
  endLine?: number;
};

/** The exact source of one declaration, proven to match the indexed file. */
export type SourceSlice = {
  file: string;
  line: number;
  endLine: number;
  /** The requested lines verbatim, joined with `\n` (line endings normalized, nothing else). */
  text: string;
  /** sha256 of the file the slice was cut from; equal to `CodeIndexFile.hash` by construction. */
  hash: string;
};

export type SourceSliceErrorCode =
  /** The path is absent from the index, so there is no hash to verify the file against. */
  | "file_not_indexed"
  /** The symbol carries no line range (no AST indexer for that language yet). */
  | "missing_range"
  /** Non-integer, non-positive, or inverted line range. */
  | "invalid_range"
  /** The file could not be read from the working tree (deleted, permissions). */
  | "file_unreadable"
  /** The file changed since the index was built: its line numbers are no longer trustworthy. */
  | "stale_file"
  /** The range is inside a matching file but past its last line (corrupt index record). */
  | "range_out_of_bounds";

export type SourceSliceError = {
  code: SourceSliceErrorCode;
  message: string;
};

/**
 * Reader over one code index, caching each file's verified content for its own lifetime.
 *
 * Create one per extraction batch (e.g. per context pack): several symbols of the same
 * file then cost one read and one hash. The cache is intentionally NOT global — a reader
 * that outlived a dispatch would start answering from a snapshot of the working tree
 * instead of from it.
 */
export type SourceSliceReader = {
  read(request: SourceSliceRequest): Promise<Result<SourceSlice, SourceSliceError>>;
  readSymbol(symbol: IndexedSymbolRef): Promise<Result<SourceSlice, SourceSliceError>>;
};

/**
 * The parts of an indexed symbol a slice needs. Declared structurally so both a raw
 * `CodeIndexSymbol` and a selected `ContextSymbol` satisfy it without this module
 * depending on either.
 */
export type IndexedSymbolRef = {
  id: string;
  file: string;
  line?: number;
  endLine?: number;
};

type VerifiedFile = Result<{ lines: string[]; hash: string }, SourceSliceError>;

export function createSourceSliceReader(
  fs: ContextPackFileSystemPort,
  projectRoot: string,
  data: CodeIndexData,
): SourceSliceReader {
  const indexedFiles = new Map(data.files.map((file) => [file.path, file]));
  const verified = new Map<string, Promise<VerifiedFile>>();

  const verify = (indexed: CodeIndexFile): Promise<VerifiedFile> => {
    const cached = verified.get(indexed.path);
    if (cached) {
      return cached;
    }
    const pending = verifyIndexedFile(fs, projectRoot, indexed);
    verified.set(indexed.path, pending);
    return pending;
  };

  const read = async (request: SourceSliceRequest): Promise<Result<SourceSlice, SourceSliceError>> => {
    const file = normalizeIndexPath(request.file);
    const indexed = indexedFiles.get(file);
    if (!indexed) {
      return err({
        code: "file_not_indexed",
        message: `${file} is not in the code index; run the code-index build before requesting a source slice`,
      });
    }

    const endLine = request.endLine ?? request.line;
    if (!isPositiveInteger(request.line) || !isPositiveInteger(endLine) || endLine < request.line) {
      return err({ code: "invalid_range", message: `invalid line range for ${file}: ${request.line}-${endLine}` });
    }

    const content = await verify(indexed);
    if (!content.ok) {
      return content;
    }
    if (endLine > content.value.lines.length) {
      return err({
        code: "range_out_of_bounds",
        message: `${file} has ${content.value.lines.length} lines; requested ${request.line}-${endLine}`,
      });
    }

    return ok({
      file,
      line: request.line,
      endLine,
      text: content.value.lines.slice(request.line - 1, endLine).join("\n"),
      hash: content.value.hash,
    });
  };

  return {
    read,
    readSymbol: async (symbol) => {
      if (symbol.line === undefined) {
        return err({
          code: "missing_range",
          message: `symbol ${symbol.id} carries no line range; only AST-indexed languages do`,
        });
      }
      return await read({ file: symbol.file, line: symbol.line, endLine: symbol.endLine ?? symbol.line });
    },
  };
}

/** One-shot convenience over {@link createSourceSliceReader} for a single slice. */
export async function extractSourceSlice(
  fs: ContextPackFileSystemPort,
  projectRoot: string,
  data: CodeIndexData,
  request: SourceSliceRequest,
): Promise<Result<SourceSlice, SourceSliceError>> {
  return await createSourceSliceReader(fs, projectRoot, data).read(request);
}

/** One-shot convenience for the exact source of one indexed symbol. */
export async function extractSymbolSource(
  fs: ContextPackFileSystemPort,
  projectRoot: string,
  data: CodeIndexData,
  symbol: IndexedSymbolRef,
): Promise<Result<SourceSlice, SourceSliceError>> {
  return await createSourceSliceReader(fs, projectRoot, data).readSymbol(symbol);
}

/**
 * Read a file and prove it is still the one the index described.
 *
 * The digest is sha256 over the raw bytes — the same contract as the scanner's `hashFile`,
 * computed here from the single read this module already needs so a slice never costs two
 * reads of the same file.
 */
async function verifyIndexedFile(
  fs: ContextPackFileSystemPort,
  projectRoot: string,
  indexed: CodeIndexFile,
): Promise<VerifiedFile> {
  let content: Uint8Array;
  try {
    content = await fs.readFileBytes(path.join(projectRoot, indexed.path));
  } catch (error) {
    return err({
      code: "file_unreadable",
      message: `${indexed.path} could not be read: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  const hash = createHash("sha256").update(content).digest("hex");
  if (hash !== indexed.hash) {
    return err({
      code: "stale_file",
      message:
        `${indexed.path} changed since the code index was built ` +
        `(indexed ${shortHash(indexed.hash)}, current ${shortHash(hash)}); ` +
        "its line ranges are stale — rebuild the code index",
    });
  }

  // Line endings are normalized to `\n` so a CRLF checkout and an LF checkout of the same
  // declaration yield the same slice; the line CONTENT is untouched.
  return ok({ lines: new TextDecoder().decode(content).split(/\r?\n/), hash });
}

function normalizeIndexPath(file: string): string {
  return toPosixPath(file).replace(/^\.\//, "");
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function shortHash(hash: string): string {
  return hash.slice(0, 12);
}
