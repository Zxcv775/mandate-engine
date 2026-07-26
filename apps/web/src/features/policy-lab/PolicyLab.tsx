import { useEffect } from "react";
import { useStore } from "zustand";
import { policyLabStore } from "../../store/policy-lab-store";
import "./policy-lab.css";

/** Policy Lab（§12.3）：政策生命周期的开发者调试台。奏报为玩家口径；真实值在 Debug 折叠区。 */

const STATUS_LABELS: Record<string, string> = {
  draft: "草案",
  proposed: "待批",
  approved: "已批",
  issued: "已颁行",
  implementing: "推行中",
  blocked: "阻滞",
  "partially-implemented": "部分推行",
  suspended: "暂停",
  completed: "已完成",
  failed: "失败",
  cancelled: "已废止",
};

export function PolicyLab() {
  const state = useStore(policyLabStore);

  useEffect(() => {
    void policyLabStore.getState().refreshSaves();
  }, []);

  const selected = state.selected;
  const decidable = selected?.status === "proposed";
  const issuable = selected?.status === "approved";
  const running = ["issued", "implementing", "blocked", "partially-implemented"].includes(
    selected?.status ?? "",
  );
  const suspendable = running;
  const resumable = selected?.status === "suspended";
  const cancellable =
    selected !== undefined && !["completed", "failed", "cancelled"].includes(selected.status);

  return (
    <main className="plab-shell">
      <header className="plab-header">
        <div>
          <p className="eyebrow">MANDATE ENGINE · PHASE 5</p>
          <h1>Policy Lab · 政策调试台</h1>
          <p>政策生命周期与执行结算的开发者测试界面；玩家所见为奏报口径，真实值仅 Debug。</p>
        </div>
        <button type="button" onClick={() => void state.refreshSaves()}>
          刷新存档
        </button>
      </header>

      <section className="plab-toolbar">
        <label>
          存档
          <select
            value={state.selectedSaveId ?? ""}
            onChange={(e) => e.target.value && void state.selectSave(e.target.value)}
          >
            <option value="" disabled>
              选择存档
            </option>
            {state.saves.map((save) => (
              <option key={save.saveId} value={save.saveId}>
                {save.title}（rev {save.headRevision}）
              </option>
            ))}
          </select>
        </label>
        <span>revision：{state.headRevision ?? "-"}</span>
        <span>tick：{state.currentTick ?? "-"}</span>
        <span>国库：{state.treasuryTaels?.toLocaleString() ?? "-"} 两</span>
        <span>仓储：{state.grainReserveShi?.toLocaleString() ?? "-"} 石</span>
        <label>
          推进天数
          <input
            className="plab-days"
            value={state.advanceDays}
            onChange={(e) => state.setField("advanceDays", e.target.value)}
          />
        </label>
        <button
          type="button"
          disabled={state.busy || !state.selectedSaveId}
          onClick={() => void state.advance()}
        >
          推进时间
        </button>
      </section>

      <section className="plab-compose">
        <h2>直诏立策</h2>
        <label>
          政策模板
          <select
            value={state.templateId}
            onChange={(e) => state.setField("templateId", e.target.value)}
          >
            {state.templates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name}（{template.category}）
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={state.busy || !state.selectedSaveId || !state.templateId}
          onClick={() => void state.propose()}
        >
          直诏 propose
        </button>
      </section>

      <section className="plab-columns">
        <div className="plab-list">
          <h2>政策（{state.policies.length}）</h2>
          <ul>
            {state.policies.map((policy) => (
              <li key={policy.policyId}>
                <button
                  type="button"
                  className={selected?.policyId === policy.policyId ? "active" : ""}
                  onClick={() => void state.selectPolicy(policy.policyId)}
                >
                  <span className={`plab-badge plab-badge-${policy.status}`}>
                    {STATUS_LABELS[policy.status] ?? policy.status}
                  </span>
                  {policy.templateName ?? policy.templateId}
                  <em>{policy.overallProgress}%</em>
                </button>
              </li>
            ))}
          </ul>
        </div>

        {selected ? (
          <div className="plab-detail">
            <h2>
              {selected.templateName ?? selected.templateId}
              <span className={`plab-badge plab-badge-${selected.status}`}>
                {STATUS_LABELS[selected.status] ?? selected.status}
              </span>
              <span className="plab-origin">
                {selected.origin.kind === "direct-decree" ? "直诏" : "会议来源"}
              </span>
            </h2>
            <p>
              阶段 {selected.currentStageIndex + 1}·进度 {selected.stageProgress}%（总
              {selected.overallProgress}%）；余算 {selected.remainingBudget.treasuryTaels} 两 /
              {selected.remainingBudget.grainReserveShi} 石；已投入
              {selected.investedResources.treasuryTaels} 两
            </p>
            {selected.blockedReason ? (
              <p className="plab-blocked">阻滞：{selected.blockedReason}</p>
            ) : null}
            {selected.suspendedReason ? (
              <p className="plab-blocked">暂停：{selected.suspendedReason}</p>
            ) : null}

            <div className="plab-controls">
              <button
                type="button"
                disabled={state.busy || !decidable}
                onClick={() => void state.decide("approve")}
              >
                御批准行
              </button>
              <button
                type="button"
                disabled={state.busy || !decidable}
                onClick={() => void state.decide("reject")}
              >
                驳回
              </button>
              <label>
                负责人
                <select
                  value={state.assigneeId}
                  onChange={(e) => state.setField("assigneeId", e.target.value)}
                >
                  {state.characters.map((character) => (
                    <option key={character.characterId} value={character.characterId}>
                      {character.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                追加银两
                <input
                  className="plab-budget"
                  value={state.budgetTaels}
                  onChange={(e) => state.setField("budgetTaels", e.target.value)}
                  placeholder="0"
                />
              </label>
              <button
                type="button"
                disabled={state.busy || !issuable}
                onClick={() => void state.issue()}
              >
                颁行 issue
              </button>
              <button
                type="button"
                disabled={state.busy || !running}
                onClick={() => void state.adjust()}
              >
                调整 adjust
              </button>
              <button
                type="button"
                disabled={state.busy || !suspendable}
                onClick={() => void state.lifecycle("suspend")}
              >
                暂停
              </button>
              <button
                type="button"
                disabled={state.busy || !resumable}
                onClick={() => void state.lifecycle("resume")}
              >
                复行
              </button>
              <button
                type="button"
                disabled={state.busy || !cancellable}
                onClick={() => void state.lifecycle("cancel")}
              >
                废止
              </button>
              <button type="button" disabled={state.busy} onClick={() => void state.loadDebug()}>
                真实值(Debug)
              </button>
            </div>

            <h3>奏报流（{state.reports.length}）</h3>
            <ul className="plab-reports">
              {state.reports.map((report) => (
                <li key={report.reportId}>
                  <span>tick {report.tick}</span>
                  {report.text}
                </li>
              ))}
            </ul>

            {state.truth !== undefined ? (
              <details open className="plab-debug">
                <summary>真实执行态 vs 奏报（Debug）</summary>
                <pre>{JSON.stringify(state.truth, null, 2)}</pre>
              </details>
            ) : null}
            {state.ruleTrace !== undefined ? (
              <details className="plab-debug">
                <summary>逐 tick 规则命中与系数分解（Debug）</summary>
                <pre>{JSON.stringify(state.ruleTrace, null, 2)}</pre>
              </details>
            ) : null}
          </div>
        ) : (
          <div className="plab-detail plab-empty">选择或直诏一个政策</div>
        )}
      </section>

      {state.error ? <p className="plab-error">{state.error}</p> : null}
      <footer className="plab-footer">
        政策一切变更经白名单 GameCommand → StateEngine；奏报是玩家所见，真实进度在 hidden，仅 Debug
        可读。
      </footer>
    </main>
  );
}
