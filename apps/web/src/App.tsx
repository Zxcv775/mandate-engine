import { useState } from "react";
import { CharacterLab } from "./features/character-lab/CharacterLab";
import { RuntimeDashboard } from "./features/runtime-dashboard/RuntimeDashboard";
import "./app.css";

type AppView = "dashboard" | "character-lab";

export function App() {
  const [view, setView] = useState<AppView>("dashboard");

  return (
    <>
      <nav className="app-nav">
        <button
          type="button"
          className={view === "dashboard" ? "active" : ""}
          onClick={() => setView("dashboard")}
        >
          运行时控制台
        </button>
        <button
          type="button"
          className={view === "character-lab" ? "active" : ""}
          onClick={() => setView("character-lab")}
        >
          Character Lab
        </button>
      </nav>
      {view === "dashboard" ? <RuntimeDashboard /> : <CharacterLab />}
    </>
  );
}
