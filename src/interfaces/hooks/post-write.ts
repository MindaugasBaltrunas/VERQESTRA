// `PostToolUse` rašymo hook'as (etalonas: AG_loop hooks/post-hooks.ts rašymo pusė): sesijos
// ledger'is, nuosavybės sidecar'as, KPI įvykių žurnalas ir post-write guard'ų fan-out'as.
//
// Kaip ir visas PostToolUse rinkinys — NEGALI blokuoti. Trys praradimo žymės laikomos
// ATSKIRAI ir jų sulieti negalima, nes jos reiškia skirtingą žalą:
//   `ledger_append_failed=1`     — necommit'intas darbas (Stop hook'as failo nebestage'ins);
//   `owner_sidecar_failed=1`     — prarasta tik tapatybė, kelias grįžta į saugią „legacy" būseną;
//   `file_event_append_failed=1` — prarasta tik dashboard'o KPI eilutė.

import type { SessionFileEvent, SessionFileEventKind } from "../../application/learning/session-file-events.js";
import {
  sessionWriteOwnersPath,
  type SessionWriteIdentity,
} from "../../application/task-execution/session-write-owners.js";
import { isOutsideProjectPath } from "../../domain/git/changes.js";
import {
  acquireLedgerLock,
  ledgerErrorText,
  ledgerLockTiming,
  releaseLedgerLock,
} from "./ledger-lock.js";
import {
  type PostHookContext,
  type PostHookDeps,
  changesLogPath,
  postHookContext,
  relativeToProject,
  runtimeStatePath,
} from "./post-hook-context.js";
import { POST_TOOL_OK_EXIT_CODE } from "./post-hooks.js";
import { runPostWriteGuards, type PostWriteGuardsDeps } from "./post-write-guards.js";
import {
  appendJsonArrayEntry,
  recordSessionWriteOwner,
  type JsonArrayAppendResult,
} from "./session-write-ledger.js";
import { getHookPathField, getHookToolName, getToolResponse, parseHookInput } from "./protocol.js";

export type SessionWriteAppendResult = JsonArrayAppendResult;

/**
 * Įrašo vieną kelią į session-writes ledger'į atominiu (serializuotu + rename) būdu.
 *
 * Neįgijus lock'o NERAŠOMA IŠ VISO (`onLockTimeout: "drop"`): prarandame tik SAVO įrašą, kurį
 * kvietėjas garsiai užlogina, bet niekada nesugadiname kitų procesų įrašų. `appended: false`
 * grįžta ir tada, kai lock'as rašymo metu buvo iš mūsų perimtas kaip stale — tada
 * serializacijos garantijų nebeliko ir tvirtinti, kad įrašas išliko, būtų melas.
 */
export async function appendSessionWrite(
  context: PostHookContext,
  sessionWritesPath: string,
  entry: string,
  lockWaitMs: number = ledgerLockTiming.timeoutMs,
  identity?: SessionWriteIdentity,
): Promise<SessionWriteAppendResult> {
  const fs = context.deps.ports.fs;
  return await appendJsonArrayEntry(fs, sessionWritesPath, entry, {
    lockWaitMs,
    onLockTimeout: "drop",
    // Nuosavybės sidecar'as rašomas TOJE PAČIOJE kritinėje sekcijoje kaip ir ledger'is:
    // atskiras lock'as leistų dviem rašytojams pamatyti nesuderintas dviejų failų versijas, o
    // Stop hook'as tada arba paliktų savo darbą necommit'intą, arba commit'intų svetimą.
    ...(identity === undefined
      ? {}
      : {
          withinLock: () =>
            recordSessionWriteOwner(fs, sessionWriteOwnersPath(sessionWritesPath), entry, identity),
        }),
  });
}

export type SessionFileEventAppendResult = {
  appended: boolean;
  /** Kodėl įvykis prarastas. Yra TIK kai `appended === false`. */
  failure?: string;
};

