// Agentų aktyvumo SSE srautas dashboard'ui (etalonas: AG_loop ui/sse-service.ts).
//
// Trys sprendimai, kurie yra šio modulio kontraktas:
//
//   1. NAUJAS KLIENTAS VISADA GAUNA ŠVIEŽIĄ BŪSENĄ. Kešuotas „paskutinis aktyvumas" atnaujinamas
//      tik pasikeitus stebimam failui, tad prisijungęs klientas matydavo valandos senumo grandinę.
//   2. KEEPALIVE YRA BŪTINAS. Kai loop'as neaktyvus, kanalu NIEKADA niekas neteka, o tyliai miręs
//      TCP ryšys (NAT/OS idle timeout, laptop sleep) klientui atrodo gyvas — skaitymas kabo
//      neribotai ir grandinė užstringa be jokio požymio.
//   3. PRAĖJIMAI NEPERSIDENGIA. Aktyvumo skaitymas išparsina VISĄ Claude log'ą, kuris aktyvaus
//      dispatch'o metu yra megabaitų dydžio; be re-entrancy vartų 1,5 s intervalas kaupdavo
//      praėjimus būtent didžiausios apkrovos metu.
//
// VERQESTRA nukrypimas: bandymo namespace'o keliai, bangos snapshot'as ir stop įrodymas ateina per
// PORTUS — jų realizacija gyvena runtime sluoksnyje (VQ-504), o vaizdas nuo jo nepriklauso.

import type { AgentActivity } from "../ui-model/agent-activity.js";
import type { UiSlotActivity } from "../ui-model/control-plane-model.js";

/** Kur rašomas srautas. Minimalus `ServerResponse` pjūvis — testas jo nekuria per tikrą HTTP. */
export type SseClient = {
  write(chunk: string): void;
  on(event: "close" | "error", listener: () => void): void;
};

/** Vieno gyvo slot'o attempt-scoped šaltiniai; sudaromi VIENĄ kartą per praėjimą. */
export type SseLiveSlotSource = {
  worker_id: string;
  task_id: string;
  attempt: number;
  /** Repo-relatyvus posix kelias rodymui — kilmė matoma, o ne nutylima. */
  log_path: string;
  logPath: string;
  taskFilePath: string;
};

/** Einamojo bandymo pjūvis: ką stebėti ir iš kur paimtas stop įrodymas. */
export type SseActiveAttempt = {
  taskId: string;
  /** Bandymo artefaktai, kurių pokytis yra įvykis (stop būsena, Claude log'as). */
  watchFiles: string[];
  /** `legacy` reiškia, kad šiam task'ui bandymo kopijos dar nėra ir rodomas globalus veidrodis. */
  stopStatusSource: string;
};

export type SseActivityPayload = AgentActivity & {
  stopStatusSource: string;
  /** Praleidžiamas visai, kai gyvo slot'o nėra — tuščias masyvas nieko nepasakytų daugiau. */
  slots?: UiSlotActivity[];
};

export type SsePorts = {
  /** Failo mtime ms; nesamas failas — 0 (nebuvimas irgi yra būsena, kurios pokytis matomas). */
  fileMtimeMs(absolutePath: string): Promise<number>;
  /** Globalus (loop lygio) aktyvumas — jį skaito ir dar neatnaujintas frontend'as. */
  readGlobalActivity(): Promise<AgentActivity>;
  /** Vieno slot'o aktyvumas iš JO bandymo artefaktų. */
  readSlotActivity(source: SseLiveSlotSource): Promise<AgentActivity>;
  /**
   * Gyvi slot'ai su jų bandymo keliais. Snapshot'as yra tik ATASKAITA, tad jo klaida negali
   * nuversti srauto: nesėkmė reiškia „gyvų slot'ų nežinome" ir grąžina tuščią sąrašą.
   */
  readLiveSlotSources(): Promise<SseLiveSlotSource[]>;
  /**
   * Einamojo bandymo namespace TIK skaitymui. Adapteris PRIVALO išvalyti bandymo rezoliucijos kešą
   * prieš skaitymą: ji memoizuoja sėkmę visam procesui, o šis kelias pollinamas kas 1,5 s, tad
   * `a1 -> a2` retry perėjimas kitaip amžinai užšaldytų SENO bandymo įrodymą.
   */
  readActiveAttempt(): Promise<SseActiveAttempt | undefined>;
  /** Globalūs veidrodžiai ir bangos snapshot'as — stebimi visada. */
  legacyWatchFiles(): string[];
  setInterval(handler: () => void, ms: number): { clear(): void };
};

export const SSE_POLL_INTERVAL_MS = 1500;

/**
 * Kas tiek laiko siunčiamas SSE komentaras, net jei niekas nepasikeitė. Žr. modulio antraštės
 * antrą punktą — be jo miręs ryšys klientui atrodo gyvas.
 */
export const SSE_KEEPALIVE_INTERVAL_MS = 20_000;

