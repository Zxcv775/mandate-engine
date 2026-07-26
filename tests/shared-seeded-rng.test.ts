import { describe, expect, it } from "vitest";
import { SeededRng } from "@mandate/shared";

describe("SeededRng（FR-RULE-001 随机可复现）", () => {
  it("相同种子产生完全相同的序列", () => {
    const a = new SeededRng(42);
    const b = new SeededRng(42);
    const seqA = Array.from({ length: 10 }, () => a.next());
    const seqB = Array.from({ length: 10 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it("不同种子产生不同序列", () => {
    const a = new SeededRng(1);
    const b = new SeededRng(2);
    const seqA = Array.from({ length: 10 }, () => a.next());
    const seqB = Array.from({ length: 10 }, () => b.next());
    expect(seqA).not.toEqual(seqB);
  });

  it("nextInt 落在闭区间内", () => {
    const rng = new SeededRng(7);
    for (let i = 0; i < 100; i++) {
      const v = rng.nextInt(1, 6);
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(6);
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it("pick 对空数组抛错", () => {
    const rng = new SeededRng(1);
    expect(() => rng.pick([])).toThrow();
  });
});
