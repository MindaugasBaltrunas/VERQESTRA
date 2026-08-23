// Diagnostiniai rašymai, kurie NIEKADA nenutraukia bangos — vienas adapteris visiems keliams.
//
// NUKRYPIMAS nuo etalono (griežtinantis, 2026-08-23, operatoriaus radinys). `wave-scheduler`
// antraštė deklaruoja trečią taisyklę — „telemetrija bangos NIEKADA nenutraukia" — ir tam turėjo
// vietinius `safeLog`/`safeEvent`. Bet į sub-koordinatorius keliavo NEAPSAUGOTI `deps.log` ir
// `deps.recordEvent`, tad taisyklė galiojo tik ten, kur ją prisiminė kviečiantysis. Atkurta prieš
// gyvą kodą (`wave-graph.refresh`):
//
//   importas lūžo, log veikia   → kind=unavailable      (teisinga)
//   importas lūžo, log lūžo     → METĖ Error: log       (fail-closed kelias PATS nulūžta)
//   importas lūžo, event lūžo   → METĖ Error: event
//   importas VEIKIA, log lūžo   → METĖ Error: log       (krenta ir SVEIKAS kelias)
//
// Paskutinė eilutė yra sunkiausia: `TASK GRAPH SNAPSHOT` eilutė rašoma ir sėkmės kelyje, tad
// Windows EPERM ant JSONL append nutraukdavo bangą, kurios grafas visiškai tvarkingas. O antroji
// eilutė reiškia, kad nulūždavo būtent tas kelias, kuris egzistuoja gedimui apdoroti.
//
// Todėl wrapper'is gyvena ATSKIRAI, o ne kiekvieno modulio viduje: du kviečiantieji (planuoklis ir
// kompozicijos aprūpinimas) turi gauti tą patį elgesį, o naujas kelias neturi galimybės jo
// „pamiršti" — jis paprasčiausiai neturi iš kur paimti neapsaugotų portų.
import type { WavePoolEvent } from "./wave-pool-planning.js";

export type TelemetryPorts = {
  log: (message: string) => Promise<void>;
  recordEvent: (event: WavePoolEvent) => Promise<void>;
};

export type SafeTelemetry = {
  /** Rašo žurnalą; nesėkmė nutylima. Žurnalo įrašas yra pėdsakas, ne vartas. */
  safeLog: (message: string) => Promise<void>;
  /** Rašo įvykį; nesėkmė nutylima. Ta pati taisyklė kaip `safeLog`. */
  safeEvent: (event: WavePoolEvent) => Promise<void>;
};

/**
 * Suriša portus į formą, kurios nesėkmė nematoma iškvietėjui.
 *
 * Sąmoningai NEGRĄŽINA jokio signalo apie nutylėtą klaidą: signalas reikštų, kad iškvietėjas gali
 * jį tikrinti, o tikrinamas signalas anksčiau ar vėliau tampa vartu. Prarastas įrašas pigesnis nei
 * nutraukta banga — integracijos kelyje įvykių rašymų yra iki `2N+1`.
 */
export function createSafeTelemetry(ports: TelemetryPorts): SafeTelemetry {
  return {
    safeLog: async (message) => {
      try {
        await ports.log(message);
      } catch {
        // Tyčia tuščia.
      }
    },
    safeEvent: async (event) => {
      try {
        await ports.recordEvent(event);
      } catch {
        // Tyčia tuščia.
      }
    },
  };
}

/** Tik žurnalui — keliams, kurie įvykių nerašo (pvz. aprūpinimas kompozicijoje). */
export function createSafeLog(log: TelemetryPorts["log"]): TelemetryPorts["log"] {
  return createSafeTelemetry({ log, recordEvent: () => Promise.resolve() }).safeLog;
}
