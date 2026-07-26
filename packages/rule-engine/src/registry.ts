import type { Rule, RulePack, RuleScope } from "@mandate/domain";
import { RulePackSchema } from "@mandate/domain";
import { fnv1a } from "@mandate/shared";
import { RuleEngineError } from "./errors";
import { sortRulesDeterministically } from "./interpreter";

/**
 * 规则注册表 + Manifest（与 Prompt 资产同规格：白名单加载、版本、Snapshot 测试）。
 * 加载期全量 Schema 校验；重复规则 id 直接拒绝；Manifest 供 Debug API 与快照断言。
 */

export interface RulePackManifestEntry {
  readonly packId: string;
  readonly dslVersion: number;
  readonly ruleIds: readonly string[];
  /** fnv1a 十六进制校验（快照检测用；非密码学用途） */
  readonly checksum: string;
}

export interface RuleRegistry {
  readonly rules: readonly Rule[];
  readonly manifest: readonly RulePackManifestEntry[];
  byScope(scope: RuleScope): readonly Rule[];
  byId(ruleId: string): Rule;
}

function packChecksum(pack: RulePack): string {
  return fnv1a(JSON.stringify(pack)).toString(16).padStart(8, "0");
}

export function createRuleRegistry(packs: readonly RulePack[]): RuleRegistry {
  const rules: Rule[] = [];
  const manifest: RulePackManifestEntry[] = [];
  const seen = new Set<string>();
  for (const pack of [...packs].sort((a, b) => a.packId.localeCompare(b.packId))) {
    const parsed = RulePackSchema.safeParse(pack);
    if (!parsed.success) {
      throw new RuleEngineError(
        "RULE_SCHEMA_INVALID",
        `规则包 ${pack.packId} 未通过 Schema 校验`,
        parsed.error.issues,
      );
    }
    for (const rule of parsed.data.rules) {
      if (seen.has(rule.id)) {
        throw new RuleEngineError("RULE_SCHEMA_INVALID", `规则 id 跨包重复：${rule.id}`);
      }
      seen.add(rule.id);
      rules.push(rule);
    }
    manifest.push({
      packId: parsed.data.packId,
      dslVersion: parsed.data.dslVersion,
      ruleIds: parsed.data.rules.map((rule) => rule.id).sort(),
      checksum: packChecksum(parsed.data),
    });
  }
  const sorted = sortRulesDeterministically(rules);
  const byScopeCache = new Map<RuleScope, readonly Rule[]>();
  return {
    rules: sorted,
    manifest,
    byScope(scope) {
      let cached = byScopeCache.get(scope);
      if (!cached) {
        cached = sorted.filter((rule) => rule.scope === scope);
        byScopeCache.set(scope, cached);
      }
      return cached;
    },
    byId(ruleId) {
      const rule = sorted.find((candidate) => candidate.id === ruleId);
      if (!rule) throw new RuleEngineError("RULE_NOT_FOUND", `规则不存在：${ruleId}`);
      return rule;
    },
  };
}
