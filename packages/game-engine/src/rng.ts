export interface RandomSource {
  nextFloat(): number;
  nextInt(minInclusive: number, maxInclusive: number): number;
  pick<T>(items: readonly T[]): T;
  getCursor(): number;
}

const STEP = 0x6d2b79f5;
const MAX_CURSOR = 0xffff_ffff;

function seedToUint32(seed: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

class DeterministicRandomSource implements RandomSource {
  private state: number;

  constructor(
    seed: string,
    private cursor: number,
  ) {
    if (!seed) throw new Error("RNG seed 不能为空");
    if (!Number.isInteger(cursor) || cursor < 0 || cursor > MAX_CURSOR) {
      throw new Error("RNG cursor 必须是 0..2^32-1 的整数");
    }
    this.state = (seedToUint32(seed) + Math.imul(cursor, STEP)) >>> 0;
  }

  nextFloat(): number {
    if (this.cursor >= MAX_CURSOR) throw new Error("RNG cursor 已耗尽");
    this.state = (this.state + STEP) >>> 0;
    let value = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    this.cursor += 1;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  }

  nextInt(minInclusive: number, maxInclusive: number): number {
    if (
      !Number.isSafeInteger(minInclusive) ||
      !Number.isSafeInteger(maxInclusive) ||
      minInclusive > maxInclusive
    ) {
      throw new Error("RNG 整数范围无效");
    }
    return minInclusive + Math.floor(this.nextFloat() * (maxInclusive - minInclusive + 1));
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("RNG 无法从空集合选取");
    return items[this.nextInt(0, items.length - 1)] as T;
  }

  getCursor(): number {
    return this.cursor;
  }
}

export function createDeterministicRandomSource(seed: string, cursor = 0): RandomSource {
  return new DeterministicRandomSource(seed, cursor);
}
