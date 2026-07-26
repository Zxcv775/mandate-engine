import type { LLMProvider } from "@mandate/llm-adapters";
import { createScenarioLoader, type ScenarioLoader } from "@mandate/data-loader";
import Fastify, { type FastifyInstance } from "fastify";
import type { Writable } from "node:stream";
import { createSaveSystem, type GameStateService, type SaveSystem } from "@mandate/save-system";
import type { RuntimeConfig } from "./config/index";
import { registerErrorHandlers } from "./errors/error-handler";
import { createLlmProvider } from "./providers/provider-factory";
import { registerHealthRoute } from "./routes/health";
import { registerRuntimeConfigRoute } from "./routes/runtime-config";
import { registerScenarioRoutes } from "./routes/scenarios";
import { registerVersionRoute } from "./routes/version";
import { registerSaveRoutes } from "./routes/saves";
import { registerCharacterRoutes } from "./routes/characters";
import { registerDebugCharacterRoutes } from "./routes/debug-characters";
import { registerMeetingRoutes } from "./routes/meetings";
import { registerDebugMeetingRoutes } from "./routes/debug-meetings";
import { registerPolicyRoutes } from "./routes/policies";
import { registerDebugPolicyRoutes } from "./routes/debug-policies";
import { createLlmService, type LlmService } from "./services/llm-service";
import { createScenarioService } from "./services/scenario-service";
import { CharacterService } from "./services/character-service";
import { MeetingService } from "./services/meeting-service";
import { PolicyService } from "./services/policy-service";

declare module "fastify" {
  interface FastifyInstance {
    llmService: LlmService;
    gameStateService: GameStateService;
    characterService: CharacterService;
    meetingService: MeetingService;
    policyService: PolicyService;
  }
}

interface LoggerOptions {
  level?: string;
  redact?: string[];
  stream?: Writable;
}

const requiredRedactions = [
  "req.headers.authorization",
  "headers.authorization",
  "apiKey",
  "config.llm.apiKey",
  "req.body.password",
  "req.body.packageBase64",
  "password",
] as const;

function resolveLoggerOptions(
  config: RuntimeConfig,
  logger: BuildAppOptions["logger"],
): boolean | LoggerOptions {
  if (logger === false) return false;
  if (logger === undefined && config.nodeEnv === "test") return false;
  if (logger === true || logger === undefined) {
    return { level: config.server.logLevel, redact: [...requiredRedactions] };
  }
  return {
    ...logger,
    redact: [...requiredRedactions, ...(logger.redact ?? [])],
  };
}

export interface BuildAppOptions {
  config: RuntimeConfig;
  provider?: LLMProvider;
  scenarioLoader?: ScenarioLoader;
  dataRoot?: string | URL;
  logger?: boolean | LoggerOptions;
  saveSystem?: SaveSystem;
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { config } = options;
  const app = Fastify({
    logger: resolveLoggerOptions(config, options.logger),
  });

  const provider = options.provider ?? createLlmProvider(config.llm);
  app.decorate("llmService", createLlmService(provider, config.llm, app.log));
  const scenarioLoader =
    options.scenarioLoader ?? createScenarioLoader({ dataRoot: options.dataRoot });
  const scenarioService = createScenarioService(scenarioLoader);

  // 启动装配阶段校验并缓存默认场景，避免首次请求才暴露模板错误。
  await scenarioService.get(config.scenario.defaultScenarioId);

  const ownsSaveSystem = options.saveSystem === undefined;
  const saveSystem =
    options.saveSystem ??
    createSaveSystem({
      databasePath: config.storage.databasePath,
      checkpointInterval: config.storage.checkpointInterval,
      scenarioLoader,
    });
  app.decorate("gameStateService", saveSystem.service);
  if (ownsSaveSystem) {
    app.addHook("onClose", async () => saveSystem.close());
  }

  const characterService = new CharacterService({
    gameStateService: saveSystem.service,
    memories: saveSystem.characterMemories,
    scenarioLoader,
    llm: app.llmService,
    config,
    logger: app.log,
  });
  app.decorate("characterService", characterService);

  const meetingService = new MeetingService({
    gameStateService: saveSystem.service,
    meetings: saveSystem.meetings,
    memories: saveSystem.characterMemories,
    scenarioLoader,
    llm: { generate: (messages) => app.llmService.generateText(messages) },
    config,
    logger: app.log,
  });
  app.decorate("meetingService", meetingService);

  const policyService = new PolicyService({
    gameStateService: saveSystem.service,
    policyDetails: saveSystem.policyDetails,
    scenarioLoader,
  });
  app.decorate("policyService", policyService);

  registerErrorHandlers(app);
  registerHealthRoute(app);
  registerVersionRoute(app);
  registerRuntimeConfigRoute(app, config);
  registerScenarioRoutes(app, scenarioService);
  registerSaveRoutes(app, saveSystem.service);
  registerCharacterRoutes(app, characterService);
  registerMeetingRoutes(app, meetingService);
  registerPolicyRoutes(app, policyService);
  if (config.debug.apiEnabled) {
    registerDebugCharacterRoutes(app, characterService);
    registerDebugMeetingRoutes(app, meetingService);
    registerDebugPolicyRoutes(app, policyService);
  }

  return app;
}
