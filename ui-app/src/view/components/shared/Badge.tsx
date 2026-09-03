import type { StatusVariant } from "../../../model/dashboardViewModel";

const variantClass: Record<StatusVariant, string> = {
  good: "status-good",
  warning: "status-warning",
  error: "status-error",
  live: "status-live",
  neutral: "status-neutral",
};

type Props = { text: string; variant: StatusVariant };

export function Badge({ text, variant }: Props) {
  return <span className={`badge ${variantClass[variant]}`}>{text}</span>;
}
