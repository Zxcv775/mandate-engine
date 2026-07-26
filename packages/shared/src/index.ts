export * from "./result";
export * from "./rng";
export * from "./id";

/** 产品版本：服务端、前端与未来存档迁移共同使用的单一来源。 */
export const ENGINE_INFO = {
  name: "mandate-engine",
  version: "0.3.0",
  phase: 3,
} as const;

/** 兼容 Phase 0 已公开的常量名。 */
export const ENGINE_VERSION = ENGINE_INFO.version;
