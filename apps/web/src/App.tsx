import { useState } from "react";
import { CharacterLab } from "./features/character-lab/CharacterLab";
import { MeetingLab } from "./features/meeting-lab/MeetingLab";
import { PolicyLab } from "./features/policy-lab/PolicyLab";
import { RuntimeDashboard } from "./features/runtime-dashboard/RuntimeDashboard";
import "./app.css";

type AppView = "dashboard" | "character-lab" | "meeting-lab" | "policy-lab";

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
        <button
          type="button"
          className={view === "meeting-lab" ? "active" : ""}
          onClick={() => setView("meeting-lab")}
        >
          Meeting Lab
        </button>
        <button
          type="button"
          className={view === "policy-lab" ? "active" : ""}
          onClick={() => setView("policy-lab")}
        >
          Policy Lab
        </button>
      </nav>
      {view === "dashboard" ? (
        <RuntimeDashboard />
      ) : view === "character-lab" ? (
        <CharacterLab />
      ) : view === "meeting-lab" ? (
        <MeetingLab />
      ) : (
        <PolicyLab />
      )}
    </>
  );
}
