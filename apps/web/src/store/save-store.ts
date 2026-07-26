import type { PlayerStateView, SaveMetadata, StateChangeLogEntry } from "@mandate/domain";
import { createStore, type StoreApi } from "zustand/vanilla";
import { ApiClientError } from "../api/client";
import { getSaveChanges, getSaveState, listSaves } from "../api/saves";
import type { RuntimeLoadStatus } from "./runtime-store";

export interface SavePanelState<T> {
  status: RuntimeLoadStatus;
  data?: T;
  error?: string;
}

export interface SaveBrowserApi {
  listSaves(signal: AbortSignal): Promise<readonly SaveMetadata[]>;
  getState(saveId: string, signal: AbortSignal): Promise<PlayerStateView>;
  getChanges(saveId: string, signal: AbortSignal): Promise<readonly StateChangeLogEntry[]>;
}

export interface SaveBrowserState {
  saves: SavePanelState<readonly SaveMetadata[]>;
  selectedSaveId?: string;
  state: SavePanelState<PlayerStateView>;
  changes: SavePanelState<readonly StateChangeLogEntry[]>;
  refresh(): Promise<void>;
  selectSave(saveId: string): Promise<void>;
  cancel(): void;
}

const loading = <T>(): SavePanelState<T> => ({ status: "loading" });

function errorPanel(error: unknown): SavePanelState<never> | undefined {
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
  return {
    status: "data_error",
    error: error instanceof Error ? error.message : "存档数据处理失败",
  };
}

export function createSaveStore(api: SaveBrowserApi): StoreApi<SaveBrowserState> {
  let activeController: AbortController | undefined;

  const loadDetails = async (
    saveId: string,
    controller: AbortController,
    set: StoreApi<SaveBrowserState>["setState"],
  ) => {
    const isActive = () => activeController === controller && !controller.signal.aborted;
    set({ selectedSaveId: saveId, state: loading(), changes: loading() });
    const stateTask = api
      .getState(saveId, controller.signal)
      .then((data) => {
        if (isActive()) set({ state: { status: "success", data } });
      })
      .catch((error: unknown) => {
        const panel = errorPanel(error);
        if (panel && isActive()) set({ state: panel });
      });
    const changesTask = api
      .getChanges(saveId, controller.signal)
      .then((data) => {
        if (isActive()) set({ changes: { status: "success", data } });
      })
      .catch((error: unknown) => {
        const panel = errorPanel(error);
        if (panel && isActive()) set({ changes: panel });
      });
    await Promise.all([stateTask, changesTask]);
  };

  return createStore<SaveBrowserState>((set, get) => ({
    saves: loading(),
    state: loading(),
    changes: loading(),

    async refresh() {
      activeController?.abort();
      const controller = new AbortController();
      activeController = controller;
      set({ saves: loading(), state: loading(), changes: loading() });
      try {
        const saves = await api.listSaves(controller.signal);
        if (activeController !== controller || controller.signal.aborted) return;
        set({ saves: { status: "success", data: saves } });
        const selected =
          saves.find((save) => save.saveId === get().selectedSaveId)?.saveId ?? saves[0]?.saveId;
        if (!selected) {
          set({
            selectedSaveId: undefined,
            state: { status: "success" },
            changes: { status: "success", data: [] },
          });
          return;
        }
        await loadDetails(selected, controller, set);
      } catch (error) {
        const panel = errorPanel(error);
        if (panel && activeController === controller) {
          set({ saves: panel, state: panel, changes: panel });
        }
      }
    },

    async selectSave(saveId) {
      activeController?.abort();
      const controller = new AbortController();
      activeController = controller;
      await loadDetails(saveId, controller, set);
    },

    cancel() {
      activeController?.abort();
    },
  }));
}

export const saveBrowserApi: SaveBrowserApi = {
  listSaves: (signal) => listSaves(signal),
  getState: (saveId, signal) => getSaveState(saveId, signal),
  getChanges: (saveId, signal) => getSaveChanges(saveId, signal),
};

export const saveStore = createSaveStore(saveBrowserApi);
