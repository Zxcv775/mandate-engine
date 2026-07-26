import { useMemo, useState } from "react";
import { useStore } from "zustand";
import { saveStore } from "../../store/save-store";
import { StatusCard, StatusDetails } from "./StatusCard";

function formatTime(value: string | null): string {
  return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "尚未游玩";
}

function shortValue(value: unknown): string {
  const text = JSON.stringify(value);
  if (text === undefined) return "—";
  return text.length > 72 ? `${text.slice(0, 69)}…` : text;
}

export function SaveBrowser() {
  const browser = useStore(saveStore);
  const [revisionFilter, setRevisionFilter] = useState("");
  const [commandFilter, setCommandFilter] = useState("");
  const [actorFilter, setActorFilter] = useState("");
  const [aggregateFilter, setAggregateFilter] = useState("");
  const [entityFilter, setEntityFilter] = useState("");

  const filteredChanges = useMemo(() => {
    const changes = browser.changes.data ?? [];
    return changes.filter((entry) => {
      return (
        (!revisionFilter || String(entry.revision) === revisionFilter) &&
        (!commandFilter || entry.commandType.includes(commandFilter)) &&
        (!actorFilter || entry.actorType.includes(actorFilter)) &&
        (!aggregateFilter || entry.aggregateType.includes(aggregateFilter)) &&
        (!entityFilter || (entry.entityId ?? "").includes(entityFilter))
      );
    });
  }, [
    browser.changes.data,
    revisionFilter,
    commandFilter,
    actorFilter,
    aggregateFilter,
    entityFilter,
  ]);

  return (
    <section className="save-browser" aria-labelledby="save-browser-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">PHASE 2 · SQLITE</p>
          <h2 id="save-browser-title">存档与状态审计</h2>
        </div>
        <button type="button" onClick={() => void browser.refresh()}>
          刷新存档
        </button>
      </div>

      <div className="save-browser-grid">
        <StatusCard title="存档列表" status={browser.saves.status}>
          {browser.saves.status === "success" ? (
            browser.saves.data && browser.saves.data.length > 0 ? (
              <>
                <label className="field-label" htmlFor="save-select">
                  当前存档
                </label>
                <select
                  id="save-select"
                  value={browser.selectedSaveId ?? ""}
                  onChange={(event) => void browser.selectSave(event.target.value)}
                >
                  {browser.saves.data.map((save) => (
                    <option key={save.saveId} value={save.saveId}>
                      {save.title} · r{save.headRevision}
                    </option>
                  ))}
                </select>
                <div className="table-scroll compact-table">
                  <table>
                    <thead>
                      <tr>
                        <th>标题</th>
                        <th>日期</th>
                        <th>Revision</th>
                        <th>快照</th>
                      </tr>
                    </thead>
                    <tbody>
                      {browser.saves.data.map((save) => (
                        <tr key={save.saveId}>
                          <td>
                            {save.title}
                            <small>
                              {save.scenarioId} · {save.sourceMetadataMode}
                            </small>
                          </td>
                          <td>
                            {save.currentDate}
                            <small>{formatTime(save.lastPlayedAt)}</small>
                          </td>
                          <td>{save.headRevision}</td>
                          <td>{save.snapshotCount}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : (
              <p className="muted">尚无存档。可通过 API 或 CLI 创建首个存档。</p>
            )
          ) : (
            <StatusDetails panel={browser.saves} offlineText="存档服务离线。" />
          )}
        </StatusCard>

        <StatusCard title="GameState 摘要" status={browser.state.status}>
          {browser.state.status === "success" && browser.state.data ? (
            <dl className="status-list">
              <div>
                <dt>游戏日期 / Tick</dt>
                <dd>
                  {browser.state.data.currentDate} / {browser.state.data.tick}
                </dd>
              </div>
              <div>
                <dt>Revision</dt>
                <dd>{browser.state.data.revision}</dd>
              </div>
              <div>
                <dt>国库 / 粮储</dt>
                <dd>
                  {browser.state.data.country.treasuryTaels.toLocaleString()} /{" "}
                  {browser.state.data.country.grainReserveShi.toLocaleString()}
                </dd>
              </div>
              <div>
                <dt>稳定 / 合法性</dt>
                <dd>
                  {browser.state.data.country.stability} / {browser.state.data.country.legitimacy}
                </dd>
              </div>
              <div>
                <dt>人物 / 政策 / 会议</dt>
                <dd>
                  {Object.keys(browser.state.data.characters).length} /{" "}
                  {Object.keys(browser.state.data.policies).length} /{" "}
                  {Object.keys(browser.state.data.meetings).length}
                </dd>
              </div>
              <div>
                <dt>RNG cursor</dt>
                <dd>{browser.state.data.rng.cursor}</dd>
              </div>
              <div>
                <dt>史料目录</dt>
                <dd>
                  {browser.state.data.meta.sourceCatalogPresent
                    ? "完整"
                    : "已剥离（sourceIds 保留）"}
                </dd>
              </div>
            </dl>
          ) : browser.state.status === "success" ? (
            <p className="muted">选择存档后显示状态摘要。</p>
          ) : (
            <StatusDetails panel={browser.state} offlineText="GameState 暂不可用。" />
          )}
        </StatusCard>
      </div>

      <StatusCard title="StateChangeLog" status={browser.changes.status}>
        {browser.changes.status === "success" ? (
          <>
            <div className="log-filters">
              <input
                aria-label="Revision 过滤"
                placeholder="revision"
                value={revisionFilter}
                onChange={(event) => setRevisionFilter(event.target.value)}
              />
              <input
                aria-label="Command 过滤"
                placeholder="commandType"
                value={commandFilter}
                onChange={(event) => setCommandFilter(event.target.value)}
              />
              <input
                aria-label="Actor 过滤"
                placeholder="actorType"
                value={actorFilter}
                onChange={(event) => setActorFilter(event.target.value)}
              />
              <input
                aria-label="Aggregate 过滤"
                placeholder="aggregateType"
                value={aggregateFilter}
                onChange={(event) => setAggregateFilter(event.target.value)}
              />
              <input
                aria-label="Entity 过滤"
                placeholder="entityId"
                value={entityFilter}
                onChange={(event) => setEntityFilter(event.target.value)}
              />
            </div>
            <div className="table-scroll log-table">
              <table>
                <thead>
                  <tr>
                    <th>Rev</th>
                    <th>事务 / 命令</th>
                    <th>Actor</th>
                    <th>Aggregate</th>
                    <th>Path</th>
                    <th>Before → After</th>
                    <th>可见性</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredChanges.map((entry) => (
                    <tr key={entry.logId}>
                      <td>
                        {entry.revision}.{entry.sequence}
                      </td>
                      <td>
                        {entry.txId}
                        <small>{entry.commandType}</small>
                      </td>
                      <td>
                        {entry.actorType}
                        <small>{entry.actorId}</small>
                      </td>
                      <td>
                        {entry.aggregateType}
                        <small>{entry.entityId ?? "—"}</small>
                      </td>
                      <td>
                        <code>{entry.path}</code>
                      </td>
                      <td>
                        <code>
                          {shortValue(entry.before)} → {shortValue(entry.after)}
                        </code>
                      </td>
                      <td>{entry.visibility}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {filteredChanges.length === 0 ? (
              <p className="muted">没有符合条件的公开/内部日志。</p>
            ) : null}
          </>
        ) : (
          <StatusDetails panel={browser.changes} offlineText="StateChangeLog 暂不可用。" />
        )}
      </StatusCard>
    </section>
  );
}
