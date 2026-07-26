import { ENGINE_VERSION } from "@mandate/shared";
import Fastify from "fastify";
import { config } from "./config";

/**
 * Phase 0 最小服务端：仅健康检查与版本端点。
 * 应用服务（会议/政策/存档等）按路线图分阶段加入。
 */
const app = Fastify({
  logger: { level: config.LOG_LEVEL },
});

app.get("/api/health", () => {
  return {
    status: "ok",
    service: "mandate-server",
    phase: 0,
    llmProvider: config.LLM_PROVIDER,
  };
});

app.get("/api/version", () => {
  return { version: ENGINE_VERSION };
});

const start = async () => {
  try {
    await app.listen({ port: config.SERVER_PORT, host: "127.0.0.1" });
    app.log.info({ port: config.SERVER_PORT }, "mandate-server 已启动");
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
};

void start();
