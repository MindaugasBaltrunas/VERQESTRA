import assert from "node:assert/strict";
import { presentTerminal } from "../controller/presentation/terminal-presenter.js";
import { reduceAppState, type AppEvent } from "../model/reducer.js";
import { initialAppState, type AppState } from "../model/state.js";
import type { TerminalActionId } from "../view/terminal-view-state.js";

/**
 * Shared doubles for the terminal presentation suites.
 *
 * SKAIDYMAS (VERQESTRA ≤500 eil. vartas; etalone `terminal-presentation.test.ts` buvo 542
 * eilutės). `liveState()` čia yra vienintelis apibrėžimas, ką reiškia „sesija veikia ir srautas
 * gyvas": abu rinkiniai nuo jo nukrypsta po vieną įvykį, tad dvi kopijos leistų vienai tyliai
 * pakeisti atskaitos tašką ir „štai kur mygtukas įjungtas" nustotų reikšti tą patį.
 */

export const projectId = "123e4567-e89b-42d3-a456-426614174040";

export function stateWith(...events: readonly AppEvent[]): AppState {
  return events.reduce(reduceAppState, initialAppState);
}

/** A session that is running and streaming. */
export function liveState(...extra: readonly AppEvent[]): AppState {
  return stateWith(
    { type: "project.selected", projectId },
    { type: "provider.selected", provider: "claude-code" },
    { type: "connection.changed", state: "live" },
    { type: "terminal.state", state: "live" },
    ...extra,
  );
}

export function action(state: AppState, id: TerminalActionId): { enabled: boolean } {
  const found = presentTerminal(state).actions.find((candidate) => candidate.id === id);
  assert.ok(found, `missing terminal action: ${id}`);
  return found;
}
