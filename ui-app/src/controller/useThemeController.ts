import { useEffect, useState } from "react";

type Theme = "light" | "dark";

function readTheme(): Theme {
  // Išsaugotas pasirinkimas turi prioritetą; kitaip sekame OS temą (programuotojui
  // patogu — tamsi aplinka pagal nutylėjimą, jei sistema tamsi).
  const saved = localStorage.getItem("vq-ui-theme");
  if (saved === "dark" || saved === "light") return saved;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function useThemeController() {
  const [theme, setTheme] = useState<Theme>(readTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("vq-ui-theme", theme);
  }, [theme]);

  return {
    theme,
    toggleTheme: () => setTheme((current) => (current === "dark" ? "light" : "dark")),
  };
}
