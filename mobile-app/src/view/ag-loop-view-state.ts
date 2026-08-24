import type {
  AgLoopLinkState,
  AgLoopRuntimeComponent,
  AgLoopTaskBucket,
} from "../model/ag-loop-read.js";

/**
 * View state of the read-only AG Loop spaces (Dashboard, Tasks).
 *
 * NUKRYPIMAS (vieta, ne turinys): etalone šie tipai gyveno kartu su projekcijos funkcijomis
 * `adapters/presentation/ag-loop-presenter.ts`, o `view/contracts.ts` importavo juos iš ten.
 * VERQESTRA taisyklė yra kitokia — „importų grafas aciklinis, net type-only ryšiams (tipai
 * keliauja į atskirą `-model` failą)" — tad tipai atskirti, ir rodyklė dabar rodo
 * `controller/presentation → view`, o ne atvirkščiai. Praktinis skirtumas: ekranas nebegali
 * pasiekti projekcijos funkcijos vien dėl to, kad jam prireikė jos tipo.
 */

/** Re-exported so a screen never has to name the Model to describe itself. */
export type { AgLoopLinkState, AgLoopTaskBucket } from "../model/ag-loop-read.js";

export type AgLoopConnectionViewState = Readonly<{
  link: AgLoopLinkState;
  label: string;
  refreshing: boolean;
  /** The shown snapshot is cached and no longer confirmed by the host. */
  stale: boolean;
  errorMessage: string | null;
  canRetry: boolean;
}>;

export type DashboardQueueRow = Readonly<{ bucket: string; label: string; count: number }>;

export type DashboardViewState = Readonly<{
  title: string;
  /** Structural, not a flag: these screens never expose an AG Loop mutation. */
  readOnly: true;
  connection: AgLoopConnectionViewState;
  showLoadingPlaceholder: boolean;
  /** No snapshot exists and none is being read: offline or never configured. */
  showUnavailablePlaceholder: boolean;
  unavailableLabel: string;
  isEmpty: boolean;
  currentTaskLabel: string;
  currentTaskState: "none" | "active" | "stale";
  queueRows: readonly DashboardQueueRow[];
  runtimeRows: readonly AgLoopRuntimeComponent[];
  reviewCount: number;
  updatedAtLabel: string | null;
}>;

export type TasksBucketTab = Readonly<{
  bucket: AgLoopTaskBucket;
  label: string;
  selected: boolean;
  /** Bucket size from the dashboard projection; `null` before the first read. */
  count: number | null;
}>;

export type TasksViewState = Readonly<{
  title: string;
  readOnly: true;
  connection: AgLoopConnectionViewState;
  tabs: readonly TasksBucketTab[];
  selectedBucket: AgLoopTaskBucket;
  rows: readonly string[];
  totalCount: number;
  /** Entries the gateway capped away; the bucket total stays authoritative. */
  hiddenCount: number;
  showLoadingPlaceholder: boolean;
  /** No bucket snapshot exists and none is being read: offline or never configured. */
  showUnavailablePlaceholder: boolean;
  unavailableLabel: string;
  isEmpty: boolean;
  emptyLabel: string;
}>;
