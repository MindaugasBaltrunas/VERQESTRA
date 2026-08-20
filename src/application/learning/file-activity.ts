// Git istorijos failų aktyvumo agregacija (pure). Elgesio etalonas: AG_loop
// orchestrator/learning/reliability-analytics.ts (failų pusė). Git output'ą paduoda
// kvietėjas — čia tik tekstas → struktūra.

import path from "node:path";

export type FileChangeKind = "created" | "modified" | "deleted";
export type GitCommit = { timestamp: string; files: Array<{ path: string; kind: FileChangeKind }> };

export type FileActivityBucket = {
  date: string;
  created: number;
  modified: number;
  deleted: number;
  commits: number;
  uniqueFiles: number;
};

/**
 * `--numstat` pervadinimo/kopijos forma be `-z`: `dir/{senas => naujas}.ts` arba
 * `senas.ts => naujas.ts`. Grąžinami abu tikri keliai — kitaip į statistiką patekdavo
 * neegzistuojantis „kelias" su rodykle viduryje.
 */
function splitRenameArrow(filePath: string): { from: string; to: string } | undefined {
  const braced = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(filePath);
  if (braced) {
    const [, prefix = "", from = "", to = "", suffix = ""] = braced;
    return { from: `${prefix}${from}${suffix}`, to: `${prefix}${to}${suffix}` };
  }
  const parts = filePath.split(" => ");
  return parts.length === 2 && parts[0] && parts[1] ? { from: parts[0], to: parts[1] } : undefined;
}

/**
 * `--name-status` pervadinimo (`R`) ir kopijos (`C`) eilutės turi DU kelius:
 * `R100\tsenas\tnaujas`. Iki task 0058 regex'as abu sugriebdavo į vieną `path` reikšmę su
 * tabuliacija viduryje, tad kiekvienas pervadinimas užteršdavo `byExtension` ir
 * `uniqueFiles` fantominiu keliu, o realus naujas failas nebūdavo suskaičiuotas kaip
 * `created`. Semantika: `R` = senas ištrintas + naujas sukurtas; `C` = tik naujas
 * sukurtas (šaltinis lieka).
 */
function nameStatusFiles(status: string, paths: string[]): Array<{ path: string; kind: FileChangeKind }> {
  const [first = "", second] = paths;
  if ((status === "R" || status === "C") && second) {
    return status === "R"
      ? [{ path: first, kind: "deleted" }, { path: second, kind: "created" }]
      : [{ path: second, kind: "created" }];
  }
  if (status === "A") return [{ path: first, kind: "created" }];
  if (status === "D") return [{ path: first, kind: "deleted" }];
  return [{ path: first, kind: "modified" }];
}

export function parseGitNumstat(raw: string): GitCommit[] {
  const commits: GitCommit[] = [];
  let current: GitCommit | undefined;
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("@@")) {
      const [, timestamp = ""] = line.split("|", 2);
      current = { timestamp, files: [] };
      commits.push(current);
      continue;
    }
    if (!current || !line.trim()) continue;
    const statusMatch = /^([ABCDMRTUX])\d*\t(.+)$/.exec(line);
    if (statusMatch) {
      const paths = (statusMatch[2] ?? "").split("\t").filter((part) => part.length > 0);
      current.files.push(...nameStatusFiles(statusMatch[1] ?? "", paths));
      continue;
    }
    const [addedRaw, deletedRaw, ...fileParts] = line.split("\t");
    const filePath = fileParts.join("\t");
    if (!filePath) continue;
    const kind = fileChangeKind({
      added: Number.parseInt(addedRaw ?? "0", 10) || 0,
      deleted: Number.parseInt(deletedRaw ?? "0", 10) || 0,
    });
    // `--numstat` pervadinimą pateikia arba dviem stulpeliais, arba rodyklės forma.
    const rename = fileParts.length > 1 && fileParts[0] && fileParts[1]
      ? { from: fileParts[0], to: fileParts[1] }
      : splitRenameArrow(filePath);
    if (rename) {
      current.files.push({ path: rename.from, kind: "deleted" }, { path: rename.to, kind: "created" });
      continue;
    }
    current.files.push({ path: filePath, kind });
  }
  return commits;
}

