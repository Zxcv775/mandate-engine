import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "packages/**/*.test.ts"],
    // 红线：测试不得触网（FR-LLM-002），一律使用 MockLLMProvider
  },
});
