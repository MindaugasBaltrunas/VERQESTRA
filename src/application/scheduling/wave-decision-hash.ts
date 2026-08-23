// Bangos SPRENDIMO atspaudas: kas iš tikrųjų lėmė, kurie task'ai bus vykdomi.
//
// NUKRYPIMAS nuo etalono (griežtinantis, 2026-08-23, operatoriaus radinys). Bangos tapatybė
// (`wave_id`, `graph_hash`) skaičiuojama TIK iš eilės pjūvio — ID, failų ir priklausomybių.
// Į ją nepatenka niekas, kas keičia vykdymo sprendimą: patvirtinimai, mazgų statusai, biudžetas
// ir vartų politika. Atkurta prieš gyvą kodą — keturi skirtingi planai, viena tapatybė:
//
//   open                  wave_id=w1-11ffc0dc…  final_ready=["a"]
//   approval-required     wave_id=w1-11ffc0dc…  final_ready=[]
//   approval + runtime ok wave_id=w1-11ffc0dc…  final_ready=["a"]
//   biudžetas nepakanka   wave_id=w1-11ffc0dc…  final_ready=[]
//   enforce: []           wave_id=w1-11ffc0dc…  final_ready=["a"]
//
// Trys iš jų nematomi NET kanoniniam `tg` hash'ui: runtime patvirtinimai, biudžetas ir `enforce`
// gyvena iškvietėjo pusėje, ne grafe. Tai yra tiesioginė rizika, o ne estetika: `recoverFromCrash`
// pagal `graph_hash` sutapimą tęsia tą pačią bangą, tad po kritimo atkurtas planas galėjo remtis
// leidimu, kurio nebėra.
//
// Sprendimas: atskiras `decision_hash`. Jis apima bangos hash'ą, kanoninio grafo hash'ą IR
// ready-set VERDIKTUS. Verdiktai pasirinkti sąmoningai vietoj įėjimų sąrašo: kiekvienas vartas —
// ir esamas, ir būsimas — pasireiškia verdiktu, tad naujas įėjimas negali atsirasti nepatekęs į
// atspaudą. Įėjimų vardijimas reikalautų prisiminti kiekvieną naują; verdiktai to nereikalauja.
import { canonicalJsonStringify } from "../../shared/json.js";
import { sha256Hex } from "../../shared/hash.js";
// Vartų vardai imami iš `build-ready-set`, o ne iš `apply-ready-set-gates`: pastarasis importuoja
// šį modulį, tad priešinga kryptis uždarytų importų ciklą, kurio draudžia architektūros vartai.
import type { ReadySet, ReadySetBlockedReason } from "./build-ready-set.js";

/** Sprendimo taisyklių versija. Pakeitus, ką atspaudas apima, seni įrašai privalo nesutapti. */
export const WAVE_DECISION_VERSION = 1;

export type WaveDecisionInput = {
  /** Bangos pjūvio atspaudas (`wg…`) — kurie task'ai apskritai svarstomi. */
  waveGraphHash: string;
  /** Kanoninio grafo verdiktai. `undefined` = sprendimas priimtas be autoriteto. */
  readySet?: ReadySet | undefined;
  /** Faktiškai taikytų vartų rinkinys. */
  enforced?: Iterable<ReadySetBlockedReason> | undefined;
  /** `true`, kai grafo perskaityti nepavyko: toks planas niekada neprilygsta jokiam kitam. */
  unavailable?: boolean;
};

/**
 * `dh<versija>:<sha256 pirmi 16 hex>`.
 *
 * Atskiras nuo `wave_id` sąmoningai: `wave_id` atsako „kuri tai banga" ir turi likti stabilus,
 * kad įvykiai bei snapshot'ai liktų vienoje istorijoje; `decision_hash` atsako „ar tai TAS PATS
 * sprendimas". Sulieti juos reikštų, kad patvirtinus vieną task'ą banga pasikeičia vardą.
 */
export function computeWaveDecisionHash(input: WaveDecisionInput): string {
  const enforced = [...(input.enforced ?? [])].sort();
  const payload = {
    rules: WAVE_DECISION_VERSION,
    wave: input.waveGraphHash,
    // Grafo lygio būsena: statusai, `requires_approval`/`approved` ir įverčiai jau yra `tg` viduje.
    graph: input.unavailable === true ? null : (input.readySet?.graph_hash ?? null),
    unavailable: input.unavailable === true,
    executable: input.readySet?.executable ?? null,
    // Verdiktai — vieta, kurioje pasimato runtime patvirtinimai, biudžetas ir statusų perrašymai.
    ready: [...(input.readySet?.ready ?? [])].map((task) => task.task_id).sort(),
    blocked: [...(input.readySet?.blocked ?? [])]
      .map((task) => [task.task_id, task.reason] as const)
      .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1])),
    gates: enforced,
  };
  return `dh${WAVE_DECISION_VERSION}:${sha256Hex(canonicalJsonStringify(payload)).slice(0, 16)}`;
}
