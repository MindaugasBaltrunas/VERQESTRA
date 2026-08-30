// Claude Code hook protokolo skaitymas (etalonas: AG_loop hooks/input.ts 1:1). Grynas
// payload'o parsinimas ir laukų ištraukimas — jokio IO: stdin skaitymas ateina per portą.
//
// Fail-open pavojus, dėl kurio čia yra DVI parsinimo formos: `parseHookInput` neperskaitytą
// JSON paverčia į `{}`, tad guard'as pamato tuščią komandą/kelią ir praleidžia įvykį
// nepatikrintą. PreToolUse guard'ai privalo blokuoti bet kokį payload'ą, kurio negali
// perskaityti, tad jiems skirtas `parseHookInputStrict`. PostToolUse pusėje atlaidi forma
// lieka: neperskaitytas post payload'as yra tik žurnalo no-op, ne saugos sprendimas.

/** Hook išvesties kanalai. Handleriai spausdina TIK per šį portą — testai perima eilutes. */
export type HookIo = {
  out(line: string): void;
  error(line: string): void;
};

export const consoleHookIo: HookIo = {
  out(line: string): void {
    console.log(line);
  },
  error(line: string): void {
    console.error(line);
  },
};

/** Hook'ų failų sistemos portas (vq/logs, vq/state). */
export type HookFsPort = {
  exists(absolutePath: string): Promise<boolean>;
  /** Failo tekstas arba `undefined`, kai failo nėra (nebuvimas — atsakymas, ne klaida). */
  readTextFileIfExists(absolutePath: string): Promise<string | undefined>;
  writeTextFile(absolutePath: string, text: string): Promise<void>;
  appendTextFile(absolutePath: string, text: string): Promise<void>;
  makeDirectory(absoluteDir: string): Promise<void>;
  /**
   * Katalogo įrašų vardai arba `undefined`, kai katalogo nėra. NEPRIVALOMAS: skaitytojas be jo
   * krenta į siauresnį šaltinį (žr. `collectKnownTaskIds`) — trūkstamas portas gali tik
   * SUSIAURINTI leidžiamą aibę, niekada jos neišplėsti, tad seni fake'ai lieka galiojantys.
   */
  listDirectoryIfExists?(absoluteDir: string): Promise<string[] | undefined>;
};

/** Standartinės įvesties skaitymas iki EOF — vienintelis hook'o IO įėjimas. */
export type HookStdinPort = {
  readStdin(): Promise<string>;
};

export function parseHookInput(input: string): Record<string, unknown> {
  try {
    return JSON.parse(input) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Kodėl payload'o nepavyko perskaityti — fiksuotas identifikatorius.
 *
 * Šalia esantis `error` neša paties parserio žinutę, o Node >= 20 ji įterpia įvesties
 * fragmentą — t.y. hook payload'ą, t.y. komandos eilutę ir jos išvestį. Tai priimtina
 * žinutei, kurią žmogus mato stderr, ir NEpriimtina niekam, kas rašoma į žurnalą: bet koks
 * persistuojamas įrašas privalo remtis `kind`, niekada ne `error`.
 */
export type HookInputParseFailure = "empty" | "unparseable" | "not_object";

export type ParsedHookInput =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; kind: HookInputParseFailure; error: string };

export function parseHookInputStrict(input: string): ParsedHookInput {
  const trimmed = input.trim();
  if (trimmed === "") {
    return { ok: false, kind: "empty", error: "tuščias hook stdin (nėra JSON payload)" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, kind: "unparseable", error: `neparse'inamas hook stdin JSON: ${message}` };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, kind: "not_object", error: "hook stdin JSON nėra objektas" };
  }

  return { ok: true, value: parsed as Record<string, unknown> };
}

export function getToolInputField(input: Record<string, unknown>, field: string): string {
  const toolInput = input["tool_input"];
  if (!toolInput || typeof toolInput !== "object") return "";
  const value = (toolInput as Record<string, unknown>)[field];
  return typeof value === "string" ? value : "";
}

/**
 * Kuriam įrankiui skirtas įvykis. Payload'as be string `tool_name` duoda "", ir kiekvienas
 * kvietėjas privalo tai laikyti „nežinomu įrankiu", niekada — „tuo, kuriam esu sukonfigūruotas".
 */
export function getHookToolName(input: Record<string, unknown>): string {
  const value = input["tool_name"];
  return typeof value === "string" ? value : "";
}

/**
 * PostToolUse payload'as neša įrankio REZULTATĄ po `tool_response` (PreToolUse tokio lauko
 * neturi). Grąžinama `unknown` sąmoningai: forma priklauso tam Claude Code build'ui, kuris ją
 * pagamino, tad validuoti privalo skaitytojas, mokantis pasakyti „aš to perskaityti negaliu".
 */
export function getToolResponse(input: Record<string, unknown>): unknown {
  return input["tool_response"];
}

/**
 * Rašantys įrankiai savo taikinį vadina skirtingai: Write/Edit — `file_path`, NotebookEdit —
 * `notebook_path`, kai kurie MCP įrankiai — plikas `path`. Nežinomas laukas duoda "", ir
 * kiekvienas kelio guard'as tai laiko „nėra ko saugoti" — t.y. fail-open būtent tam payload'ui,
 * dėl kurio guard'as ir egzistuoja. Kvietėjas PRIVALO blokuoti tuščią rezultatą.
 */
export function getHookPathField(input: Record<string, unknown>): string {
  return (
    getToolInputField(input, "path") ||
    getToolInputField(input, "file_path") ||
    getToolInputField(input, "notebook_path")
  );
}
