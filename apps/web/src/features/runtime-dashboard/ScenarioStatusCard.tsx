import type { ScenarioSummary } from "@mandate/domain";
import type { PanelState } from "../../store/runtime-store";
import { StatusCard, StatusDetails } from "./StatusCard";

export function ScenarioStatusCard({ panel }: { panel: PanelState<ScenarioSummary> }) {
  const scenario = panel.data;
  return (
    <StatusCard title="剧本状态" status={panel.status}>
      {panel.status === "success" && scenario ? (
        <dl className="status-list">
          <div><dt>默认剧本</dt><dd>{scenario.id}</dd></div>
          <div><dt>名称</dt><dd>{scenario.name}</dd></div>
          <div><dt>朝代</dt><dd>{scenario.dynastyName}</dd></div>
          <div><dt>开始日期</dt><dd>{scenario.startGameDate}</dd></div>
          <div><dt>数据完整度</dt><dd>{scenario.historicalDataCompleteness}</dd></div>
          <div><dt>Schema 校验</dt><dd className="positive">{scenario.schemaValidated ? "通过" : "未通过"}</dd></div>
        </dl>
      ) : (
        <StatusDetails panel={panel} offlineText="需连接后端后加载默认剧本。" />
      )}
    </StatusCard>
  );
}
