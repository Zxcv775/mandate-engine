import { z } from "zod";

export const NodeEnvironmentSchema = z.enum(["development", "test", "production"]);
export type NodeEnvironment = z.infer<typeof NodeEnvironmentSchema>;

export const LlmProviderNameSchema = z.enum(["mock", "openai-compatible"]);
export type LlmProviderName = z.infer<typeof LlmProviderNameSchema>;

export const LogLevelSchema = z.enum(["fatal", "error", "warn", "info", "debug", "trace"]);
export type LogLevel = z.infer<typeof LogLevelSchema>;

const optionalTrimmedString = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().min(1).optional(),
);

const optionalApiKey = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().min(1).optional(),
);

const optionalHttpUrl = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z
    .url()
    .refine((value) => {
      const protocol = new URL(value).protocol;
      return protocol === "http:" || protocol === "https:";
    }, "必须使用 http 或 https 协议")
    .transform((value) => value.replace(/\/+$/, ""))
    .optional(),
);

export const RuntimeEnvironmentSchema = z
  .object({
    NODE_ENV: NodeEnvironmentSchema.default("development"),
    SERVER_HOST: z.string().trim().min(1).default("127.0.0.1"),
    SERVER_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    LOG_LEVEL: LogLevelSchema.default("info"),
    LLM_PROVIDER: LlmProviderNameSchema.default("mock"),
    LLM_BASE_URL: optionalHttpUrl,
    LLM_API_KEY: optionalApiKey,
    LLM_MODEL: optionalTrimmedString,
    LLM_TIMEOUT_MS: z.coerce.number().int().positive().max(300_000).default(30_000),
    LLM_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(2),
    DEFAULT_SCENARIO_ID: z.string().trim().min(1).default("chongzhen-early"),
    SAVE_DATABASE_PATH: optionalTrimmedString,
    SAVE_CHECKPOINT_INTERVAL: z.coerce.number().int().min(1).max(10_000).default(50),
    /** Debug API 开关：缺省时非生产环境开、生产环境关 */
    DEBUG_API_ENABLED: z
      .preprocess(
        (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
        z.enum(["true", "false"]).optional(),
      )
      .transform((value) => (value === undefined ? undefined : value === "true")),
    CHARACTER_MAX_REPAIR_ATTEMPTS: z.coerce.number().int().min(0).max(3).default(1),
    CHARACTER_MEMORY_MAX_PER_CHARACTER: z.coerce.number().int().min(1).max(10_000).default(500),
  })
  .superRefine((value, context) => {
    if (value.LLM_PROVIDER !== "openai-compatible") return;

    if (!value.LLM_BASE_URL) {
      context.addIssue({
        code: "custom",
        path: ["LLM_BASE_URL"],
        message: "openai-compatible 模式必须提供合法 Base URL",
      });
    }
    if (!value.LLM_MODEL) {
      context.addIssue({
        code: "custom",
        path: ["LLM_MODEL"],
        message: "openai-compatible 模式必须提供模型名称",
      });
    }
  });

export type RuntimeEnvironment = z.infer<typeof RuntimeEnvironmentSchema>;
