// Priklausomybių grafo primityvai virš GRYNO gretimumo žemėlapio `task → jo blokatoriai`.
//
// Kodėl atskirai nuo `traverse.ts`: tą pačią matematiką kviečia DU skirtingų sluoksnių skaitytojai —
// domain `traverse` (kanoninio grafo ėjimas) ir application `schedule-next-wave` (bangos planas).
// Iki 2026-08-23 ji egzistavo DVIEM kopijomis, o `dependencyClosure` sutapo pažodžiui. Dvi to
// paties algoritmo kopijos skirtinguose sluoksniuose yra vieta, kur pataisymas pasiekia vieną pusę
// ir tyliai aplenkia kitą.
//
// PASTABA (2026-08-23): ankstesnė šios antraštės redakcija kalbėjo apie „du grafo skaitytojus su
// sąmoningai skirtinga briaunų politika" — kanoninę fail-closed ir ATLAIDŽIĄ bangos. Atlaidžiojo
// variklio nebėra nuo suvienodinimo 3/3: briaunas abiem atvejais duoda kanoninis grafas, o
// skiriasi tik APIMTIS (visas grafas ciklams ir gyliams; `queued` pjūvis kandidatams).
//
// Šie moduliai neturi nuomonės apie `TaskGraph` formą ar bucket'us: įeina žemėlapis, išeina
// atsakymas. Todėl apimtį renkasi kvietėjas, o algoritmas lieka vienas.
//
// Grafai yra eilės dydžio (dešimtys mazgų), todėl naudojama akivaizdi pasiekiamumo formuluotė, o
// ne indeksinis SCC ėjimas: kaina nereikšminga, taisyklė perskaitoma.

/** Gretimumo žemėlapis: task ID → jo blokatorių ID. */
export type DependencyEdges = ReadonlyMap<string, readonly string[]>;

/** Mazgai, pasiekiami iš `start` einant priklausomybių briaunomis (task → jo blokatoriai). */
export function dependencyClosure(start: string, edges: DependencyEdges): Set<string> {
  const seen = new Set<string>();
  const stack = [...(edges.get(start) ?? [])];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    stack.push(...(edges.get(current) ?? []));
  }
  return seen;
}

/**
 * Ciklai: mazgas, pasiekiamas pats iš savęs, yra dalyvis; grupės — abipusiai pasiekiamų mazgų
 * rinkiniai (stipriai susietos komponentės). Dalyviai ir grupės rūšiuojamos, kad rezultatas
 * būtų deterministinis nepriklausomai nuo įterpimo tvarkos.
 */
export function detectCyclesOverEdges(edges: DependencyEdges): { members: Set<string>; groups: string[][] } {
  const closures = new Map<string, Set<string>>();
  for (const node of edges.keys()) closures.set(node, dependencyClosure(node, edges));

  const members = new Set<string>();
  for (const [node, closure] of closures) {
    if (closure.has(node)) members.add(node);
  }

  const groups: string[][] = [];
  const grouped = new Set<string>();
  for (const node of [...members].sort()) {
    if (grouped.has(node)) continue;
    const group = [...members]
      .filter((other) => other === node || (closures.get(node)?.has(other) === true && closures.get(other)?.has(node) === true))
      .sort();
    for (const member of group) grouped.add(member);
    groups.push(group);
  }

  return { members, groups };
}

/**
 * Ilgiausias priklausomybių kelias iki kiekvieno mazgo — deterministinė planavimo tvarka.
 *
 * Ciklo dalyviams gylis 0: jie niekada nevykdomi, tad jų gylis nieko nereiškia. `seen` saugo nuo
 * begalinės rekursijos ir tais atvejais, kai kvietėjas paduoda nepilną `cycleMembers` rinkinį.
 */
export function longestDependencyDepths(edges: DependencyEdges, cycleMembers: ReadonlySet<string>): Map<string, number> {
  const depths = new Map<string, number>();

  const depthOf = (taskId: string, seen: Set<string>): number => {
    const cached = depths.get(taskId);
    if (cached !== undefined) return cached;
    if (cycleMembers.has(taskId) || seen.has(taskId)) return 0;
    seen.add(taskId);
    const blockerDepths = (edges.get(taskId) ?? []).map((blocker) => depthOf(blocker, seen) + 1);
    const depth = blockerDepths.length > 0 ? Math.max(...blockerDepths) : 0;
    seen.delete(taskId);
    depths.set(taskId, depth);
    return depth;
  };

  for (const node of edges.keys()) depthOf(node, new Set());
  return depths;
}
