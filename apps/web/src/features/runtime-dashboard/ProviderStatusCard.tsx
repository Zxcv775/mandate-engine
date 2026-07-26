import type { PublicRuntimeConfig } from "@mandate/domain";
import type { PanelState } from "../../store/runtime-store";
import { StatusCard, StatusDetails } from "./StatusCard";

export function ProviderStatusCard({ panel }: { panel: PanelState<PublicRuntimeConfig> }) {
  const provider = panel.data?.provider;
  return (
    <StatusCard title="Provider 状态" status={panel.status}>
      {panel.status === "success" && provider ? (
        <dl className="status-list">
          <div><dt>Provider</dt><dd>{provider.name}</dd></div>
          <div><dt>模型</dt><dd>{provider.model}</dd></div>
          <div><dt>API Key</dt><dd>{provider.hasApiKey ? "已配置" : "未配置"}</dd></div>
          <div><dt>Base URL</dt><dd>{provider.baseUrlConfigured ? "已配置" : "未配置"}</dd></div>
          <div><dt>Mock 模式</dt><dd>{provider.isMock ? "是" : "否"}</dd></div>
        </dl>
      ) : (
        <StatusDetails panel={panel} />
      )}
    </StatusCard>
  );
}
