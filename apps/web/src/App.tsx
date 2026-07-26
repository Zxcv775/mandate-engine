import { useEffect } from "react";
import { useAppStore } from "./store";

const STATUS_TEXT = {
  unknown: "探测中……",
  online: "在线",
  offline: "离线（请先运行 npm run dev:server）",
} as const;

/** Phase 0 最小页面：确认前后端联通；完整界面在 Phase 8 实现 */
export function App() {
  const { serverStatus, refreshServerStatus } = useAppStore();

  useEffect(() => {
    void refreshServerStatus();
  }, [refreshServerStatus]);

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem", lineHeight: 1.8 }}>
      <h1>天命：帝国推演</h1>
      <p>Mandate Engine · Phase 0：项目立项与架构基线</p>
      <p>
        服务端状态：<strong>{STATUS_TEXT[serverStatus]}</strong>
      </p>
      <p>本阶段不包含游戏玩法，玩法将按 docs/05-roadmap.md 分阶段交付。</p>
    </main>
  );
}