/**
 * Įrašo vieną klasifikuotą įvykį į `vq/state/session-file-events.jsonl`.
 *
 * Append-only JSONL, o ne read-modify-write JSON: eilutė pridedama vienu append'u, tad
 * skaitytojas blogiausiu atveju mato paskutinę eilutę be `\n` — tolerantiškas parseris tokią
 * praleidžia. Lock'as vis tiek imamas (lygiagretūs hook procesai; Windows append be
 * serializacijos nėra atominis), bet jis gyvena ATSKIRAME `<eventsPath>.lock` faile, tad KPI
 * telemetrija niekada nelaukia korektiškumui kritinio `session-writes.json` lock'o.
 */
export async function appendSessionFileEvent(
  context: PostHookContext,
  eventsPath: string,
  event: SessionFileEvent,
  lockWaitMs: number = ledgerLockTiming.timeoutMs,
): Promise<SessionFileEventAppendResult> {
  const fs = context.deps.ports.fs;
  const lockPath = `${eventsPath}.lock`;
  const token = await acquireLedgerLock(fs, lockPath, Date.now() + lockWaitMs);
  if (!token) {
    return { appended: false, failure: `lock not acquired within ${lockWaitMs}ms` };
  }

  let outcome: SessionFileEventAppendResult;
  try {
    await fs.appendTextFile(eventsPath, `${JSON.stringify(event)}\n`);
    outcome = { appended: true };
  } catch (error) {
    outcome = { appended: false, failure: `event write failed: ${ledgerErrorText(error)}` };
  }

  if ((await releaseLedgerLock(fs, lockPath, token)) === "stolen") {
    return {
      appended: false,
      failure: `${outcome.failure ?? "event written"}; lock was reclaimed by another writer mid-append`,
    };
  }
  return outcome;
}

/**
 * Ką ką tik įvykęs rašymas padarė failui: `created`, `modified`, ar nežinia.
 *
 * Klasifikuojama BŪTENT čia, o ne vėliau ataskaitoje: `git status` po commit'o rodo švarų medį,
 * tad vėlyvas skaitytojas visus sesijos failus mato kaip nepakeistus. Signalai imami
 * pigiausias-pirma, o nepasakius nė vienam grąžinama `unknown` — spėti „modified" draudžiama,
 * nes klaidingas skaičius blogiau nei sąžiningas nulis.
 */
export async function classifySessionFileWrite(
  context: PostHookContext,
  input: Record<string, unknown>,
  normalized: string,
): Promise<SessionFileEventKind> {
  const fromResponse = classifyFromToolResponse(getToolResponse(input));
  if (fromResponse) return fromResponse;

  // Edit/NotebookEdit reikalauja egzistuojančio failo, tad sukurti jo negali. `Write` gali abu,
  // o nežinomas įrankis (tuščias `tool_name`, MCP rašytojas) nesako nieko.
  const toolName = getHookToolName(input);
  if (toolName === "Edit" || toolName === "NotebookEdit") return "modified";
  if (toolName !== "Write") return "unknown";

  return await classifyByGitStatus(context, normalized);
}

/**
 * Claude Code `tool_response` signalai. Jie priklauso nuo konkretaus build'o, tad traktuojami
 * kaip signalas, o ne kontraktas: neatpažintas atsakymas grąžina `undefined` ir klasifikacija
 * krenta į kitą pakopą, o ne į spėjimą.
 */
function classifyFromToolResponse(response: unknown): SessionFileEventKind | undefined {
  if (!response || typeof response !== "object") return undefined;
  const record = response as Record<string, unknown>;
  if (record["type"] === "create") return "created";
  if (record["type"] === "update") return "modified";
  // Edit grąžina `oldString`, Write/Edit atsakymai su turiniu — `originalFile`: abu reiškia, kad
  // failas prieš rašymą JAU egzistavo. Tuščia reikšmė nieko neįrodo (naujas failas irgi
  // „tuščias"), tad ji tyčia nelaikoma signalu.
  if (isNonEmptyString(record["originalFile"]) || isNonEmptyString(record["oldString"])) return "modified";
  return undefined;
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value !== "";
}

