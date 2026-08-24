/**
 * Public surface of the mobile app core.
 *
 * NUKRYPIMAS (keliai ir vienas papildymas, ne eksportuojamų VARDŲ aibė):
 *  - `adapters/presentation/*` → `controller/presentation/*`, `composition/*` → `controller/*`
 *    (MVA → MVC);
 *  - kadangi `*ViewState` tipai iškelti iš presenterių į `view/*-view-state.ts`, jie
 *    eksportuojami iš ten. Be šitų penkių eilučių barelis būtų netekęs vardų, kuriuos etalone
 *    tiekė `export type { ... }` presenterių viduje — t. y. tylus public kontrakto siaurinimas.
 *
 * Ko čia NĖRA, tiksliai kaip etalone: `pairing-controller`, `push-notification-controller`,
 * `push-notification-adapter`, `biometrics`, `device-identity`, `secure-storage` ir `shared`.
 * Juos suriša kompozicijos šaknis (native kiautas), o ne branduolio barelis.
 */
export * from "./controller/presentation/ag-loop-presenter.js";
export * from "./controller/presentation/connections-presenter.js";
export * from "./controller/presentation/projects-presenter.js";
export * from "./controller/presentation/session-review-presenter.js";
export * from "./controller/presentation/terminal-presenter.js";
export * from "./view/ag-loop-view-state.js";
export * from "./view/connections-view-state.js";
export * from "./view/projects-view-state.js";
export * from "./view/session-review-view-state.js";
export * from "./view/terminal-view-state.js";
export * from "./adapters/network/terminal-stream-client.js";
export * from "./adapters/network/gateway-http-client.js";
export * from "./adapters/speech/push-to-talk-recorder.js";
export * from "./adapters/speech/cloud-consent-store.js";
export * from "./controller/ag-loop-read-controller.js";
export * from "./controller/connections-controller.js";
export * from "./controller/projects-controller.js";
export * from "./controller/session-review-controller.js";
export * from "./controller/terminal-stream-binding.js";
export * from "./controller/terminal-controller.js";
export * from "./controller/voice-capture-controller.js";
export * from "./model/ag-loop-read.js";
export * from "./model/connections-read.js";
export * from "./model/projects-read.js";
export * from "./model/read-channel.js";
export * from "./model/voice.js";
export * from "./model/session-review-read.js";
export * from "./model/ports.js";
export * from "./model/reducer.js";
export * from "./model/state.js";
export * from "./view/contracts.js";
