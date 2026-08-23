// Užduočių įkėlimas į eilę per dashboard'ą (etalonas: AG_loop ui/task-upload-service.ts).
//
// Įkėlimas šioje sistemoje faktiškai yra DARBO PALEIDIMAS: kiekvienas failas tampa eilės įrašu,
// kurį loop'as vykdys. Todėl ribų reikia trims dalykams, ne vienam: bendram kūnui, failų KIEKIUI
// ir vienam failui. Vien 5 MB kūno riba praleistų dešimtis tūkstančių mažų „užduočių".
//
// Klaidų klasės atskirtos, nes jos virsta skirtingais HTTP kodais: netinkamas turinys yra 400,
// per didelis — 413. 500 čia nėra teisingas atsakymas nė vienam kliento įvesties atvejui.

import path from "node:path";

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const MAX_UPLOAD_FILES = 50;
export const MAX_FILE_BYTES = 512 * 1024;

/** Klientas atsiuntė netinkamą turinį — 400, ne 500. */
export class InvalidUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidUploadError";
  }
}

/** Užklausos kūnas viršija ribą — 413, ne 500. */
export class UploadTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadTooLargeError";
  }
}

export type UploadFile = { name: string; content: string };

export type TaskUploadPorts = {
  /**
   * Rašymas, kuris NEPERRAŠO esamo failo: `"exists"` reiškia užimtą vardą, ir kvietėjas ieško kito.
   * Be šios semantikos du įkėlimai tuo pačiu vardu tyliai perrašytų vienas kitą.
   */
  writeFileExclusive(absolutePath: string, content: string): Promise<"created" | "exists">;
  makeDirectory(absoluteDir: string): Promise<void>;
  /** Vardo atsarginis šaltinis, kai iš kliento vardo nelieka nė vieno tinkamo simbolio. */
  now?: () => Date;
};

/**
 * Vardas iš kliento NIEKADA nenaudojamas žaliai: paliekamas tik bazinis vardas be katalogų, o iš
 * jo — tik saugūs simboliai. `..` ir absoliutus kelias taip nustoja egzistuoti dar prieš tampant
 * keliu.
 *
 * NUKRYPIMAS nuo etalono (griežtinantis): tikrinamas STEM'as, ne visas vardas. Etalone atsarginis
 * `task-<ts>.md` vardas buvo nepasiekiamas — `.md` prilipdomas PRIEŠ tuštumo patikrą, tad vardas,
 * iš kurio po valymo nelieka nė vieno simbolio (`"///"`, `"---"`), virsdavo failu `.md`: POSIX'e
 * tai paslėptas failas, o eilėje — įrašas, kurio operatorius nemato.
 */
export function sanitizeMarkdownFileName(name: string, now: Date = new Date()): string {
  const baseName = path.basename(name).trim().replace(/[^\w.-]+/g, "-");
  const withoutExtension = baseName.toLowerCase().endsWith(".md") ? baseName.slice(0, -".md".length) : baseName;
  const stem = withoutExtension.replace(/^[-.]+/, "");
  return stem ? `${stem}.md` : `task-${now.getTime()}.md`;
}

/** Vieno failo taisyklės. Meta pirmą pažeidimą — dalinio priėmimo čia nėra. */
export function normalizeUploadFile(file: unknown, now: Date = new Date()): UploadFile {
  const record = typeof file === "object" && file !== null ? (file as Record<string, unknown>) : {};
  const name = record["name"];
  const content = record["content"];

  if (typeof name !== "string" || typeof content !== "string") {
    throw new InvalidUploadError("Each uploaded task must include name and content");
  }
  if (!name.toLowerCase().endsWith(".md")) {
    throw new InvalidUploadError(`Only Markdown files are allowed: ${name}`);
  }
  if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
    throw new UploadTooLargeError(`Task file exceeds 512 KB: ${name}`);
  }
  if (!content.trim()) {
    throw new InvalidUploadError(`Task file is empty: ${name}`);
  }

  return { name: sanitizeMarkdownFileName(name, now), content };
}

/**
 * Viso krovinio taisyklės. VISI failai validuojami PRIEŠ rašymą: dalinis įrašymas paliktų dalį
 * užduočių eilėje, o klientui grąžintų klaidą — jis bandytų iš naujo ir gimtų dublikatai su
 * `-2` sufiksais.
 */
export function normalizeUploadPayload(rawBody: string, now: Date = new Date()): UploadFile[] {
  // Bendra kūno riba vykdoma ČIA (etalono task-upload-service 1:1): iki 2026-08-23 konstanta
  // buvo deklaruota, bet NEVYKDOMA — realiai ribojo tik bendrinis 8 MiB serverio skaitymas, tad
  // 5–8 MiB įkėlimas praeidavo, o dar didesnis virsdavo generiniu gedimu vietoje 413.
  if (Buffer.byteLength(rawBody, "utf8") > MAX_UPLOAD_BYTES) {
    throw new UploadTooLargeError("Upload is larger than 5 MB");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch (error) {
    throw new InvalidUploadError(
      `Upload payload is not valid JSON: ${error instanceof Error ? error.message : "parse error"}`,
    );
  }

  const files = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>)["files"] : undefined;
  if (!Array.isArray(files)) {
    throw new InvalidUploadError("Upload payload must include files");
  }
  if (files.length > MAX_UPLOAD_FILES) {
    throw new UploadTooLargeError(`At most ${MAX_UPLOAD_FILES} task files can be uploaded at once`);
  }

  const normalized = files.map((file) => normalizeUploadFile(file, now));
  if (normalized.length === 0) {
    throw new InvalidUploadError("No Markdown files selected");
  }
  return normalized;
}

function queuePathCandidate(queueDir: string, fileName: string, index: number): string {
  const parsed = path.parse(fileName);
  return index === 1 ? path.join(queueDir, fileName) : path.join(queueDir, `${parsed.name}-${index}${parsed.ext}`);
}

async function writeUniqueQueueFile(ports: TaskUploadPorts, queueDir: string, file: UploadFile): Promise<string> {
  for (let index = 1; index <= 1000; index += 1) {
    const destination = queuePathCandidate(queueDir, file.name, index);
    if ((await ports.writeFileExclusive(destination, file.content)) === "created") {
      return path.basename(destination);
    }
  }
  throw new Error(`Unable to allocate unique queue task path for ${file.name}`);
}

/** Įrašo krovinį į eilę ir grąžina realiai sukurtų failų vardus. */
export async function uploadQueueMarkdownFiles(
  ports: TaskUploadPorts,
  agRoot: string,
  rawBody: string,
): Promise<string[]> {
  const now = ports.now?.() ?? new Date();
  const files = normalizeUploadPayload(rawBody, now);

  const queueDir = path.join(agRoot, "tasks", "queue");
  await ports.makeDirectory(queueDir);

  const saved: string[] = [];
  for (const file of files) {
    saved.push(await writeUniqueQueueFile(ports, queueDir, file));
  }
  return saved;
}
