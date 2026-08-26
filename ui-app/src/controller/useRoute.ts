import { useCallback, useEffect, useState } from "react";

export type Route = "overview" | "tasks" | "reviews" | "learning" | "analytics" | "optimization" | "reliability" | "benchmark" | "compression" | "system";

/**
 * Maršruto pavadinimas žmogui (vertimų raktų kalba — anglų; `t()` verčia).
 *
 * VIENAS šaltinis dviem vartotojams: navigacijos skirtukams ir dokumento antraštei. Antra kopija
 * reikštų, kad naršyklės kortelė ir skirtukas gali pasakyti skirtingus dalykus apie tą patį ekraną.
 */
export const ROUTE_LABELS: Record<Route, string> = {
  overview: "Overview",
  tasks: "Tasks",
  reviews: "Reviews",
  learning: "Learning",
  analytics: "Analytics",
  optimization: "Optimization",
  reliability: "Reliability",
  benchmark: "Benchmark",
  compression: "Compression",
  system: "System",
};

function readRoute(): Route {
  const route = window.location.hash.replace(/^#\//, "");
  if (route === "tasks" || route === "reviews" || route === "learning" || route === "analytics" || route === "optimization" || route === "reliability" || route === "benchmark" || route === "compression" || route === "system") {
    return route;
  }
  return "overview";
}

export function useRoute() {
  const [route, setRoute] = useState<Route>(readRoute);

  useEffect(() => {
    const onHashChange = () => setRoute(readRoute());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const navigate = useCallback((next: Route) => {
    window.location.hash = next === "overview" ? "" : `/${next}`;
  }, []);

  return { route, navigate };
}
