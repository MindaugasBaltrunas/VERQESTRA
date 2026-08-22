import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppRoot } from "./view/AppRoot";
// Globalūs dashboard stiliai — be šio importo Vite jų neįtraukia į bundle.
import "./view/styles/dashboard.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppRoot />
  </StrictMode>,
);
