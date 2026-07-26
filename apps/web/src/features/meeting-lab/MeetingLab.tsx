import { useEffect } from "react";
import { useStore } from "zustand";
import { meetingLabStore } from "../../store/meeting-lab-store";
import "./meeting-lab.css";

const TYPE_LABELS: Record<string, string> = {
  "court-assembly": "大朝会",
  "imperial-council": "御前会议",
  "secret-council": "秘密议事",
};

const TURN_TYPE_LABELS: Record<string, string> = {
  opening: "开场",
  "player-statement": "圣谕",
  "player-question": "垂询",
  "character-speech": "陈奏",
  "character-answer": "答问",
  "character-rebuttal": "驳议",
  "character-warning": "警示",
  "chair-intervention": "主持",
  "player-interruption": "打断",
  "player-ruling": "圣裁",
  "agenda-transition": "议程",
  adjournment: "散会",
};

export function MeetingLab() {
  const state = useStore(meetingLabStore);

  useEffect(() => {
    void meetingLabStore.getState().refreshSaves();
  }, []);

  const canRun =
    state.session &&
    ["in-progress", "waiting-for-player", "waiting-for-agent", "resolving"].includes(
      state.session.status,
    );

  return (
    <main className="mlab-shell">
      <header className="mlab-header">
        <div>
          <p className="eyebrow">MANDATE ENGINE · PHASE 4</p>
          <h1>Meeting Lab · 会议调试台</h1>
          <p>多人物议政编排的开发者测试界面；sealed 内容不在普通视图显示。</p>
        </div>
        <button type="button" onClick={() => void state.refreshSaves()}>
          刷新存档
        </button>
      </header>

      <section className="mlab-row">
        <label>
          存档
          <select
            value={state.selectedSaveId ?? ""}
            onChange={(e) => void state.selectSave(e.target.value)}
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
        <label>
          已有会议
          <select
            value={state.session?.meetingId ?? ""}
            onChange={(e) => void state.refreshMeeting(e.target.value)}
            disabled={state.meetings.length === 0}
          >
            <option value="" disabled>
              选择会议
            </option>
            {state.meetings.map((meeting) => (
              <option key={meeting.meetingId} value={meeting.meetingId}>
                {meeting.title}（{meeting.status}）
              </option>
            ))}
          </select>
        </label>
        <div className="mlab-meta">
          <span>revision：{state.headRevision ?? "-"}</span>
          <span>meetingVersion：{state.session?.meetingVersion ?? "-"}</span>
          <span>turn：{state.session?.turnNumber ?? "-"}</span>
          <span>状态:{state.session?.status ?? "-"}</span>
        </div>
      </section>

      <section className="mlab-create">
        <h2>创建会议</h2>
        <div className="mlab-row">
          <label>
            类型
            <select
              value={state.newType}
              onChange={(e) => state.setField("newType", e.target.value)}
            >
              {Object.entries(TYPE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            标题
            <input
              value={state.newTitle}
              onChange={(e) => state.setField("newTitle", e.target.value)}
            />
          </label>
          <label>
            首个议程
            <input
              value={state.newAgendaTitle}
              onChange={(e) => state.setField("newAgendaTitle", e.target.value)}
            />
          </label>
        </div>
        <div className="mlab-participants">
          {state.characters.map((character) => (
            <label
              key={character.characterId}
              className={character.availableForAudience ? "" : "disabled"}
            >
              <input
                type="checkbox"
                disabled={!character.availableForAudience}
                checked={state.selectedParticipants.includes(character.characterId)}
                onChange={() => state.toggleParticipant(character.characterId)}
              />
              {character.name}
            </label>
          ))}
        </div>
        <button
          type="button"
          disabled={state.busy || !state.selectedSaveId}
          onClick={() => void state.create()}
        >
          创建会议 + 议程
        </button>
      </section>

      {state.session ? (
        <section className="mlab-run">
          <h2>
            {state.session.title}
            <span className="mlab-meta">
              {" "}
              {TYPE_LABELS[state.session.type] ?? state.session.type}
            </span>
          </h2>
          {state.session.pendingPlayerAction ? (
            <p className="mlab-pending">
              等待圣裁：{state.session.pendingPlayerAction.reason}（可用：
              {state.session.pendingPlayerAction.allowedActions.join("、")}）
            </p>
          ) : null}
          {state.lastDecision ? <p className="mlab-decision">{state.lastDecision}</p> : null}

          <div className="mlab-controls">
            <button
              type="button"
              disabled={state.busy || state.session.status !== "scheduled"}
              onClick={() => void state.start()}
            >
              开始会议
            </button>
            <button
              type="button"
              disabled={state.busy || !canRun}
              onClick={() => void state.step()}
            >
              推进一步
            </button>
            <button
              type="button"
              disabled={state.busy || !(canRun || state.session.status === "failed")}
              onClick={() => void state.pause()}
            >
              暂停
            </button>
            <button
              type="button"
              disabled={state.busy || state.session.status !== "paused"}
              onClick={() => void state.resume()}
            >
              恢复
            </button>
            <button
              type="button"
              disabled={state.busy || !canRun}
              onClick={() => void state.conclude()}
            >
              结束会议
            </button>
            <button type="button" disabled={state.busy} onClick={() => void state.loadLeak()}>
              泄密评估(Debug)
            </button>
          </div>

          <div className="mlab-actions">
            <textarea
              rows={2}
              value={state.actionText}
              onChange={(e) => state.setField("actionText", e.target.value)}
            />
            <select
              value={state.targetCharacterId ?? ""}
              onChange={(e) => state.setTarget(e.target.value || undefined)}
            >
              <option value="">（不指定人物）</option>
              {state.session.participantIds
                .filter((id) => id !== "emperor")
                .map((id) => (
                  <option key={id} value={id}>
                    {state.characters.find((c) => c.characterId === id)?.name ?? id}
                  </option>
                ))}
            </select>
            <button
              type="button"
              disabled={state.busy || !canRun}
              onClick={() => void state.act({ type: "address-meeting", text: state.actionText })}
            >
              对众宣谕
            </button>
            <button
              type="button"
              disabled={state.busy || !canRun || !state.targetCharacterId}
              onClick={() =>
                void state.act({
                  type: "ask-character",
                  characterId: state.targetCharacterId,
                  text: state.actionText,
                })
              }
            >
              点名垂询
            </button>
            <button
              type="button"
              disabled={state.busy || !canRun || !state.targetCharacterId}
              onClick={() =>
                void state.act({
                  type: "interrupt-character",
                  characterId: state.targetCharacterId,
                  text: state.actionText,
                })
              }
            >
              打断
            </button>
          </div>

          <div className="mlab-columns">
            <div>
              <h3>Transcript（{state.turns.length}）</h3>
              <ol className="mlab-transcript">
                {state.turns.map((turn) => (
                  <li key={turn.turnId}>
                    <span className="mlab-turn-tag">
                      #{turn.turnNumber} {TURN_TYPE_LABELS[turn.type] ?? turn.type}
                    </span>
                    <strong>
                      {state.characters.find((c) => c.characterId === turn.speakerId)?.name ??
                        (turn.speakerId === "emperor" ? "皇帝" : turn.speakerId)}
                    </strong>
                    ：{turn.publicText}
                    {turn.providerTrace ? (
                      <span className="mlab-trace">
                        （{turn.providerTrace.provider}，{turn.providerTrace.durationMs}ms
                        {turn.providerTrace.repaired ? "，已修复" : ""}）
                      </span>
                    ) : null}
                  </li>
                ))}
              </ol>
            </div>
            <div>
              <h3>结果候选（{state.outcomes.length}）</h3>
              <ul className="mlab-outcomes">
                {state.outcomes.map((outcome) => (
                  <li key={outcome.outcomeCandidateId}>
                    <span className={`mlab-status mlab-${outcome.status}`}>{outcome.status}</span>[
                    {outcome.type}] {outcome.title}
                    {outcome.unsupportedCommand ? "（仅建议）" : "（可执行）"}
                    {outcome.status === "presented" || outcome.status === "draft" ? (
                      <button
                        type="button"
                        disabled={state.busy}
                        onClick={() =>
                          void state.rule(outcome.agendaItemId, [outcome.outcomeCandidateId])
                        }
                      >
                        准行
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
              <h3>议程</h3>
              <ul>
                {state.agenda.map((item) => (
                  <li key={item.agendaItemId}>
                    {item.title}（{item.status}）
                  </li>
                ))}
              </ul>
              {state.leak !== undefined ? (
                <>
                  <h3>泄密评估</h3>
                  <pre className="mlab-debug">{JSON.stringify(state.leak, null, 2)}</pre>
                </>
              ) : null}
            </div>
          </div>
        </section>
      ) : null}

      {state.error ? <p className="mlab-error">{state.error}</p> : null}
      <footer>
        会议发言不是世界事实；只有圣裁准行的白名单候选才会经 StateEngine 变更 GameState。
      </footer>
    </main>
  );
}
