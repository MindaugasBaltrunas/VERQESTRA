type ControlState =
  | "text"
  | "escape"
  | "csi"
  | "osc"
  | "osc-escape"
  | "string-control"
  | "string-control-escape";

const MAX_PENDING_SECRET_CHARS = 65_536;
const REDACTED = "[REDACTED]";

// C0/C1 valdymo taškai vardais ir GRYNA ASCII forma. Etalone jie stovėjo inline, neapdorotais
// baitais string literaluose (ESC, BEL ir C1 U+0090..U+009F). Tai veikia, bet trapu dviem
// tyliais būdais: nematomas baitas nepergyvena kiekvieno kopijavimo, o failo, kurio negali
// perskaityti akimi, negali ir peržiūrėti. `fromCharCode` palieka šaltinį vienareikšmį ir
// nepakeičia nė vieno bito reikšmėse.
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const C1_CSI = String.fromCharCode(0x9b);
const C1_OSC = String.fromCharCode(0x9d);
const C1_ST = String.fromCharCode(0x9c);
const C1_DCS = String.fromCharCode(0x90);
const C1_SOS = String.fromCharCode(0x98);
const C1_PM = String.fromCharCode(0x9e);
const C1_APC = String.fromCharCode(0x9f);

/**
 * Literal openings of every pattern {@link redactSecrets} removes. A chunk
 * boundary is only dangerous where the tail could still GROW into one of these,
 * so this list is the precise definition of what must be held back.
 *
 * Compared case-insensitively even for the case-sensitive patterns: holding more
 * than strictly necessary is safe, emitting too early is not.
 *
 * Exported so the chunk-boundary leak test can build its fixtures from the same
 * source of truth: a pattern added here is automatically covered by that test,
 * and no test file has to hard-code a credential-shaped literal.
 */
export const SECRET_TRIGGER_OPENINGS = Object.freeze([
  "bearer",
  "ghp_",
  "gho_",
  "ghu_",
  "ghs_",
  "ghr_",
  "github_pat_",
  "sk-",
  "akia",
  "token",
  "secret",
  "password",
  "api_key",
  "api-key",
  "apikey",
]);

const LONGEST_TRIGGER_OPENING = Math.max(...SECRET_TRIGGER_OPENINGS.map((opening) => opening.length));

/** A complete keyword still waiting for its `:`/`=` separator or its value. */
const TRIGGER_AWAITING_SEPARATOR =
  /(?:\bBearer|\b(?:TOKEN|SECRET|PASSWORD|API[_-]?KEY))\s*[:=]?\s*$/i;

function redactSecrets(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, `Bearer ${REDACTED}`)
    .replace(/\b(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}/g, REDACTED)
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, REDACTED)
    .replace(
      /\b(TOKEN|SECRET|PASSWORD|API[_-]?KEY)\s*[:=]\s*[^\s]+/gi,
      (_match, name: string) => `${name}=${REDACTED}`,
    );
}

/** A trigger that already matched, whose value may still be growing. */
function openSecretStart(value: string): number {
  const match = /(?:\bBearer\s+|\b(?:TOKEN|SECRET|PASSWORD|API[_-]?KEY)\s*[:=]\s*|\b(?:gh[pousr]_|github_pat_|sk-)|\bAKIA)[^\s]*$/i.exec(value);
  return match?.index ?? -1;
}

/**
 * Index of the longest tail that is a PROPER prefix of some trigger opening —
 * the only text a following chunk could complete into a secret.
 */
function openTriggerPrefixStart(value: string): number {
  const longest = Math.min(value.length, LONGEST_TRIGGER_OPENING - 1);
  for (let length = longest; length > 0; length -= 1) {
    const suffix = value.slice(value.length - length).toLowerCase();
    if (SECRET_TRIGGER_OPENINGS.some((opening) => opening.length > suffix.length && opening.startsWith(suffix))) {
      return value.length - length;
    }
  }
  return -1;
}