/**
 * Paskutinė pakopa `Write` atvejui: vieno kelio `git status`. Ribojama `-- <path>`, kad kaina
 * nepriklausytų nuo darbo medžio dydžio, ir kviečiama tik pirmą kartą matomam keliui, tad vienas
 * failas kainuoja ne daugiau kaip vieną procesą per sesiją. Ne-nulinis git kodas (nėra repo,
 * nėra git) reiškia „nežinau".
 *
 * `--ignored=matching` yra būtinas, o ne kosmetinis: be jo gitignore'intas kelias (`vq/state`,
 * `vq/logs`, `AG/tasks/...`) duoda TUŠČIĄ išvedimą su kodu 0 — lygiai kaip tracked-ir-švarus
 * failas, ir naujas failas tokiame kataloge virstų „modified", t. y. tuo pačiu spėjimu, kurį šis
 * žurnalas ir turėjo pakeisti. Su vėliava jis grįžta kaip `!!` ir sąžiningai lieka `unknown`.
 */
async function classifyByGitStatus(context: PostHookContext, normalized: string): Promise<SessionFileEventKind> {
  const status = await context.deps.ports
    .gitStatusForPath(context.root, normalized)
    .catch(() => ({ code: 1, stdout: "" }));
  if (status.code !== 0) return "unknown";

  const line = status.stdout.split(/\r?\n/).find(Boolean) ?? "";
  const code = line.slice(0, 2);
  if (code === "!!") return "unknown";
  if (code === "??" || code.includes("A")) return "created";
  return "modified";
}

/**
 * KPI įvykio užrašymas: klasifikacija + viena JSONL eilutė. Visiškai best-effort ir TYLESNIS už
 * ledger'į — čia prarandama tik dashboard'o skaičiaus dalis, tad žymė sava ir niekada nemaišoma
 * su ledger'io signalu.
 */
async function recordSessionFileEvent(
  context: PostHookContext,
  input: Record<string, unknown>,
  normalized: string,
): Promise<void> {
  try {
    const kind = await classifySessionFileWrite(context, input, normalized);
    const append = await appendSessionFileEvent(context, runtimeStatePath(context, "session-file-events.jsonl"), {
      path: normalized,
      kind,
      ts: context.now().toISOString(),
    });
    if (!append.appended) {
      await context.log(
        `session-file-events: file_event_append_failed=1 path=${normalized} ` +
          `reason=${append.failure ?? "unknown"}`,
      );
    }
  } catch {
    // Nė vienas klasifikacijos ar rašymo gedimas negali paliesti tool call'o: KPI telemetrija
    // yra stebėjimas, ne kontrolė.
  }
}

/**
 * Kas rašo į ledger'į — sesijos tapatybė, fiksuojama RAŠYMO metu.
 *
 * Rašymo metu, nes tik čia ji apskritai žinoma: `AG_DISPATCH_NONCE` paveldi visi šios sesijos
 * hook procesai, o `session_id` yra hook payload'e, kurio Stop hook'as neskaito. Abi žinomos
 * tapatybės rašomos kartu: nonce leidžia dispatch'o Stop hook'ui atpažinti savo darbą,
 * `session:<id>` lieka diagnozei.
 *
 * `taskId` rašomas TIK dispatch'intoms sesijoms. Interaktyvi sesija tame pačiame darbo medyje
 * mato tą patį globalų `current-task-id`, tad jos rašymų žymėjimas task'u reikštų, kad svetimas
 * WIP vėl atrodytų kaip šio task'o darbas — būtent tai, ką ši tapatybė ir turi atskirti.
 */
