import { create } from "zustand";

export type ServerStatus = "unknown" | "online" | "offline";

interface AppState {
  serverStatus: ServerStatus;
  refreshServerStatus: () => Promise<void>;
}

/** Phase 0 最小全局状态：仅后端健康状态 */
export const useAppStore = create<AppState>((set) => ({
  serverStatus: "unknown",
  refreshServerStatus: async () => {
    try {
      const response = await fetch("/api/health");
      set({ serverStatus: response.ok ? "online" : "offline" });
    } catch {
      set({ serverStatus: "offline" });
    }
  },
}));
