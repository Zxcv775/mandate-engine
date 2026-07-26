import { readFile } from "node:fs/promises";
import type { PromptAsset, PromptId } from "./types";

interface PromptRegistration {
  version: PromptAsset["version"];
  assetPath: string;
}

/**
 * 注册式白名单加载：只有登记在册的 Prompt ID 可被加载，
 * ID 不是路径——任何路径式取值都会被拒绝（ADR-013）。
 */
export const promptRegistry: Readonly<Record<PromptId, PromptRegistration>> = {
  "system.base": { version: "v1", assetPath: "system/base.v1.md" },
  "system.character-agent-base": {
    version: "v1",
    assetPath: "system/character-agent-base.v1.md",
  },
  "character.identity": { version: "v1", assetPath: "character/identity.v1.md" },
  "character.personality": { version: "v1", assetPath: "character/personality.v1.md" },
  "character.political-profile": {
    version: "v1",
    assetPath: "character/political-profile.v1.md",
  },
  "character.communication-style": {
    version: "v1",
    assetPath: "character/communication-style.v1.md",
  },
  "knowledge.known-world-state": {
    version: "v1",
    assetPath: "knowledge/known-world-state.v1.md",
  },
  "context.private-audience": { version: "v1", assetPath: "context/private-audience.v1.md" },
  "context.court-assembly": { version: "v1", assetPath: "context/court-assembly.v1.md" },
  "context.imperial-council": { version: "v1", assetPath: "context/imperial-council.v1.md" },
  "context.secret-council": { version: "v1", assetPath: "context/secret-council.v1.md" },
  "context.memorial-response": { version: "v1", assetPath: "context/memorial-response.v1.md" },
  "context.general": { version: "v1", assetPath: "context/general.v1.md" },
  "context.conversation-input": {
    version: "v1",
    assetPath: "context/conversation-input.v1.md",
  },
  "memory.memory-context": { version: "v1", assetPath: "memory/memory-context.v1.md" },
  "memory.memory-candidate": { version: "v1", assetPath: "memory/memory-candidate.v1.md" },
  "output.character-response": { version: "v1", assetPath: "output/character-response.v1.md" },
  "output.repair-structured-output": {
    version: "v1",
    assetPath: "output/repair-structured-output.v1.md",
  },
  "meeting.court-assembly": {
    version: "v1",
    assetPath: "meeting/court-assembly.v1.md",
  },
  "meeting.imperial-council": {
    version: "v1",
    assetPath: "meeting/imperial-council.v1.md",
  },
  "meeting.secret-council": {
    version: "v1",
    assetPath: "meeting/secret-council.v1.md",
  },
  "parser.policy-draft": { version: "v1", assetPath: "parser/policy-draft.v1.md" },
  "narrator.memorial-summary": {
    version: "v1",
    assetPath: "narrator/memorial-summary.v1.md",
  },
};

export class PromptLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptLoadError";
  }
}

export async function loadPrompt(id: PromptId): Promise<PromptAsset> {
  const registration = promptRegistry[id];
  if (!registration) throw new PromptLoadError(`未注册的 Prompt ID：${id}`);

  const template = await readFile(
    new URL(`../assets/${registration.assetPath}`, import.meta.url),
    "utf8",
  );
  return { id, version: registration.version, template };
}
