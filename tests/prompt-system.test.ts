import { describe, expect, it } from "vitest";
import { loadPrompt, PromptRenderError, renderPrompt, type PromptId } from "@mandate/prompt-system";

describe("Prompt 资产", () => {
  it("通过注册 ID 加载版本化 Markdown", async () => {
    const asset = await loadPrompt("system.base");

    expect(asset).toMatchObject({ id: "system.base", version: "v1" });
    expect(asset.template).toContain("{{scenarioName}}");
  });

  it.each<PromptId>([
    "meeting.court-assembly",
    "meeting.imperial-council",
    "meeting.secret-council",
    "parser.policy-draft",
    "narrator.memorial-summary",
  ])("注册并加载 %s", async (id) => {
    await expect(loadPrompt(id)).resolves.toMatchObject({ id, version: "v1" });
  });

  it("拒绝未注册 ID，而不是把 ID 当作路径", async () => {
    await expect(loadPrompt("../../package.json" as PromptId)).rejects.toThrow(
      "未注册的 Prompt ID",
    );
  });
});

describe("Prompt 渲染", () => {
  it("替换全部同名变量并保留普通 Markdown", () => {
    expect(renderPrompt("# {{name}}\n{{name}}：{{message}}", { name: "王承恩", message: "遵旨" }))
      .toMatchInlineSnapshot(`
        "# 王承恩
        王承恩：遵旨"
      `);
  });

  it("一次列出全部缺失变量", () => {
    expect(() =>
      renderPrompt("{{characterName}} / {{meetingType}} / {{characterName}}", {}),
    ).toThrowError(PromptRenderError);
    expect(() => renderPrompt("{{characterName}} / {{meetingType}}", {})).toThrow(
      "缺少 Prompt 变量：characterName, meetingType",
    );
  });
});
