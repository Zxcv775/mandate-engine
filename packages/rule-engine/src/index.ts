/**
 * @mandate/rule-engine —— 数据驱动规则引擎（Phase 5，ADR-022/024）。
 *
 * 职责：Modifier 收集/合成/过期、白名单条件树求值（禁 eval）、
 * 白名单 effect → 候选 Mutation 规划、政策合法性检查、执行结算、规则注册表与 Manifest。
 * 红线：
 * - 纯函数库：不持久化、不依赖 SQLite / llm-adapters / agent-runtime（依赖矩阵测试守护）；
 * - 随机数一律由调用方注入（SeededRng / 派生流），本包不接触真实时钟与非种子随机；
 * - hidden 区不可作为规则条件输入。
 */
export * from "./errors";
export * from "./modifier";
export * from "./condition";
export * from "./interpreter";
export * from "./effects";
export * from "./registry";
export * from "./legality";
export * from "./resolution";