/**
 * Earliest index that must stay buffered, or `-1` when the whole buffer is safe
 * to emit now.
 *
 * Replaces a blanket 256-character trailing hold. That hold made every short,
 * idle terminal write invisible until more output arrived or the session
 * flushed on close — fatal for an interactive terminal — while buying nothing
 * for text that could not begin a secret in the first place.
 */
function earliestHoldStart(value: string): number {
  const separatorMatch = TRIGGER_AWAITING_SEPARATOR.exec(value);
  const candidates = [
    openSecretStart(value),
    openTriggerPrefixStart(value),
    separatorMatch?.index ?? -1,
  ].filter((index) => index >= 0);
  return candidates.length === 0 ? -1 : Math.min(...candidates);
}

export class TerminalOutputSanitizer {
  private controlState: ControlState = "text";
  private pendingText = "";
  private suppressSecretUntilWhitespace = false;

  private stripControls(value: string): string {
    let output = "";
    for (const character of value) {
      const code = character.codePointAt(0) ?? 0;
      switch (this.controlState) {
        case "text":
          if (character === ESC) {
            this.controlState = "escape";
          } else if (character === C1_CSI) {
            this.controlState = "csi";
          } else if (character === C1_OSC) {
            this.controlState = "osc";
          } else if (
            character === C1_DCS ||
            character === C1_SOS ||
            character === C1_PM ||
            character === C1_APC
          ) {
            this.controlState = "string-control";
          } else if (
            character === "\n" ||
            character === "\r" ||
            character === "\t" ||
            (code >= 0x20 && !(code >= 0x7f && code <= 0x9f))
          ) {
            output += character;
          }
          break;
        case "escape":
          if (character === "[") {
            this.controlState = "csi";
          } else if (character === "]") {
            this.controlState = "osc";
          } else if (character === "P" || character === "X" || character === "^" || character === "_") {
            this.controlState = "string-control";
          } else {
            this.controlState = "text";
          }
          break;
        case "csi":
          if (code >= 0x40 && code <= 0x7e) {
            this.controlState = "text";
          }
          break;
        case "osc":
          if (character === BEL || character === C1_ST) {
            this.controlState = "text";
          } else if (character === ESC) {
            this.controlState = "osc-escape";
          }
          break;
        case "osc-escape":
          if (character === "\\") {
            this.controlState = "text";
          } else {
            this.controlState = character === ESC ? "osc-escape" : "osc";
          }
          break;
        case "string-control":
          if (character === C1_ST) {
            this.controlState = "text";
          } else if (character === ESC) {
            this.controlState = "string-control-escape";
          }
          break;
        case "string-control-escape":
          if (character === "\\") {
            this.controlState = "text";
          } else {
            this.controlState = character === ESC ? "string-control-escape" : "string-control";
          }
          break;
      }
    }
    return output;
  }

  push(rawTerminalData: string): string {
    let safeText = this.stripControls(rawTerminalData);
    let output = "";
    if (this.suppressSecretUntilWhitespace) {
      const boundary = safeText.search(/\s/);
      if (boundary === -1) {
        return "";
      }
      safeText = safeText.slice(boundary);
      this.suppressSecretUntilWhitespace = false;
    }
    this.pendingText += safeText;
    const openStart = openSecretStart(this.pendingText);
    if (this.pendingText.length > MAX_PENDING_SECRET_CHARS && openStart >= 0) {
      output += redactSecrets(this.pendingText.slice(0, openStart));
      output += REDACTED;
      this.pendingText = "";
      this.suppressSecretUntilWhitespace = true;
      return output;
    }
    const holdStart = earliestHoldStart(this.pendingText);
    const emitEnd = holdStart >= 0 ? holdStart : this.pendingText.length;
    if (emitEnd > 0) {
      output += redactSecrets(this.pendingText.slice(0, emitEnd));
      this.pendingText = this.pendingText.slice(emitEnd);
    }
    return output;
  }

  flush(): string {
    const output = this.suppressSecretUntilWhitespace
      ? ""
      : redactSecrets(this.pendingText);
    this.pendingText = "";
    this.suppressSecretUntilWhitespace = false;
    this.controlState = "text";
    return output;
  }
}
