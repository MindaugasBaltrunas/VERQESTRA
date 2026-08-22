import { useCallback, useEffect, useState } from "react";

export type Route = "overview" | "tasks" | "reviews" | "learning" | "analytics" | "optimization" | "reliability" | "benchmark" | "system";

function readRoute(): Route {
  const route = window.location.hash.replace(/^#\//, "");
  if (route === "tasks" || route === "reviews" || route === "learning" || route === "analytics" || route === "optimization" || route === "reliability" || route === "benchmark" || route === "system") {
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
