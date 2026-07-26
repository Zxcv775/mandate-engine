import type { CharacterConversationMode } from "@mandate/domain";
import { useEffect } from "react";
import { useStore } from "zustand";
import { characterLabStore } from "../../store/character-lab-store";
import "./character-lab.css";

const MODE_LABELS: Record<CharacterConversationMode, string> = {
  "private-audience": "单独召见",
  "court-assembly": "大朝会",
  "imperial-council": "御前会议",
  "secret-council": "秘密议事",
  "memorial-response": "奏疏应对",
  general: "一般对答",
};

const STANCE_LABELS: Record<string, string> = {
  support: "支持",
  oppose: "反对",
  conditional: "有条件支持",
  neutral: "中立",
  evasive: "回避",
  uncertain: "不确定",
};

const EMOTION_LABELS: Record<string, string> = {
  calm: "平静",
  concerned: "忧虑",
  angry: "愠怒",
  fearful: "惶惧",
  confident: "自信",
  guarded: "戒备",
  humiliated: "屈辱",
  ambitious: "热切",
};

export function CharacterLab() {
  const state = useStore(characterLabStore);

  useEffect(() => {
    void characterLabStore.getState().refreshSaves();
  }, []);

  return (
    <main className="lab-shell">
      <header className="lab-header">
        <div>
          <p className="eyebrow">MANDATE ENGINE · PHASE 3</p>
          <h1>Character Lab · 人物调试台</h1>
          <p>单人物 Character Agent 的开发者测试界面；不展示 sealed 数据与完整系统 Prompt。</p>
        </div>
        <button type="button" onClick={() => void state.refreshSaves()}>
          刷新存档
        </button>
      </header>

      <section className="lab-controls">
        <label>
          存档
          <select
            value={state.selectedSaveId ?? ""}
            onChange={(event) => void state.selectSave(event.target.value)}
          >
            <option value="" disabled>
              {state.savesStatus === "loading" ? "载入中…" : "选择存档"}
            </option>
            {state.saves.map((save) => (
              <option key={save.saveId} value={save.saveId}>
                {save.title}（{save.saveId} · rev {save.headRevision}）
              </option>
            ))}
          </select>
        </label>

        <label>
          人物
          <select
            value={state.selectedCharacterId ?? ""}
            onChange={(event) => state.selectCharacter(event.target.value)}
            disabled={state.characters.length === 0}
          >
            <option value="" disabled>
              选择人物
            </option>
            {state.characters.map((character) => (
              <option
                key={character.characterId}
                value={character.characterId}
                disabled={!character.availableForAudience}
              >
                {character.name}
                {character.currentOfficeId ? `（${character.currentOfficeId}）` : "（无官职）"}
                {character.availableForAudience ? "" : " · 不可召对"}
              </option>
            ))}
          </select>
        </label>

        <label>
          场合
          <select
            value={state.mode}
            onChange={(event) =>
              state.setMode(event.target.value as CharacterConversationMode)
            }
          >
            {Object.entries(MODE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>

        <label>
          议题（可选）
          <input
            value={state.topic}
            onChange={(event) => state.setTopic(event.target.value)}
            placeholder="如 liaodong-situation"
          />
        </label>

        <label className="lab-revision">
          expectedRevision
          <input value={state.headRevision ?? ""} readOnly />
        </label>

        <label className="lab-debug-toggle">
          <input
            type="checkbox"
            checked={state.debugEnabled}
            onChange={(event) => state.setDebugEnabled(event.target.checked)}
          />
          Debug 模式
        </label>
      </section>

      <section className="lab-input">
        <label>
          皇帝发言
          <textarea
            value={state.inputText}
            onChange={(event) => state.setInputText(event.target.value)}
            rows={3}
          />
        </label>
        <button
          type="button"
          disabled={state.sending || !state.selectedCharacterId}
          onClick={() => void state.send()}
        >
          {state.sending ? "召对中…" : "发起召对"}
        </button>
        {state.debugEnabled ? (
          <button type="button" onClick={() => void state.loadDebugContext()}>
            查看知识视图摘要
          </button>
        ) : null}
      </section>

      {state.error ? <p className="lab-error">{state.error}</p> : null}

      {state.response ? (
        <section className="lab-result">
          <h2>
            人物应对{" "}
            <span className="lab-meta">
              立场 {STANCE_LABELS[state.response.stance.position] ?? state.response.stance.position}
              （把握 {state.response.stance.confidence}）· 情绪{" "}
              {EMOTION_LABELS[state.response.emotionalState.primary] ??
                state.response.emotionalState.primary}
              （{state.response.emotionalState.intensity}）· 基于 revision{" "}
              {state.response.stateRevision}
            </span>
          </h2>
          <blockquote className="lab-speech">{state.response.speech}</blockquote>

          {state.response.stance.publicReasoning.length > 0 ? (
            <div>
              <h3>公开理由</h3>
              <ul>
                {state.response.stance.publicReasoning.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {state.response.claims.length > 0 ? (
            <div>
              <h3>事实主张</h3>
              <ul>
                {state.response.claims.map((claim) => (
                  <li key={claim.claim}>
                    {claim.claim}（{claim.basis}，可信 {claim.confidence}）
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {state.response.proposedActions.length > 0 ? (
            <div>
              <h3>候选行动（仅为建议，不会自动执行）</h3>
              <ul>
                {state.response.proposedActions.map((action) => (
                  <li key={action.summary}>
                    [{action.type}] {action.summary}（把握 {action.confidence}）
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {state.response.uncertaintyNotes.length > 0 ? (
            <div>
              <h3>不确定之处</h3>
              <ul>
                {state.response.uncertaintyNotes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      ) : null}

      {state.debugEnabled && state.debugInfo !== undefined ? (
        <section className="lab-debug">
          <h3>调用调试信息</h3>
          <pre>{JSON.stringify(state.debugInfo, null, 2)}</pre>
        </section>
      ) : null}

      {state.debugEnabled && state.contextInfo !== undefined ? (
        <section className="lab-debug">
          <h3>知识视图摘要</h3>
          <pre>{JSON.stringify(state.contextInfo, null, 2)}</pre>
        </section>
      ) : null}

      <footer>
        Character Lab 调用不会改变 GameState；候选行动须经后续阶段的 Command 流程才可能生效。
      </footer>
    </main>
  );
}
