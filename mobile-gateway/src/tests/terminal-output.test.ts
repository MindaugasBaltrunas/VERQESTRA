import assert from "node:assert/strict";
import test from "node:test";
import { TerminalOutputPipeline } from "../application/terminal-output-pipeline.js";
import {
  SECRET_TRIGGER_OPENINGS,
  TerminalOutputSanitizer,
} from "../domain/terminal-output-sanitizer.js";
import {
  MAX_TERMINAL_FRAME_BYTES,
  MAX_TERMINAL_REPLAY_BYTES,
  TerminalReplayBuffer,
} from "../domain/terminal-replay-buffer.js";

// Etalone šie taškai užrašyti backslash-u escape'ais tiesiai literaluose. Čia jie yra
// konstantos — ta pati forma, kurią naudoja `domain/terminal-output-sanitizer.ts`, ir dėl tos
// pačios priežasties: failas, tikrinantis valdymo sekų šalinimą, pats neturi nešti nė vieno
// neapdoroto valdymo baito. Reikšmės identiškos, tad tikrinami įvesties srautai nepakito.
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const C1_CSI = String.fromCharCode(0x9b);
const C1_OSC = String.fromCharCode(0x9d);
const C1_ST = String.fromCharCode(0x9c);
const C1_DCS = String.fromCharCode(0x90);

const sessionId = "123e4567-e89b-42d3-a456-426614174000";

test("streaming sanitizer removes ANSI, OSC clipboard, titles and hyperlinks", () => {
  const sanitizer = new TerminalOutputSanitizer();
  let output = "";
  output += sanitizer.push(`before${ESC}[31mred${ESC}[0m `);
  output += sanitizer.push(`${ESC}]52;c;Y2xpcGJvYXJk`);
  output += sanitizer.push(`${BEL}after `);
  output += sanitizer.push(`${ESC}]0;malicious-title${ESC}\\`);
  output += sanitizer.push(`${ESC}]8;;https://attacker.invalid${ESC}\\safe label`);
  output += sanitizer.push(`${ESC}]8;;${ESC}\\ end${BEL}`);
  output += sanitizer.push(`${C1_OSC}52;c;YzEtY2xpcGJvYXJk${C1_ST} c1-safe`);
  output += sanitizer.push(`${C1_CSI}31mc1-color${C1_DCS}hidden-dcs${C1_ST}`);
  output += sanitizer.flush();
  assert.equal(output, "beforered after safe label end c1-safec1-color");
  assert.doesNotMatch(
    output,
    new RegExp("clipboard|attacker|malicious-title|hidden-dcs|\\u001b|\\u0007"),
  );
});

test("secret redaction survives chunk boundaries and long unterminated values", () => {
  const sanitizer = new TerminalOutputSanitizer();
  let output = "";
  output += sanitizer.push("token ghp_1234");
  output += sanitizer.push("567890ABCDEF and PASSWORD=su");
  output += sanitizer.push("per-secret\nBearer abc.def.ghi");
  output += sanitizer.flush();
  assert.equal(output.includes("ghp_1234567890ABCDEF"), false);
  assert.equal(output.includes("super-secret"), false);
  assert.equal(output.includes("abc.def.ghi"), false);
  assert.match(output, /\[REDACTED\]/);

  const huge = new TerminalOutputSanitizer();
  const first = huge.push(`TOKEN=${"x".repeat(70_000)}`);
  const resumed = huge.push(" done");
  const final = huge.flush();
  assert.equal(`${first}${resumed}${final}`.includes("x".repeat(100)), false);
  assert.match(`${first}${resumed}${final}`, /\[REDACTED\]/);
  assert.match(`${first}${resumed}${final}`, /done/);
});

test("replay splits UTF-8 frames, keeps strict sequence and reports truncation", () => {
  const now = new Date("2026-07-26T10:00:00.000Z");
  const replay = new TerminalReplayBuffer(sessionId, 8 * 1024 * 1024, 60_000, 2);
  const large = `a${"🙂".repeat(20_000)}z`;
  const frames = replay.append(large, now);
  assert.equal(frames.length, 2);
  assert.deepEqual(frames.map(({ sequence }) => sequence), [1, 2]);
  assert.equal(frames.map(({ data }) => data).join(""), large);
  assert.equal(
    frames.every(({ data }) => Buffer.byteLength(data, "utf8") <= MAX_TERMINAL_FRAME_BYTES),
    true,
  );
  const third = replay.append("third", now);
  assert.equal(third[0]?.sequence, 3);
  assert.equal(replay.snapshot().retainedEvents, 2);
  assert.deepEqual(
    replay.replayAfter(1, now).events.map(({ sequence }) => sequence),
    [2, 3],
  );
  const truncated = replay.replayAfter(0, now);
  assert.equal(truncated.historyTruncated, true);
  assert.deepEqual(truncated.events, []);
  assert.equal(truncated.nextSequence, 4);
});

