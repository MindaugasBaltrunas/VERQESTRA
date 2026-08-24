import { TerminalOutputSanitizer } from "../domain/terminal-output-sanitizer.js";
import {
  TerminalReplayBuffer,
  type TerminalOutputEvent,
} from "../domain/terminal-replay-buffer.js";

export class TerminalOutputPipeline {
  constructor(
    private readonly sanitizer: TerminalOutputSanitizer,
    private readonly replay: TerminalReplayBuffer,
  ) {}

  push(rawTerminalData: string, now = new Date()): readonly TerminalOutputEvent[] {
    return this.replay.append(this.sanitizer.push(rawTerminalData), now);
  }

  flush(now = new Date()): readonly TerminalOutputEvent[] {
    return this.replay.append(this.sanitizer.flush(), now);
  }
}
