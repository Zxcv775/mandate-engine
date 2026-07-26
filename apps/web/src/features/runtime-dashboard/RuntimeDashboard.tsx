import { ENGINE_INFO } from "@mandate/shared";
import { useEffect } from "react";
import { useStore } from "zustand";
import { runtimeStore } from "../../store/runtime-store";
import { saveStore } from "../../store/save-store";
import { ProviderStatusCard } from "./ProviderStatusCard";
import { RuntimeStatusCard } from "./RuntimeStatusCard";
import { ScenarioStatusCard } from "./ScenarioStatusCard";
import { StatusCard, StatusDetails } from "./StatusCard";
import { SaveBrowser } from "./SaveBrowser";
import "./runtime-dashboard.css";

function displayTime(value?: string): string {
  return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "尚未完成";
}

export function RuntimeDashboard() {
  const state = useStore(runtimeStore);

  useEffect(() => {
    void runtimeStore.getState().refresh();
    void saveStore.getState().refresh();
    return () => {
      runtimeStore.getState().cancel();
      saveStore.getState().cancel();
    };
  }, []);

  return (
    <main className="dashboard-shell">
      <header className="dashboard-header">
        <div>
          <p className="eyebrow">MANDATE ENGINE · PHASE 2</p>
          <h1>运行时与存档控制台</h1>
          <p>用于确认配置装配、历史模板、GameState、SQLite 存档与审计链状态。</p>
        </div>
        <button
          type="button"
          onClick={() => void Promise.all([state.refresh(), saveStore.getState().refresh()])}
        >
          重新加载
        </button>
      </header>

      <div className="dashboard-grid">
        <RuntimeStatusCard health={state.health} version={state.version} />
        <ProviderStatusCard panel={state.runtime} />
        <ScenarioStatusCard panel={state.scenario} />
        <StatusCard title="系统状态" status={state.runtime.status}>
          {state.runtime.status === "success" && state.runtime.data ? (
            <dl className="status-list">
              <div>
                <dt>前端版本</dt>
                <dd>{ENGINE_INFO.version}</dd>
              </div>
              <div>
                <dt>后端环境</dt>
                <dd>{state.runtime.data.environment}</dd>
              </div>
              <div>
                <dt>最近刷新</dt>
                <dd>{displayTime(state.lastRefreshedAt)}</dd>
              </div>
              <div>
                <dt>当前范围</dt>
                <dd>事务状态引擎与 SQLite 存档底座</dd>
              </div>
            </dl>
          ) : (
            <StatusDetails panel={state.runtime} />
          )}
        </StatusCard>
      </div>

      <SaveBrowser />

      <footer>本页只提供开发者可观测性；不展示 sealed 状态，也不提前实现正式游戏 UI。</footer>
    </main>
  );
}
