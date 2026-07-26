import type { HealthData, VersionData } from "@mandate/domain";
import type { HealthPanelState, PanelState } from "../../store/runtime-store";
import { StatusCard, StatusDetails } from "./StatusCard";

interface RuntimeStatusCardProps {
  health: HealthPanelState;
  version: PanelState<VersionData>;
}

export function RuntimeStatusCard({ health, version }: RuntimeStatusCardProps) {
  const healthData: HealthData | undefined = health.data;

  return (
    <StatusCard title="服务端状态" status={health.status}>
      {health.status === "success" && healthData ? (
        <dl className="status-list">
          <div>
            <dt>连接</dt>
            <dd className="positive">在线</dd>
          </div>
          <div>
            <dt>服务</dt>
            <dd>{healthData.service}</dd>
          </div>
          <div>
            <dt>响应时间</dt>
            <dd>{health.responseTimeMs ?? 0} ms</dd>
          </div>
          {version.status === "success" && version.data ? (
            <>
              <div>
                <dt>版本</dt>
                <dd>{version.data.version}</dd>
              </div>
              <div>
                <dt>Phase</dt>
                <dd>{version.data.phase}</dd>
              </div>
            </>
          ) : null}
        </dl>
      ) : (
        <StatusDetails panel={health} offlineText="后端服务当前不可达。" />
      )}
      {health.status === "success" && version.status !== "success" ? (
        <p className="sub-error">版本接口：{version.error ?? "加载中"}</p>
      ) : null}
    </StatusCard>
  );
}
