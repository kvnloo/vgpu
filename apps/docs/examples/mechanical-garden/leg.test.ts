import { mulberry32 } from "math/random";
import { describe, expect, it } from "vitest";

import {
  COXA,
  createLeg,
  FEMUR,
  kneeSide,
  legRotations,
  REACH_MAX,
  REACH_MIN,
  resetLeg,
  SOLVE_THRESHOLD,
  solveLeg,
  TIBIA,
  type LegSpec,
} from "./leg";

type V = [number, number, number];
const sub = (a: readonly number[], b: readonly number[]): V => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
const dot = (a: readonly number[], b: readonly number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const len = (a: readonly number[]) => Math.sqrt(dot(a, a));
const cross = (a: readonly number[], b: readonly number[]): V => [
  a[1]! * b[2]! - a[2]! * b[1]!,
  a[2]! * b[0]! - a[0]! * b[2]!,
  a[0]! * b[1]! - a[1]! * b[0]!,
];

// A right-side middle leg: hip at +X, coxa pointing straight out (+X), hinge axis = +X × +Y = +Z.
const RIGHT: LegSpec = { hip: [0.24, 0, 0], restYaw: Math.PI / 2 };
const femurBase: V = [0.24 + COXA, 0, 0];
const hinge: V = [0, 0, 1];

/** A target in the leg plane at distance d from the femur base, at elevation `angle` below +X. */
function planeTarget(d: number, angle: number): V {
  return [femurBase[0] + d * Math.cos(angle), -d * Math.sin(angle), 0];
}

describe("two-bone leg against the closed form", () => {
  const a = FEMUR;
  const b = TIBIA;
  const eps = 1e-3;
  for (const d of [Math.abs(a - b) + 2 * eps + 0.05, (a + b) / 2, 0.95 * (a + b)]) {
    it(`reaches an in-plane target at d = ${d.toFixed(3)} with the knee up`, () => {
      const leg = createLeg(RIGHT);
      const target = planeTarget(d, 1.0);
      const error = solveLeg(leg, target);
      expect(error).toBeLessThanOrEqual(SOLVE_THRESHOLD);
      expect(len(sub(leg.foot, target))).toBeLessThanOrEqual(SOLVE_THRESHOLD + 1e-12);
      // Bone lengths are preserved exactly.
      expect(len(sub(leg.knee, leg.femurBase))).toBeCloseTo(a, 9);
      expect(len(sub(leg.foot, leg.knee))).toBeCloseTo(b, 9);
      // Knee stays in the hinge plane (z = 0 here) and on the up side.
      expect(Math.abs(dot(sub(leg.knee, femurBase), hinge))).toBeLessThan(1e-9);
      expect(dot(cross(sub(leg.knee, femurBase), sub(leg.foot, leg.knee)), hinge)).toBeLessThan(0);
      // Interior knee angle matches the law of cosines.
      const expected = Math.acos((a * a + b * b - d * d) / (2 * a * b));
      const femur = sub(femurBase, leg.knee);
      const tibia = sub(leg.foot, leg.knee);
      const interior = Math.acos(dot(femur, tibia) / (len(femur) * len(tibia)));
      // A distance error δ along the reach moves the angle by δ·d/(a·b·sin θ); allow the threshold.
      const sensitivity = Math.max(1 / Math.min(a, b), d / (a * b * Math.sin(expected)));
      expect(Math.abs(interior - expected)).toBeLessThanOrEqual(SOLVE_THRESHOLD * sensitivity + 1e-9);
    });
  }

  it("clamps an out-of-reach target to 0.96·(a+b) along the same direction, with finite results", () => {
    const leg = createLeg(RIGHT);
    const far = planeTarget(1.5 * (a + b), 0.6);
    solveLeg(leg, far);
    const expected: V = [femurBase[0] + REACH_MAX * Math.cos(0.6), -REACH_MAX * Math.sin(0.6), 0];
    expect(len(sub(leg.goal, expected))).toBeLessThan(1e-12);
    expect(len(sub(leg.foot, expected))).toBeLessThanOrEqual(SOLVE_THRESHOLD);
    expect(len(sub(leg.knee, leg.femurBase))).toBeCloseTo(a, 9);
    expect(len(sub(leg.foot, leg.knee))).toBeCloseTo(b, 9);
    expect(kneeSide(leg)).toBeLessThan(0);
  });

  it("pushes a target inside the inner radius out to the inner band", () => {
    const leg = createLeg(RIGHT);
    const near = planeTarget(0.2 * Math.abs(a - b), 1.2);
    solveLeg(leg, near);
    expect(len(sub(leg.goal, femurBase))).toBeCloseTo(REACH_MIN, 12);
    expect([...leg.knee, ...leg.foot].every(Number.isFinite)).toBe(true);
    expect(len(sub(leg.knee, leg.femurBase))).toBeCloseTo(a, 9);
    expect(len(sub(leg.foot, leg.knee))).toBeCloseTo(b, 9);
  });

  it("rejects NaN targets and keeps the previous pose", () => {
    const leg = createLeg(RIGHT);
    solveLeg(leg, planeTarget(0.5, 1));
    const knee = [...leg.knee];
    const foot = [...leg.foot];
    expect(solveLeg(leg, [Number.NaN, 0, 0])).toBe(Infinity);
    expect(solveLeg(leg, [0, Number.POSITIVE_INFINITY, 0])).toBe(Infinity);
    expect([...leg.knee]).toEqual(knee);
    expect([...leg.foot]).toEqual(foot);
    expect(leg.rejected).toBe(2);
  });

  it("keeps exact bone lengths through re-laid and rejected solves of arbitrary targets", () => {
    // Externally imposed targets (behind the hip, under the body, out of reach) exercise the
    // wrong-knee re-lay and the rejection path that ordinary walking no longer reaches.
    const leg = createLeg(RIGHT);
    const random = mulberry32.create(5);
    const sample = () => mulberry32.sample(random);
    let worst = 0;
    for (let k = 0; k < 2000; k++) {
      solveLeg(leg, [(sample() * 2 - 1) * 1.2, -0.6 + sample() * 0.9, (sample() * 2 - 1) * 1.2]);
      worst = Math.max(
        worst,
        Math.abs(len(sub(leg.femurBase, RIGHT.hip)) - COXA),
        Math.abs(len(sub(leg.knee, leg.femurBase)) - FEMUR),
        Math.abs(len(sub(leg.foot, leg.knee)) - TIBIA),
      );
    }
    expect(leg.relaid).toBeGreaterThan(0);
    expect(leg.rejected).toBeGreaterThan(0);
    expect(worst).toBeLessThan(1e-9);
  });

  it("yaws the coxa toward off-axis targets within its limit and keeps the knee in the new plane", () => {
    const leg = createLeg(RIGHT);
    const target: V = [0.24 + 0.5 * Math.sin(Math.PI / 2 - 0.5), -0.3, 0.5 * Math.cos(Math.PI / 2 - 0.5)];
    const error = solveLeg(leg, target);
    expect(error).toBeLessThanOrEqual(SOLVE_THRESHOLD);
    expect(leg.yaw).toBeCloseTo(Math.PI / 2 - 0.5, 12);
    expect(Math.abs(dot(sub(leg.knee, leg.femurBase), leg.axis))).toBeLessThan(1e-9);
    expect(kneeSide(leg)).toBeLessThan(0);
  });

  it("is deterministic after reset regardless of history", () => {
    const leg = createLeg(RIGHT);
    const probe = planeTarget(0.55, 0.9);
    solveLeg(leg, probe);
    const fresh = [...leg.knee];
    for (let k = 0; k < 40; k++) solveLeg(leg, planeTarget(0.3 + (k % 7) * 0.07, -0.4 + k * 0.05));
    resetLeg(leg);
    solveLeg(leg, probe);
    expect([...leg.knee]).toEqual(fresh);
  });

  it("builds segment frames whose X axis is the hinge and Y follows each bone", () => {
    const leg = createLeg(RIGHT);
    solveLeg(leg, planeTarget(0.6, 0.8));
    const q = { coxa: [0, 0, 0, 1], femur: [0, 0, 0, 1], tibia: [0, 0, 0, 1] } as Record<string, [number, number, number, number]>;
    legRotations(leg, q.coxa!, q.femur!, q.tibia!);
    const rotate = (r: readonly number[], v: readonly number[]): V => {
      const [x, y, z, w] = r as [number, number, number, number];
      const u: V = [x, y, z];
      const t = cross(u, v).map((c) => 2 * c) as V;
      const c2 = cross(u, t);
      return [v[0]! + w * t[0] + c2[0], v[1]! + w * t[1] + c2[1], v[2]! + w * t[2] + c2[2]];
    };
    const femurDir = sub(leg.knee, leg.femurBase).map((c) => c / FEMUR);
    const tibiaDir = sub(leg.foot, leg.knee).map((c) => c / TIBIA);
    for (const [rotation, dir] of [
      [q.femur!, femurDir],
      [q.tibia!, tibiaDir],
    ] as const) {
      const x = rotate(rotation, [1, 0, 0]);
      const y = rotate(rotation, [0, 1, 0]);
      expect(len(sub(x, leg.axis))).toBeLessThan(1e-12);
      expect(len(sub(y, dir))).toBeLessThan(1e-9);
    }
  });
});
