import type {
  HealthData,
  PublicRuntimeConfig,
  ScenarioSummary,
  VersionData,
} from "@mandate/domain";
import { createStore, type StoreApi } from "zustand/vanilla";
import { ApiClientError } from "../api/client";
import { getHealth } from "../api/health";
import { getRuntimeConfig } from "../api/runtime";
import { getScenario } from "../api/scenarios";
import { getVersion } from "../api/version";

export type RuntimeLoadStatus = "loading" | "success" | "offline" | "api_error" | "data_error";

export interface PanelState<T> {
  status: RuntimeLoadStatus;
  data?: T;
  error?: string;
}

export interface HealthPanelState extends PanelState<HealthData> {
  responseTimeMs?: number;
}

export interface RuntimeApi {
  getHealth(signal: AbortSignal): Promise<HealthData>;
  getVersion(signal: AbortSignal): Promise<VersionData>;
  getRuntimeConfig(signal: AbortSignal): Promise<PublicRuntimeConfig>;
  getScenario(scenarioId: string, signal: AbortSignal): Promise<ScenarioSummary>;
}

export interface RuntimeState {
  health: HealthPanelState;
  version: PanelState<VersionData>;
  runtime: PanelState<PublicRuntimeConfig>;
  scenario: PanelState<ScenarioSummary>;
  lastRefreshedAt?: string;
  refresh(): Promise<void>;
  cancel(): void;
}

const loading = (): PanelState<never> => ({ status: "loading" });

function errorState(error: unknown): PanelState<never> | undefined {
  if (error instanceof ApiClientError) {
    if (error.kind === "cancelled") return undefined;
    if (error.kind === "offline" || error.kind === "timeout") {
      return { status: "offline", error: error.message };
    }
    return {
      status: error.kind === "api_error" ? "api_error" : "data_error",
      error: error.message,
    };
  }
  return { status: "data_error", error: "客户端处理响应时发生未知错误" };
}

export function createRuntimeStore(api: RuntimeApi): StoreApi<RuntimeState> {
  let activeController: AbortController | undefined;

  return createStore<RuntimeState>((set) => ({
    health: loading(),
    version: loading(),
    runtime: loading(),
    scenario: loading(),

    async refresh() {
      activeController?.abort();
      const controller = new AbortController();
      activeController = controller;
      const isActive = () => activeController === controller && !controller.signal.aborted;
      set({
        health: loading(),
        version: loading(),
        runtime: loading(),
        scenario: loading(),
      });

      const healthTask = async () => {
        const startedAt = performance.now();
        try {
          const data = await api.getHealth(controller.signal);
          if (isActive()) {
            set({
              health: {
                status: "success",
                data,
                responseTimeMs: Math.max(0, Math.round(performance.now() - startedAt)),
              },
            });
          }
        } catch (error) {
          const next = errorState(error);
          if (next && isActive()) set({ health: next });
        }
      };

      const versionTask = async () => {
        try {
          const data = await api.getVersion(controller.signal);
          if (isActive()) set({ version: { status: "success", data } });
        } catch (error) {
          const next = errorState(error);
          if (next && isActive()) set({ version: next });
        }
      };

      const runtimeTask = async () => {
        try {
          const data = await api.getRuntimeConfig(controller.signal);
          if (!isActive()) return;
          set({ runtime: { status: "success", data } });
          try {
            const scenario = await api.getScenario(
              data.scenario.defaultScenarioId,
              controller.signal,
            );
            if (isActive()) set({ scenario: { status: "success", data: scenario } });
          } catch (error) {
            const next = errorState(error);
            if (next && isActive()) set({ scenario: next });
          }
        } catch (error) {
          const next = errorState(error);
          if (next && isActive()) set({ runtime: next, scenario: next });
        }
      };

      await Promise.all([healthTask(), versionTask(), runtimeTask()]);
      if (isActive()) set({ lastRefreshedAt: new Date().toISOString() });
    },

    cancel() {
      activeController?.abort();
    },
  }));
}

export const runtimeApi: RuntimeApi = {
  getHealth: (signal) => getHealth(signal),
  getVersion: (signal) => getVersion(signal),
  getRuntimeConfig: (signal) => getRuntimeConfig(signal),
  getScenario: (scenarioId, signal) => getScenario(scenarioId, signal),
};

export const runtimeStore = createRuntimeStore(runtimeApi);