export type SseHub = {
  addClient(client: SseClient): Promise<void>;
  /** Klientų skaičius — testams ir diagnostikai. */
  clientCount(): number;
  /** Vienas praėjimas: pokyčio patikra ir, jei reikia, transliacija. */
  checkAndBroadcast(): Promise<void>;
};

/**
 * Srauto centras. Sukuriamas VIENAS kompozicijoje: taimeriai ir stebimų failų žymės yra jo būsena,
 * o du egzemplioriai tą pačią eilutę transliuotų dukart.
 */
export function createSseHub(ports: SsePorts): SseHub {
  const clients = new Set<SseClient>();
  /**
   * Raktas yra KELIAS, ne indeksas: stebimų failų sąrašas dinamiškas (prie globalių prisideda
   * einamojo bandymo artefaktai), o indeksais raktuotos žymės pasislinktų kartu su sąrašu ir vienas
   * failas pasisavintų kito mtime.
   */
  const lastMtimes = new Map<string, number>();

  let pollTimer: { clear(): void } | undefined;
  let keepaliveTimer: { clear(): void } | undefined;
  let checkInFlight = false;

  const writeToClient = (client: SseClient, payload: string): void => {
    try {
      client.write(payload);
    } catch {
      // Rašymas į sunaikintą socket'ą — klientas paprasčiausiai išeina iš rinkinio.
      clients.delete(client);
    }
  };

  const broadcast = (payload: SseActivityPayload): void => {
    const encoded = `data: ${JSON.stringify(payload)}\n\n`;
    for (const client of clients) writeToClient(client, encoded);
  };

  const activityPayload = async (
    attempt: SseActiveAttempt | undefined,
    sources: SseLiveSlotSource[],
  ): Promise<SseActivityPayload> => {
    const [activity, slots] = await Promise.all([
      ports.readGlobalActivity(),
      Promise.all(
        sources.map(async (source) => ({
          worker_id: source.worker_id,
          task_id: source.task_id,
          attempt: source.attempt,
          log_path: source.log_path,
          activity: await ports.readSlotActivity(source),
        })),
      ),
    ]);

    return {
      ...activity,
      stopStatusSource: attempt?.stopStatusSource ?? "legacy",
      ...(slots.length === 0 ? {} : { slots }),
    };
  };

  const ensureTimers = (): void => {
    pollTimer ??= ports.setInterval(() => void checkAndBroadcast(), SSE_POLL_INTERVAL_MS);
    keepaliveTimer ??= ports.setInterval(() => {
      // SSE komentaras (`:` pradžia) — klientas jo neparsina kaip įvykio, bet baitai keliauja per
      // ryšį, tad miręs socket'as pasirodo iš karto, o ne po neribotos tylos.
      for (const client of clients) writeToClient(client, ": keepalive\n\n");
    }, SSE_KEEPALIVE_INTERVAL_MS);
  };

  const stopTimers = (): void => {
    pollTimer?.clear();
    keepaliveTimer?.clear();
    pollTimer = undefined;
    keepaliveTimer = undefined;
  };

  async function checkAndBroadcast(): Promise<void> {
    if (clients.size === 0 || checkInFlight) return;
    checkInFlight = true;
    try {
      const [attempt, sources] = await Promise.all([ports.readActiveAttempt(), ports.readLiveSlotSources()]);
      // Rinkinys: einamojo bandymo log'as ir gyvo slot'o log'as gali būti TAS PATS failas, o du to
      // paties kelio įrašai stebėjimui nieko neprideda.
      const watched = [
        ...new Set([
          ...ports.legacyWatchFiles(),
          ...(attempt?.watchFiles ?? []),
          ...sources.map((source) => source.logPath),
        ]),
      ];

      const mtimes = await Promise.all(watched.map((file) => ports.fileMtimeMs(file)));
      const changed = mtimes.some((mtime, index) => mtime !== (lastMtimes.get(watched[index] ?? "") ?? 0));
      if (!changed) return;

      mtimes.forEach((mtime, index) => lastMtimes.set(watched[index] ?? "", mtime));
      broadcast(await activityPayload(attempt, sources));
    } finally {
      checkInFlight = false;
    }
  }

  return {
    clientCount: () => clients.size,
    checkAndBroadcast,
    async addClient(client: SseClient): Promise<void> {
      clients.add(client);
      ensureTimers();

      const drop = (): void => {
        clients.delete(client);
        if (clients.size === 0) stopTimers();
      };
      client.on("close", drop);
      // Rašymas į sunaikintą socket'ą Node'e nemeta sinchroniškai — jis emit'ina `error`. Be šio
      // listener'io klaida keliautų iki neperimtos išimties, o klientas liktų rinkinyje.
      client.on("error", drop);

      // Naujas klientas visada gauna ŠVIEŽIĄ būseną (modulio antraštės pirmas punktas).
      const [attempt, sources] = await Promise.all([ports.readActiveAttempt(), ports.readLiveSlotSources()]);
      writeToClient(client, `data: ${JSON.stringify(await activityPayload(attempt, sources))}\n\n`);
    },
  };
}
