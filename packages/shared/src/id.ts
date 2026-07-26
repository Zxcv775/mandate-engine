/** 实体 ID：带前缀的 UUID，便于日志与调试中辨识实体类型 */
export type EntityId = string;

export function newId(prefix: string): EntityId {
  return `${prefix}_${crypto.randomUUID()}`;
}
