import type { DatabaseSync } from "node:sqlite";
import type { PolicyReport } from "@mandate/domain";
import type {
  PolicyDeviationLogRecord,
  PolicyResolutionArtifacts,
  PolicyCostApplicationRecord,
  PolicyStageResultRecord,
} from "@mandate/game-engine";
import type { Clock } from "@mandate/game-engine";
import { currentTimelineRevisionPredicate } from "./timeline";

/**
 * 政策明细仓储（migration 004，ADR-025）。
 * append-only：阶段结算 breakdown / 公开与内档奏报 / 执行偏差留痕。
 * 政策运行态本体在 GameState——本仓储只存明细与文书；
 * insertResolutionArtifacts 必须在 commitTransition 的同事务 extraWrites 内调用；
 * 回滚后重推同 tick 时以确定性重放内容覆盖旧行（INSERT OR REPLACE）。
 */
export class PolicyDetailRepository {
  constructor(
    private readonly database: DatabaseSync,
    private readonly clock: Clock,
  ) {}

  insertResolutionArtifacts(artifacts: PolicyResolutionArtifacts): void {
    const now = this.clock.now().toISOString();
    const insertResult = this.database.prepare(
      `INSERT INTO policy_stage_results (
         result_id, save_id, policy_id, tick, revision, stage_index, funding_ratio,
         breakdown_json, real_delta, reported_delta, rule_trace_json, notes_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const result of artifacts.stageResults) {
      insertResult.run(
        `psr_${result.saveId}_${result.policyId}_${result.tick}_${result.revision}`,
        result.saveId,
        result.policyId,
        result.tick,
        result.revision,
        result.stageIndex,
        result.fundingRatio,
        JSON.stringify(result.breakdown),
        result.realDelta,
        result.reportedDelta,
        JSON.stringify(result.ruleTrace),
        JSON.stringify(result.notes),
        now,
      );
    }
    const insertReport = this.database.prepare(
      `INSERT INTO policy_reports (
         report_id, save_id, policy_id, tick, revision, stage_index,
         reported_stage_progress, reported_overall_progress, audience, text, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const report of artifacts.reports) {
      insertReport.run(
        `${report.reportId}_r${report.revision}`,
        report.saveId,
        report.policyId,
        report.tick,
        report.revision,
        report.stageIndex,
        report.reportedStageProgress,
        report.reportedOverallProgress,
        report.audience,
        report.text,
        report.createdAt,
      );
    }
    const insertDeviation = this.database.prepare(
      `INSERT INTO policy_deviation_log (
         deviation_id, save_id, policy_id, tick, revision, deviation_type,
         magnitude, real_deviation, discovered, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    artifacts.deviationLogs.forEach((deviation, index) => {
      insertDeviation.run(
        `pdl_${deviation.saveId}_${deviation.policyId}_${deviation.tick}_${deviation.revision}_${index}`,
        deviation.saveId,
        deviation.policyId,
        deviation.tick,
        deviation.revision,
        deviation.type,
        deviation.magnitude,
        deviation.realDeviation,
        deviation.discovered ? 1 : 0,
        now,
      );
    });
    const insertCost = this.database.prepare(
      `INSERT INTO policy_cost_applications (
         cost_id, save_id, policy_id, tick, revision, resource_id, mode,
         required, applied, before_value, after_value, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    artifacts.costApplications.forEach((entry) => {
      insertCost.run(
        `pca_${entry.saveId}_${entry.policyId}_${entry.tick}_${entry.revision}_${entry.resourceId}`,
        entry.saveId,
        entry.policyId,
        entry.tick,
        entry.revision,
        entry.resourceId,
        entry.mode,
        entry.required,
        entry.applied,
        entry.before,
        entry.after,
        now,
      );
    });
  }

  listCostApplications(saveId: string, policyId?: string): PolicyCostApplicationRecord[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM policy_cost_applications
         WHERE save_id = ? AND (? IS NULL OR policy_id = ?)
           AND ${currentTimelineRevisionPredicate("policy_cost_applications.save_id", "policy_cost_applications.revision")}
         ORDER BY tick, policy_id, resource_id`,
      )
      .all(saveId, policyId ?? null, policyId ?? null) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      saveId: String(row.save_id),
      policyId: String(row.policy_id),
      tick: Number(row.tick),
      revision: Number(row.revision),
      resourceId: String(row.resource_id) as PolicyCostApplicationRecord["resourceId"],
      mode: String(row.mode) as PolicyCostApplicationRecord["mode"],
      required: Number(row.required),
      applied: Number(row.applied),
      before: Number(row.before_value),
      after: Number(row.after_value),
    }));
  }

  /** 公开奏报（玩家 API）：audience=public，游标分页（tick 降序） */
  listReports(
    saveId: string,
    policyId: string,
    query: { audience?: "public" | "hidden"; limit?: number; cursor?: number } = {},
  ): { reports: PolicyReport[]; nextCursor: number | null } {
    const audience = query.audience ?? "public";
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
    const cursor = query.cursor ?? Number.MAX_SAFE_INTEGER;
    const rows = this.database
      .prepare(
        `SELECT * FROM policy_reports
         WHERE save_id = ? AND policy_id = ? AND audience = ? AND tick < ?
           AND ${currentTimelineRevisionPredicate("policy_reports.save_id", "policy_reports.revision")}
         ORDER BY tick DESC, report_id DESC LIMIT ?`,
      )
      .all(saveId, policyId, audience, cursor, limit + 1) as Array<Record<string, unknown>>;
    const page = rows.slice(0, limit);
    return {
      reports: page.map((row) => ({
        reportId: String(row.report_id),
        policyId: String(row.policy_id),
        saveId: String(row.save_id),
        tick: Number(row.tick),
        revision: Number(row.revision),
        stageIndex: Number(row.stage_index),
        reportedStageProgress: Number(row.reported_stage_progress),
        reportedOverallProgress: Number(row.reported_overall_progress),
        audience: String(row.audience) as PolicyReport["audience"],
        text: String(row.text),
        createdAt: String(row.created_at),
      })),
      nextCursor: rows.length > limit ? Number(page.at(-1)?.tick) : null,
    };
  }

  listStageResults(saveId: string, policyId: string, limit = 50): PolicyStageResultRecord[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM policy_stage_results
         WHERE save_id = ? AND policy_id = ?
           AND ${currentTimelineRevisionPredicate(
             "policy_stage_results.save_id",
             "policy_stage_results.revision",
           )}
         ORDER BY tick DESC, revision DESC LIMIT ?`,
      )
      .all(saveId, policyId, Math.min(limit, 200)) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      policyId: String(row.policy_id),
      saveId: String(row.save_id),
      tick: Number(row.tick),
      revision: Number(row.revision),
      stageIndex: Number(row.stage_index),
      fundingRatio: Number(row.funding_ratio),
      breakdown: JSON.parse(String(row.breakdown_json)),
      realDelta: Number(row.real_delta),
      reportedDelta: Number(row.reported_delta),
      ruleTrace: JSON.parse(String(row.rule_trace_json)),
      notes: JSON.parse(String(row.notes_json)),
    }));
  }

  listDeviations(saveId: string, policyId: string): PolicyDeviationLogRecord[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM policy_deviation_log
         WHERE save_id = ? AND policy_id = ?
           AND ${currentTimelineRevisionPredicate(
             "policy_deviation_log.save_id",
             "policy_deviation_log.revision",
           )}
         ORDER BY tick ASC, revision ASC`,
      )
      .all(saveId, policyId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      policyId: String(row.policy_id),
      saveId: String(row.save_id),
      tick: Number(row.tick),
      revision: Number(row.revision),
      type: String(row.deviation_type) as PolicyDeviationLogRecord["type"],
      magnitude: Number(row.magnitude),
      realDeviation: String(row.real_deviation),
      discovered: Number(row.discovered) === 1,
    }));
  }
}
