import type { PropsWithChildren } from "react";
import type {
  PanelState,
  RuntimeLoadStatus,
} from "../../store/runtime-store";

const statusLabels: Record<RuntimeLoadStatus, string> = {
  loading: "加载中",
  success: "正常",
  offline: "离线",
  api_error: "API 错误",
  data_error: "数据错误",
};

interface StatusCardProps extends PropsWithChildren {
  title: string;
  status: RuntimeLoadStatus;
}

export function StatusCard({ title, status, children }: StatusCardProps) {
  return (
    <section className="status-card">
      <header>
        <h2>{title}</h2>
        <span className={`status-badge status-${status}`}>{statusLabels[status]}</span>
      </header>
      {children}
    </section>
  );
}

export function StatusDetails({
  panel,
  offlineText = "运行时信息暂不可用。",
}: {
  panel: PanelState<unknown>;
  offlineText?: string;
}) {
  if (panel.status === "loading") return <p className="muted">正在加载……</p>;
  if (panel.status === "offline") return <p className="error-text">{offlineText}</p>;
  return <p className="error-text">{panel.error ?? "响应数据不可用。"}</p>;
}