export async function resolveWriterIdentity(
  context: PostHookContext,
  input: Record<string, unknown>,
): Promise<SessionWriteIdentity> {
  const nonce = (context.deps.ports.env("AG_DISPATCH_NONCE") ?? "").trim();
  const rawSessionId = input["session_id"];
  const sessionId = typeof rawSessionId === "string" ? rawSessionId.trim() : "";
  const session = nonce || (sessionId ? `session:${sessionId}` : "");
  if (!nonce) {
    return { session, taskId: "" };
  }
  const taskId = await context.deps.ports.fs.readTextFileIfExists(runtimeStatePath(context, "current-task-id"));
  return { session, taskId: (taskId ?? "").trim() };
}

export type PostWriteDeps = PostHookDeps & {
  /** Guard'ų fan-out'o portai; be jų guard'ai praleidžiami (žurnalas vis tiek rašomas). */
  guards?: PostWriteGuardsDeps;
};

export async function hookPostWrite(deps: PostWriteDeps): Promise<number> {
  const context = postHookContext(deps);
  const input = parseHookInput(await context.deps.ports.stdin.readStdin());
  const filePath = getHookPathField(input);

  await context.deps.ports.fs
    .appendTextFile(changesLogPath(context.runtimeRoot), `[${context.now().toISOString()}] MODIFIED: ${filePath}\n`)
    .catch(() => undefined);
  await context.log(`post-write: ${filePath}`);

  // Sesijos rašymų sąrašas: package-guard pagal jį atskiria šios sesijos pakeitimus nuo
  // lygiagrečios sesijos darbo toje pačioje darbo kopijoje. Rašymai už repo ribų (pvz. Claude
  // atminties failai) į ledger'į nededami — jie nėra produkto pakeitimai ir diagnozėje virstų
  // klaidingu out-of-scope human_review.
  const normalized = relativeToProject(context, filePath);
  if (normalized && !isOutsideProjectPath(normalized)) {
    await recordSessionWrite(context, input, normalized);
  }

  if (deps.guards) {
    await runPostWriteGuards(deps.guards).catch(() => undefined);
  }
  return POST_TOOL_OK_EXIT_CODE;
}

async function recordSessionWrite(
  context: PostHookContext,
  input: Record<string, unknown>,
  normalized: string,
): Promise<void> {
  const ledgerPath = runtimeStatePath(context, "session-writes.json");
  const identity = await resolveWriterIdentity(context, input);
  const append = await appendSessionWrite(context, ledgerPath, normalized, ledgerLockTiming.timeoutMs, identity);

  if (!append.appended) {
    // Vienintelis likęs praradimo scenarijus turi būti GARSUS: failas pakeistas, bet Stop
    // hook'as jo nebestage'ins ir package-guard laikys jį svetimos sesijos darbu.
    await context.log(
      `session-writes ledger: ledger_append_failed=1 path=${normalized} ` +
        `waited_ms=${append.waitedMs} reason=${append.failure ?? "unknown"}`,
    );
  } else if (append.ownerFailure !== undefined) {
    // ATSKIRA žymė: kelias ledger'yje YRA (Stop jį stage'ins), prarasta tik jo tapatybė — toks
    // kelias grįžta į saugią „legacy" būseną. `ledger_append_failed=1` čia reikštų
    // necommit'intą darbą, t. y. meluotų diagnozei.
    await context.log(
      `session-writes ledger: owner_sidecar_failed=1 path=${normalized} reason=${append.ownerFailure}`,
    );
  }

  if (append.appended && !append.alreadyPresent) {
    // KPI įvykis rašomas TIK pirmą kartą pamačius kelią: taip git probe'as vienam failui įvyksta
    // ne daugiau kaip kartą, o JSONL turi po vieną eilutę keliui — nors tą patį failą sesija
    // perrašo dešimtis kartų.
    await recordSessionFileEvent(context, input, normalized);
  }
}
