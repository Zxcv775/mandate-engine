import type {
  CharacterConversationMode,
  CharacterPublicResponse,
  CharacterSummary,
  SaveMetadata,
} from "@mandate/domain";
import { createStore } from "zustand/vanilla";
import { ApiClientError } from "../api/client";
import {
  getDebugContext,
  listCharacters,
  respondCharacter,
  respondCharacterWithDebug,
} from "../api/characters";
import { getSaveState, listSaves } from "../api/saves";

/**
 * Character Lab 状态（开发者调试台，不是正式游戏 UI）。
 * 只经公开/Debug API 交互；不展示 sealed 记忆、hidden state 与完整系统 Prompt。
 */

export type LabStatus = "idle" | "loading" | "success" | "error" | "offline";

export interface CharacterLabState {
  saves: readonly SaveMetadata[];
  savesStatus: LabStatus;
  selectedSaveId?: string;
  headRevision?: number;
  characters: readonly CharacterSummary[];
  charactersStatus: LabStatus;
  selectedCharacterId?: string;
  mode: CharacterConversationMode;
  topic: string;
  inputText: string;
  debugEnabled: boolean;
  sending: boolean;
  response?: CharacterPublicResponse;
  debugInfo?: unknown;
  contextInfo?: unknown;
  error?: string;
  refreshSaves(): Promise<void>;
  selectSave(saveId: string): Promise<void>;
  selectCharacter(characterId: string): void;
  setMode(mode: CharacterConversationMode): void;
  setTopic(topic: string): void;
  setInputText(text: string): void;
  setDebugEnabled(enabled: boolean): void;
  send(): Promise<void>;
  loadDebugContext(): Promise<void>;
}

function describeError(error: unknown): string {
  if (error instanceof ApiClientError) {
    return error.code ? `${error.code}: ${error.message}` : error.message;
  }
  return error instanceof Error ? error.message : "未知错误";
}

export const characterLabStore = createStore<CharacterLabState>()((set, get) => ({
  saves: [],
  savesStatus: "idle",
  characters: [],
  charactersStatus: "idle",
  mode: "private-audience",
  topic: "",
  inputText: "辽东局势究竟如何？卿务必据实陈奏。",
  debugEnabled: false,
  sending: false,

  async refreshSaves() {
    set({ savesStatus: "loading" });
    try {
      const saves = await listSaves();
      set({ saves, savesStatus: "success" });
    } catch (error) {
      set({ savesStatus: "error", error: describeError(error) });
    }
  },

  async selectSave(saveId) {
    set({
      selectedSaveId: saveId,
      charactersStatus: "loading",
      characters: [],
      response: undefined,
      debugInfo: undefined,
      contextInfo: undefined,
      error: undefined,
    });
    try {
      const [characters, state] = await Promise.all([
        listCharacters(saveId),
        getSaveState(saveId),
      ]);
      set({
        characters,
        charactersStatus: "success",
        headRevision: state.revision,
        selectedCharacterId: characters.find((value) => value.availableForAudience)?.characterId,
      });
    } catch (error) {
      set({ charactersStatus: "error", error: describeError(error) });
    }
  },

  selectCharacter(characterId) {
    set({ selectedCharacterId: characterId, response: undefined, debugInfo: undefined });
  },
  setMode(mode) {
    set({ mode });
  },
  setTopic(topic) {
    set({ topic });
  },
  setInputText(inputText) {
    set({ inputText });
  },
  setDebugEnabled(debugEnabled) {
    set({ debugEnabled });
  },

  async send() {
    const state = get();
    if (!state.selectedSaveId || !state.selectedCharacterId || state.headRevision === undefined) {
      set({ error: "请先选择存档与人物" });
      return;
    }
    if (state.inputText.trim().length === 0) {
      set({ error: "请输入发言内容" });
      return;
    }
    set({ sending: true, error: undefined, response: undefined, debugInfo: undefined });
    const payload = {
      expectedRevision: state.headRevision,
      mode: state.mode,
      input: { speakerId: "emperor", text: state.inputText.trim() },
      participantIds: ["emperor", state.selectedCharacterId],
      ...(state.topic.trim().length > 0 ? { topic: state.topic.trim() } : {}),
    };
    try {
      if (state.debugEnabled) {
        const data = await respondCharacterWithDebug(
          state.selectedSaveId,
          state.selectedCharacterId,
          payload,
        );
        set({ response: data.response, debugInfo: data.debug, sending: false });
      } else {
        const response = await respondCharacter(
          state.selectedSaveId,
          state.selectedCharacterId,
          payload,
        );
        set({ response, sending: false });
      }
    } catch (error) {
      set({ sending: false, error: describeError(error) });
    }
  },

  async loadDebugContext() {
    const state = get();
    if (!state.selectedSaveId || !state.selectedCharacterId) return;
    try {
      const data = await getDebugContext(state.selectedSaveId, state.selectedCharacterId);
      set({ contextInfo: data });
    } catch (error) {
      set({ error: describeError(error) });
    }
  },
}));
