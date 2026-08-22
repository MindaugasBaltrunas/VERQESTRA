import { memo } from "react";
import { fill } from "../../model/fillTemplate";
import type { PipelineBoardView, PipelineColumn, PipelineRow } from "../../model/queuePipelineViewModel";
import { formatAge } from "../../model/slotProgressFormat";
import { CountUpNumber } from "./CountUpNumber";
import { useI18n } from "../../i18n/I18nContext";

/** Priežasties rūšis → jos antraštė. Pati priežastis NEVERČIAMA: tai pool'o kodas iš log'o. */
const REASON_LABEL: Record<NonNullable<PipelineRow["reason"]>["kind"], string> = {
  blocked_by: "Blocked by",
  waiting_for: "Waiting for",
  rejection: "Rejected by the wave",
  reason: "Reason",
};

const WORKTREE_LABEL: Record<"yes" | "no" | "unknown", string> = { yes: "Yes", no: "No", unknown: "unknown" };

function PipelineRowView({ row }: { row: PipelineRow }) {
  const { t } = useI18n();

  return (
    <div className={`pipeline-row pipeline-row--${row.tone}`}>
      <strong>{row.label}</strong>
      <span>{t(row.stateLabelKey)}</span>
      {row.reason && (
        <p className="pipeline-row__reason">
          {t(REASON_LABEL[row.reason.kind])}: {row.reason.text}
        </p>
      )}
      <div className="pipeline-row__meta">
        {row.attempts !== null && <span>{t("Attempts")}: {row.attempts}</span>}
        {row.streamIndex !== null && <span>{t("Stream")} {row.streamIndex}</span>}
        {row.worktree && <span>{t("Worktree")}: {t(WORKTREE_LABEL[row.worktree])}</span>}
        {row.ageMs !== null && <span>{formatAge(row.ageMs)}</span>}
      </div>
    </div>
  );
}

function PipelineColumnView({ column }: { column: PipelineColumn }) {
  const { t } = useI18n();
  const title = t(column.titleKey);

  return (
    <div className={`pipeline-column pipeline-column--${column.id}`} aria-label={title}>
      <div className="pipeline-column__head">
        {title}
        <span><CountUpNumber value={column.total} /></span>
      </div>
      {/* `truncated` sakomas garsiai: tyliai nukirpta uodega atrodytų kaip visas eilės turinys. */}
      {column.truncated && (
        <p className="pipeline-row__meta">
          {fill(t("Showing {shown} of {total}"), { shown: column.rows.length, total: column.total })}
        </p>
      )}
      {column.rows.length === 0 ? (
        <p className="pipeline-empty">{t("Nothing here")}</p>
      ) : (
        column.rows.map((row) => <PipelineRowView key={row.key} row={row} />)
      )}
    </div>
  );
}

type Props = { board: PipelineBoardView };

/**
 * Eilės srautas: kiekvienos užduoties scheduler'io būsena viename ekrane (task 1233).
 *
 * Read-only rodinys — nė vienas mygtukas čia užduoties nejudina; eilės keliai lieka `#/tasks` ir
 * orkestratoriaus pusėje.
 */
export const QueuePipelineBoard = memo(function QueuePipelineBoard({ board }: Props) {
  const { t } = useI18n();

  return (
    <section className="panel" aria-labelledby="queue-pipeline-title">
      <div className="panel-header">
        <div>
          <h2 id="queue-pipeline-title">{t("Queue pipeline")}</h2>
          <p className="panel-subtitle">
            {t("Scheduler state per task: what is ready, running, blocked, failed, and done")}
          </p>
        </div>
      </div>
      {/* Trūkstamas šaltinis įvardijamas PRIEŠ lentą: be bangų duomenų „Blokuojama" stulpelis gali
          būti nepilnas, ir tylėti apie tai reikštų rodyti tuščią stulpelį kaip faktą. */}
      {!board.sources.wavesKnown && (
        <p className="runtime-explanation">⚠ {t("Wave data is unavailable; blocked reasons may be incomplete.")}</p>
      )}
      <div className="pipeline-board">
        {board.columns.map((column) => <PipelineColumnView key={column.id} column={column} />)}
      </div>
    </section>
  );
});