/**
 * Dienos raktas VISADA UTC.
 *
 * `git log --date=iso-strict --pretty=%aI` grąžina commit'o laiką su LOKALIU poslinkiu
 * (`2026-08-10T01:30:34+03:00`), o dienos bucket'ai statomi iš `toISOString()`, t. y. UTC.
 * Nupjautas pirmų 10 simbolių raktas todėl reiškė lokalią datą ir su ja nesutapdavo: UTC+3
 * zonoje kiekvienas 00:00-03:00 commit'as gaudavo raktą, kurio bucket'ų žemėlapyje nėra,
 * ir iš statistikos DINGDAVO visiškai. Neparsinamas laikas krenta į seną pjūvį — jis
 * geriau nei tuščias raktas.
 */
export function dateKey(timestamp: string): string {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : timestamp.slice(0, 10);
}

/** Chronologinis rikiavimas pagal REALŲ momentą: skirtingų poslinkių ISO eilutės leksikografiškai nesirikiuoja. */
function commitTimeMs(timestamp: string): number {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

function fileChangeKind(file: { added: number; deleted: number }): FileChangeKind {
  if (file.added > 0 && file.deleted === 0) return "created";
  if (file.added === 0 && file.deleted > 0) return "deleted";
  return "modified";
}

function mergeFileChange(previous: FileChangeKind | undefined, next: FileChangeKind): FileChangeKind {
  if (!previous) return next;
  if (next === "deleted") return "deleted";
  if (previous === "deleted" && next === "created") return "modified";
  if (previous === "created") return "created";
  return "modified";
}

export function summarizeFileChanges(commits: GitCommit[]): {
  created: number;
  modified: number;
  deleted: number;
  commits: number;
  uniqueFiles: number;
  files: Map<string, FileChangeKind>;
} {
  const files = new Map<string, FileChangeKind>();
  for (const commit of [...commits].sort((left, right) => commitTimeMs(left.timestamp) - commitTimeMs(right.timestamp))) {
    for (const file of commit.files) {
      files.set(file.path, mergeFileChange(files.get(file.path), file.kind));
    }
  }
  const summary = { created: 0, modified: 0, deleted: 0, commits: commits.length, uniqueFiles: files.size, files };
  for (const kind of files.values()) summary[kind] += 1;
  return summary;
}

export function aggregateFileActivity(
  commits: GitCommit[],
  days = 30,
  now = new Date(),
): {
  byDay: FileActivityBucket[];
  byExtension: Array<{ extension: string; files: number }>;
} {
  const buckets = new Map<string, FileActivityBucket>();
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(now);
    date.setUTCDate(date.getUTCDate() - offset);
    const key = date.toISOString().slice(0, 10);
    buckets.set(key, { date: key, created: 0, modified: 0, deleted: 0, commits: 0, uniqueFiles: 0 });
  }
  const visibleCommits = commits.filter((commit) => buckets.has(dateKey(commit.timestamp)));
  for (const [key, bucket] of buckets) {
    const summary = summarizeFileChanges(visibleCommits.filter((commit) => dateKey(commit.timestamp) === key));
    bucket.created = summary.created;
    bucket.modified = summary.modified;
    bucket.deleted = summary.deleted;
    bucket.commits = summary.commits;
    bucket.uniqueFiles = summary.uniqueFiles;
  }
  const extensions = new Map<string, Set<string>>();
  for (const commit of visibleCommits) {
    for (const file of commit.files) {
      const extension = path.extname(file.path).toLocaleLowerCase() || "[no extension]";
      const paths = extensions.get(extension) ?? new Set<string>();
      paths.add(file.path);
      extensions.set(extension, paths);
    }
  }
  return {
    byDay: [...buckets.values()],
    byExtension: [...extensions.entries()]
      .map(([extension, files]) => ({ extension, files: files.size }))
      .sort((left, right) => right.files - left.files)
      .slice(0, 12),
  };
}
