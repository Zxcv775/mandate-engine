/**
 * mulberry32 确定性伪随机数生成器。
 *
 * 红线：项目内一切随机判定必须使用本类（CONTRIBUTING 红线 6），
 * 禁止 Math.random()，以保证固定种子可复现（FR-RULE-001）。
 */
export class SeededRng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** 返回 [0, 1) 区间的浮点数 */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** 返回 [minInclusive, maxInclusive] 区间整数 */
  nextInt(minInclusive: number, maxInclusive: number): number {
    return minInclusive + Math.floor(this.next() * (maxInclusive - minInclusive + 1));
  }

  /** 以 probability 概率返回 true */
  chance(probability: number): boolean {
    return this.next() < probability;
  }

  /** 从数组中等概率选取一个元素 */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) {
      throw new Error("SeededRng.pick: 数组为空");
    }
    return items[Math.floor(this.next() * items.length)] as T;
  }
}

/**
 * FNV-1a 32 位字符串散列：用于从标识串派生确定性 RNG 种子
 * （会议调度 tie-break、政策结算派生随机流等）。
 */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
