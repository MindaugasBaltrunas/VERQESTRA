import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { TokenAnalyticsBucket } from "../../../../model/types";
import { DistributionDonutChart } from "../../../../view/components/tokens/DistributionDonutChart";

const rows: TokenAnalyticsBucket[] = [
  { key: "dispatch", totalTokens: 300 },
  { key: "preflight", totalTokens: 100 },
];

describe("DistributionDonutChart", () => {
  it("shows the empty state when there is no data", () => {
    render(<DistributionDonutChart title="Tokenai pagal fazę" description="desc" rows={[]} />);
    expect(screen.getByText("No data")).toBeInTheDocument();
  });

  it("renders a legend entry per bucket with its share", () => {
    render(<DistributionDonutChart title="Tokenai pagal fazę" description="desc" rows={rows} />);
    expect(screen.getByText("dispatch")).toBeInTheDocument();
    expect(screen.getByText("preflight")).toBeInTheDocument();
    expect(screen.getAllByText(/75\s*%/)).toHaveLength(2);
    expect(screen.getAllByText(/25\s*%/)).toHaveLength(2);
  });

  it("ignores zero-token buckets", () => {
    render(
      <DistributionDonutChart
        title="Tokenai pagal modelį"
        description="desc"
        rows={[...rows, { key: "diagnose", totalTokens: 0 }]}
      />,
    );
    expect(screen.queryByText("diagnose")).not.toBeInTheDocument();
  });
});
