import { buildApp } from "./app";
import { loadRuntimeConfig, RuntimeConfigError } from "./config/index";

async function start(): Promise<void> {
  const config = loadRuntimeConfig();
  const app = await buildApp({ config });
  await app.listen({ port: config.server.port, host: config.server.host });
  app.log.info({ host: config.server.host, port: config.server.port }, "mandate-server 已启动");
}

void start().catch((error: unknown) => {
  const message = error instanceof RuntimeConfigError ? error.message : "mandate-server 启动失败";
  console.error(message);
  process.exitCode = 1;
});
