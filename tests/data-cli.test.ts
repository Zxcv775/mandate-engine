import { describe, expect, it } from "vitest";
import { formatValidationIssue } from "../scripts/validate-data";

describe("数据校验 CLI 输出", () => {
  it("包含错误类型、文件、实体、字段路径和原因", () => {
    expect(
      formatValidationIssue({
        type: "data-reference-invalid",
        file: "data/characters/ming/example.json",
        entity: "example",
        path: "meta.sourceIds[0]",
        message: 'referenced historical source "missing" does not exist',
      }),
    ).toBe(
      [
        "[data-reference-invalid]",
        "file: data/characters/ming/example.json",
        "entity: example",
        "path: meta.sourceIds[0]",
        'message: referenced historical source "missing" does not exist',
      ].join("\n"),
    );
  });
});
