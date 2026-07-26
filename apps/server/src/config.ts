import "dotenv/config";
import { z } from "zod";

/**
 * 服务端配置：dotenv 加载 + Zod 启动时校验。
 * 配置非法应在启动时立刻失败，而不是运行期出现诡异行为。
 */
const EnvSchema = z.object({
  SERVER_PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  LLM_PROVIDER: z.enum(["mock", "openai-compatible"]).default("mock"),
});

export const config = EnvSchema.parse(process.env);
export type ServerConfig = z.infer<typeof EnvSchema>;
