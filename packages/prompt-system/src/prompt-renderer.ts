import type { PromptVariables } from "./types";

const variablePattern = /{{\s*([A-Za-z][A-Za-z0-9_]*)\s*}}/g;

export class PromptRenderError extends Error {
  constructor(readonly missingVariables: readonly string[]) {
    super(`缺少 Prompt 变量：${missingVariables.join(", ")}`);
    this.name = "PromptRenderError";
  }
}

export function renderPrompt(template: string, variables: PromptVariables): string {
  const referenced = [...template.matchAll(variablePattern)].map((match) => match[1]!);
  const missing = [...new Set(referenced.filter((name) => variables[name] === undefined))];
  if (missing.length > 0) throw new PromptRenderError(missing);

  return template.replace(variablePattern, (_match, name: string) => String(variables[name]));
}
