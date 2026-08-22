// Architektūros grafo TURINIO atspaudai. Analogas `domain/tasks/graph/hash.ts` — tas pats
// kanoninio JSON + sha256 šablonas, tik kitam grafui.
//
// ## Kodėl to reikia (2026-08-21 P1)
//
// `initProgress` refresh'o metu išsaugodavo `done` VIEN pagal mazgo ID, o `graph_hash` buvo
// `graph.imported_at` — laiko žyma, ne turinys. Dvi pasekmės:
//
//   • Mazgo etiketė, semantika ar briaunos galėjo pasikeisti IŠ ESMĖS, o jis likdavo `done` su
//     senais `implemented_files` ir toliau atrakindavo downstream. „Padaryta" yra teiginys apie
//     KONKRETŲ darbo vienetą; pasikeitus apibrėžimui, teiginys nebegalioja, o ID yra tik vardas.
//   • Tas pats grafas, importuotas antrą kartą, gaudavo KITĄ `graph_hash` (nauja laiko žyma),
//     o pakeistas grafas su atkurta žyma — TĄ PATĮ. Tad hash'as nerodė nei tapatybės, nei kaitos.
//
// Todėl du atspaudai, skirtingos apimties: viso grafo (`graph_hash`) ir mazgo (ar KONKRETUS
// darbo vienetas tebėra tas pats).

import { canonicalJsonStringify } from "../../shared/json.js";
import { sha256Hex } from "../../shared/hash.js";
import type { ArchitectureEdge, ArchitectureGraph, ArchitectureNode } from "./graph.js";

/**
 * Taisyklių versija. Pakeitus, KĄ įtraukiame į atspaudą, seni ledger'iai privalo tapti
 * nebeatitinkančiais — kitaip jie tyliai atrodytų galiojantys pagal naujas taisykles.
 */
export const ARCHITECTURE_GRAPH_RULES_VERSION = 1;

const compareNodes = (a: ArchitectureNode, b: ArchitectureNode): number => a.id.localeCompare(b.id);

const compareEdges = (a: ArchitectureEdge, b: ArchitectureEdge): number =>
  a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.type.localeCompare(b.type);

/**
 * Viso grafo turinio atspaudas.
 *
 * NEĮTRAUKIAMA sąmoningai: `imported_at` ir `source_path` — tai PROVENIENCIJA, ne turinys; tas
 * pats grafas, importuotas iš kitos vietos ar kitu metu, yra tas pats grafas. Taip pat
 * neįtraukiamas mazgo `status`: jis yra PROGRESO savybė, o sumaišius ją su grafo tapatybe,
 * kiekvienas darbo žingsnis atrodytų kaip grafo pakeitimas.
 */
export function computeArchitectureGraphHash(graph: ArchitectureGraph): string {
  const payload = {
    rules: ARCHITECTURE_GRAPH_RULES_VERSION,
    nodes: [...graph.nodes].sort(compareNodes).map(nodeIdentity),
    edges: [...graph.edges].sort(compareEdges).map(edgeIdentity),
  };
  return `ag${ARCHITECTURE_GRAPH_RULES_VERSION}:${sha256Hex(canonicalJsonStringify(payload)).slice(0, 16)}`;
}

/**
 * VIENO mazgo darbo vieneto atspaudas: paties mazgo apibrėžimas PLIUS jo briaunos į abi puses.
 *
 * Briaunos įtraukiamos, nes mazgas, kurio priklausomybės pasikeitė, yra kitas darbo vienetas —
 * net jei jo paties etiketė nepasikeitė. Būtent tai leidžia atsakyti į vienintelį klausimą, kurį
 * `initProgress` privalo užduoti: ar `done` vis dar reiškia tą patį.
 */
export function computeArchitectureNodeHash(node: ArchitectureNode, edges: readonly ArchitectureEdge[]): string {
  const incident = edges
    .filter((edge) => edge.from === node.id || edge.to === node.id)
    .sort(compareEdges)
    .map(edgeIdentity);
  const payload = { rules: ARCHITECTURE_GRAPH_RULES_VERSION, node: nodeIdentity(node), edges: incident };
  return `an${ARCHITECTURE_GRAPH_RULES_VERSION}:${sha256Hex(canonicalJsonStringify(payload)).slice(0, 16)}`;
}

function nodeIdentity(node: ArchitectureNode): Record<string, unknown> {
  return {
    id: node.id,
    label: node.label,
    kind: node.kind,
    external: node.external ?? false,
    description: node.description ?? null,
  };
}

function edgeIdentity(edge: ArchitectureEdge): Record<string, unknown> {
  return { from: edge.from, to: edge.to, type: edge.type, label: edge.label ?? null };
}
