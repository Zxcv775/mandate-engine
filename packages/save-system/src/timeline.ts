import type { DatabaseSync } from "node:sqlite";

/**
 * 当前时间线判定：一次逻辑回滚会使 (targetRevision, resultRevision) 之间的旧记录失效；
 * 回滚结果 revision 之后产生的新记录仍属于当前分支。多次回滚时逐事件叠加判定。
 */
export function currentTimelineRevisionPredicate(
  saveIdExpression: string,
  revisionExpression: string,
): string {
  return `NOT EXISTS (
    SELECT 1 FROM save_rollback_events timeline_event
    WHERE timeline_event.save_id = ${saveIdExpression}
      AND timeline_event.result_revision > ${revisionExpression}
      AND timeline_event.target_revision < ${revisionExpression}
  )`;
}

export function recordRollbackTimeline(
  database: DatabaseSync,
  input: {
    saveId: string;
    targetRevision: number;
    resultRevision: number;
    createdAt: string;
  },
): void {
  database
    .prepare(
      `INSERT INTO save_rollback_events (
         event_id, save_id, target_revision, result_revision, created_at
       ) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      `rollback_${input.saveId}_${input.resultRevision}`,
      input.saveId,
      input.targetRevision,
      input.resultRevision,
      input.createdAt,
    );
}