test("replay retention is time and byte bounded", () => {
  const start = new Date("2026-07-26T10:00:00.000Z");
  const replay = new TerminalReplayBuffer(sessionId, 10, 1_000, 10);
  replay.append("12345678", start);
  replay.append("abcdefgh", start);
  assert.equal(replay.snapshot().retainedBytes <= 10, true);
  assert.equal(replay.replayAfter(1, start).historyTruncated, false);
  const expired = replay.replayAfter(2, new Date("2026-07-26T10:00:01.001Z"));
  assert.equal(expired.events.length, 0);
  assert.equal(replay.snapshot().retainedBytes, 0);
  assert.throws(() => replay.replayAfter(3, start), /sequence is invalid/);
});

test("short idle output is emitted immediately instead of waiting for a flush", () => {
  const sanitizer = new TerminalOutputSanitizer();
  // Nothing here can begin a secret, so nothing may be withheld: an interactive
  // prompt must reach the phone before the next write or the session close.
  assert.equal(sanitizer.push("$ npm test\n"), "$ npm test\n");
  assert.equal(sanitizer.push("ok 1 - passing\n"), "ok 1 - passing\n");
  assert.equal(sanitizer.flush(), "");

  // A tail that COULD still grow into a trigger is still held back.
  assert.equal(sanitizer.push("value sk"), "value ");
  assert.equal(sanitizer.push("-abcdefghij rest "), `${"[REDACTED]"} rest `);
});

test("splitting a secret at any chunk boundary never leaks it", () => {
  // Fixtures are derived from the redactor's own trigger list, so a newly
  // supported pattern is covered automatically and no credential-shaped literal
  // is committed to the repository.
  const keywordTriggers = new Set(["token", "secret", "password", "api_key", "api-key", "apikey"]);
  const opaqueBody = "abcdefghijklmnop";
  const upperBody = "0123456789ABCDEF";
  const samples = SECRET_TRIGGER_OPENINGS.map((opening) => {
    if (opening === "bearer") return { secret: `Bearer ${opaqueBody}`, body: opaqueBody };
    if (opening === "akia") {
      return { secret: `${opening.toUpperCase()}${upperBody}`, body: upperBody };
    }
    if (keywordTriggers.has(opening)) {
      return { secret: `${opening.toUpperCase()}=${opaqueBody}`, body: opaqueBody };
    }
    return { secret: `${opening}${opaqueBody}`, body: opaqueBody };
  });
  assert.equal(samples.length, SECRET_TRIGGER_OPENINGS.length);

  for (const { secret, body } of samples) {
    const line = `prefix ${secret} suffix`;
    for (let split = 0; split <= line.length; split += 1) {
      const sanitizer = new TerminalOutputSanitizer();
      const emitted = sanitizer.push(line.slice(0, split))
        + sanitizer.push(line.slice(split))
        + sanitizer.flush();
      assert.equal(
        emitted.includes(body),
        false,
        `secret leaked for "${secret}" split at ${split}: ${emitted}`,
      );
    }
  }
});

test("an output flood at production limits stays byte- and event-bounded", () => {
  // `verification-matrix.md` requires proof of bounded memory under an output
  // flood. The retention test above exercises the pruning branch with tiny
  // limits; this one drives the real 8 MiB / 64 KiB / 4096-event budget through
  // the full sanitize + replay path. Twice the retention cap is the point where
  // sustained eviction is proven — more only buys wall-clock time, and the
  // per-character UTF-8 framing makes this test cost roughly a second per MiB.
  const now = new Date("2026-07-26T10:00:00.000Z");
  const replay = new TerminalReplayBuffer(sessionId);
  const pipeline = new TerminalOutputPipeline(new TerminalOutputSanitizer(), replay);
  const chunk = "x".repeat(256 * 1024);
  const floodBytes = 2 * MAX_TERMINAL_REPLAY_BYTES;

  let lastSequence = 0;
  for (let written = 0; written < floodBytes; written += chunk.length) {
    for (const event of pipeline.flush(now)) {
      assert.equal(event.sequence > lastSequence, true, "sequence must stay strictly increasing");
      lastSequence = event.sequence;
      assert.equal(
        new TextEncoder().encode(event.data).byteLength <= MAX_TERMINAL_FRAME_BYTES,
        true,
      );
    }
    pipeline.push(chunk, now);
  }

  const snapshot = replay.snapshot();
  assert.equal(snapshot.retainedBytes <= MAX_TERMINAL_REPLAY_BYTES, true);
  assert.equal(snapshot.retainedEvents <= 4096, true);
  assert.equal(snapshot.nextSequence > floodBytes / MAX_TERMINAL_FRAME_BYTES, true);

  // The client is told history was dropped rather than being handed a gap.
  assert.equal(replay.replayAfter(1, now).historyTruncated, true);
});

test("pipeline stores only sanitized terminal data", () => {
  const replay = new TerminalReplayBuffer(sessionId);
  const pipeline = new TerminalOutputPipeline(new TerminalOutputSanitizer(), replay);
  const now = new Date("2026-07-26T10:00:00.000Z");
  pipeline.push(`${ESC}]52;c;ZXZpbA==${BEL}TOKEN=secret-canary`, now);
  const events = pipeline.flush(now);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.data.includes("secret-canary"), false);
  assert.equal(events[0]?.data.includes(ESC), false);
  const retained = replay.replayAfter(0, now).events[0];
  assert.equal(retained?.type, "server.output");
  assert.equal(retained?.type === "server.output" ? retained.data : undefined, "TOKEN=[REDACTED]");
});
