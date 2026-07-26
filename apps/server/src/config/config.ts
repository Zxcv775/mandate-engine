import { config as loadDotEnv } from "dotenv";
import type { PublicRuntimeConfig } from "@mandate/domain";
import { fileURLToPath } from "node:url";
import { RuntimeEnvironmentSchema, type LlmProviderName, type LogLevel } from "./schema";

export interface RuntimeConfigIssue {
  path: string;
  message: string;
}

export class RuntimeConfigError extends Error {
  constructor(readonly issues: readonly RuntimeConfigIssue[]) {
    super(`运行时配置无效：${issues.map((issue) => `${issue.path}: ${issue.message}`).join("；")}`);
    this.name = "RuntimeConfigError";
  }
}

export interface RuntimeConfig {
  nodeEnv: "development" | "test" | "production";
  server: {
    host: string;
    port: number;
    logLevel: LogLevel;
  };
  llm: {
    provider: LlmProviderName;
    baseUrl?: string;
    apiKey?: string;
    model: string;
    timeoutMs: number;
    maxRetries: number;
  };
  scenario: {
    defaultScenarioId: string;
  };
  storage: {
    databasePath: string;
    checkpointInterval: number;
  };
  debug: {
    /** Debug API（人物上下文/记忆查询）开关；生产环境默认 false */
    apiEnabled: boolean;
  };
  character: {
    maxRepairAttempts: number;
    memoryMaxPerCharacter: number;
  };
}

export function parseRuntimeConfig(env: Record<string, string | undefined>): RuntimeConfig {
  const result = RuntimeEnvironmentSchema.safeParse(env);
  if (!result.success) {
    throw new RuntimeConfigError(
      result.error.issues.map((issue) => ({
        path: issue.path.map(String).join(".") || "environment",
        message: issue.message,
      })),
    );
  }

  const parsed = result.data;
  const llm: RuntimeConfig["llm"] = {
    provider: parsed.LLM_PROVIDER,
    model: parsed.LLM_MODEL ?? "mock-model",
    timeoutMs: parsed.LLM_TIMEOUT_MS,
    maxRetries: parsed.LLM_MAX_RETRIES,
  };
  if (parsed.LLM_BASE_URL !== undefined) llm.baseUrl = parsed.LLM_BASE_URL;
  if (parsed.LLM_API_KEY !== undefined) llm.apiKey = parsed.LLM_API_KEY;

  return {
    nodeEnv: parsed.NODE_ENV,
    server: {
      host: parsed.SERVER_HOST,
      port: parsed.SERVER_PORT,
      logLevel: parsed.LOG_LEVEL,
    },
    llm,
    scenario: {
      defaultScenarioId: parsed.DEFAULT_SCENARIO_ID,
    },
    storage: {
      databasePath:
        parsed.SAVE_DATABASE_PATH ??
        (parsed.NODE_ENV === "test" ? ":memory:" : "./saves/mandate-engine.sqlite"),
      checkpointInterval: parsed.SAVE_CHECKPOINT_INTERVAL,
    },
    debug: {
      apiEnabled: parsed.DEBUG_API_ENABLED ?? parsed.NODE_ENV !== "production",
    },
    character: {
      maxRepairAttempts: parsed.CHARACTER_MAX_REPAIR_ATTEMPTS,
      memoryMaxPerCharacter: parsed.CHARACTER_MEMORY_MAX_PER_CHARACTER,
    },
  };
}

export function loadRuntimeConfig(): RuntimeConfig {
  // npm workspace 脚本的 cwd 是 apps/server，必须显式定位仓库根 .env。
  loadDotEnv({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)) });
  return parseRuntimeConfig(process.env);
}

export function toPublicRuntimeConfig(config: RuntimeConfig): PublicRuntimeConfig {
  return {
    environment: config.nodeEnv,
    provider: {
      name: config.llm.provider,
      model: config.llm.model,
      hasApiKey: config.llm.apiKey !== undefined,
      baseUrlConfigured: config.llm.baseUrl !== undefined,
      isMock: config.llm.provider === "mock",
    },
    scenario: { ...config.scenario },
  };
}
