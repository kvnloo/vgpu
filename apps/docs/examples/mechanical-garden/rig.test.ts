import { quat, vec3, type Quat, type Vec3 } from "math";
import { describe, expect, it, vi } from "vitest";

import { createColony, MAX_ROBOTS, step } from "./colony";
import { COXA, FEMUR, restFoot, solveLeg, SOLVE_THRESHOLD, TIBIA } from "./leg";
import { createRobot, LEG_COUNT, LEG_SPECS, toBody, type Robot } from "./robot";
import { createRig, PART_MESHES, PER_ROBOT, poseRig, publishRig, rowOf, rowPosition, type Rig } from "./rig";

/** Independent float64 body transform: world = p + q·local. */
function bodyToWorld(out: Vec3, position: Vec3, rotation: Quat, local: Vec3): Vec3 {
  vec3.transformQuat(out, local, rotation);
  return vec3.add(out, out, position);
}

function localColumn(rig: Rig, row: number, column: number): number[] {
  return Array.from(rig.locals.subarray(row * 16 + column * 4, row * 16 + column * 4 + 3));
}

/** A robot posed at an arbitrary rotated, translated body with every foot solved onto `feet`. */
function posedRobot(position: Vec3, rotation: Quat, feet: Vec3[]): Robot {
  const robot = createRobot(0);
  robot.active = true;
  vec3.copy(robot.position, position);
  quat.copy(robot.rotation, rotation);
  for (let leg = 0; leg < LEG_COUNT; leg++) {
    toBody(robot.targets[leg]!, robot, feet[leg]!);
    solveLeg(robot.legs[leg]!, robot.targets[leg]!);
  }
  return robot;
}

describe("rig hierarchy", () => {
  // Body = T(p)·Ry(2π/3)·Rx(0.15), the numerical review's assertion 2.
  const position: Vec3 = [0.6, 0.45, -0.35];
  const yaw: Quat = quat.setAxisAngle([0, 0, 0, 1], [0, 1, 0], (2 * Math.PI) / 3);
  const pitch: Quat = quat.setAxisAngle([0, 0, 0, 1], [1, 0, 0], 0.15);
  const rotation: Quat = quat.multiply([0, 0, 0, 1], yaw, pitch);
  const feet: Vec3[] = LEG_SPECS.map((spec, leg) => {
    const local = restFoot([0, 0, 0], spec, 0.34 + leg * 0.012, 0.26 - leg * 0.01);
    return bodyToWorld([0, 0, 0], position, rotation, local);
  });

  it("puts every foot row on its desired world foot and keeps bones as pure child offsets", () => {
    const robot = posedRobot(position, rotation, feet);
    const rig = createRig(1);
    poseRig(rig, [robot], 1);
    const world: Vec3 = [0, 0, 0];
    for (let leg = 0; leg < LEG_COUNT; leg++) {
      rowPosition(world, rig, rowOf(rig, "foot", 0, leg));
      expect(vec3.distance(world, feet[leg]!)).toBeLessThan(SOLVE_THRESHOLD + 1e-5);
      // Child translations are exactly the parent bone along its +Y.
      const translations: [string, number][] = [["femur", COXA], ["tibia", FEMUR], ["foot", TIBIA]];
      for (const [mesh, length] of translations) {
        const t = localColumn(rig, rowOf(rig, mesh as "femur", 0, leg), 3);
        expect(Math.abs(t[0]!) + Math.abs(t[1]! - length) + Math.abs(t[2]!)).toBeLessThan(1e-6);
      }
      // Femur and tibia locals are pure hinges about their parent's X (the leg-plane normal).
      for (const mesh of ["femur", "tibia"] as const) {
        const x = localColumn(rig, rowOf(rig, mesh, 0, leg), 0);
        expect(Math.abs(x[0]! - 1) + Math.abs(x[1]!) + Math.abs(x[2]!)).toBeLessThan(1e-6);
      }
    }
    // The coxa hangs off the shell at the hip: the body root is applied once, not twice.
    rowPosition(world, rig, rowOf(rig, "coxa", 0, 0));
    expect(vec3.distance(world, bodyToWorld([0, 0, 0], position, rotation, LEG_SPECS[0]!.hip))).toBeLessThan(1e-5);
  });

  it("keeps world feet fixed when the body yaws, with body-local targets rotated by −Δψ", () => {
    const before = posedRobot(position, rotation, feet);
    const turned: Quat = quat.multiply([0, 0, 0, 1], quat.setAxisAngle([0, 0, 0, 1], [0, 1, 0], 0.4), rotation);
    const after = posedRobot(position, turned, feet);
    const rig = createRig(2);
    poseRig(rig, [before, after], 2);
    const back: Quat = quat.setAxisAngle([0, 0, 0, 1], [0, 1, 0], -0.4);
    const a: Vec3 = [0, 0, 0];
    const b: Vec3 = [0, 0, 0];
    for (let leg = 0; leg < LEG_COUNT; leg++) {
      rowPosition(a, rig, rowOf(rig, "foot", 0, leg));
      rowPosition(b, rig, rowOf(rig, "foot", 1, leg));
      expect(Math.hypot(a[0] - b[0], a[2] - b[2])).toBeLessThan(2 * SOLVE_THRESHOLD + 1e-5);
      expect(vec3.distance(b, feet[leg]!)).toBeLessThan(SOLVE_THRESHOLD + 1e-5);
      // Body-local target after the yaw = Ry(−Δψ)·target before, in the body's own frame: compare
      // through the pitch, which the yaw is applied outside of.
      const expected = vec3.transformQuat([0, 0, 0], feet[leg]!.map((v, k) => v - position[k]!) as Vec3, quat.invert([0, 0, 0, 1], turned));
      expect(vec3.distance(after.targets[leg]!, expected)).toBeLessThan(1e-12);
      const viaBefore = vec3.transformQuat([0, 0, 0], before.targets[leg]!, rotation);
      vec3.transformQuat(viaBefore, viaBefore, back);
      vec3.transformQuat(viaBefore, viaBefore, quat.invert([0, 0, 0, 1], rotation));
      expect(vec3.distance(after.targets[leg]!, viaBefore)).toBeLessThan(1e-12);
    }
  });

  it("matches the simulation's world feet across a walking, turning colony", () => {
    const colony = createColony({ seed: 7, count: 12 });
    const rig = createRig(MAX_ROBOTS);
    const expected: Vec3 = [0, 0, 0];
    const actual: Vec3 = [0, 0, 0];
    let worst = 0;
    for (let k = 0; k < 240; k++) {
      step(colony);
      if (k % 20 !== 19) continue;
      poseRig(rig, colony.robots, colony.count);
      for (let index = 0; index < colony.count; index++) {
        const robot = colony.robots[index]!;
        for (let leg = 0; leg < LEG_COUNT; leg++) {
          bodyToWorld(expected, robot.position, robot.rotation, robot.legs[leg]!.foot);
          rowPosition(actual, rig, rowOf(rig, "foot", index, leg));
          worst = Math.max(worst, vec3.distance(expected, actual) / Math.max(1, vec3.length(expected)));
          bodyToWorld(expected, robot.position, robot.rotation, robot.legs[leg]!.knee);
          rowPosition(actual, rig, rowOf(rig, "tibia", index, leg));
          worst = Math.max(worst, vec3.distance(expected, actual) / Math.max(1, vec3.length(expected)));
        }
      }
    }
    expect(worst).toBeLessThan(1e-5);
    expect(rig.skipped).toBe(0);
  });
});

describe("rig publication", () => {
  it("grows and releases tail handles without moving earlier slots", () => {
    const colony = createColony({ seed: 2, count: 5 });
    const rig = createRig(MAX_ROBOTS);
    poseRig(rig, colony.robots, 5);
    publishRig(rig, colony.robots, 5);
    for (const mesh of PART_MESHES) expect(rig.collections[mesh].count).toBe(5 * PER_ROBOT[mesh]);
    const kept = rig.ids.femur.slice(0, 12);
    publishRig(rig, colony.robots, 2);
    expect(rig.collections.femur.count).toBe(12);
    expect(rig.ids.femur).toEqual(kept);
    kept.forEach((id, slot) => expect(rig.collections.femur.slotOf(id)).toBe(slot));
    publishRig(rig, colony.robots, MAX_ROBOTS);
    expect(rig.collections.foot.count).toBe(MAX_ROBOTS * 6);
    expect(rig.collections.femur.slotOf(kept[11]!)).toBe(11);
  });

  it("rewrites part styles only when a robot's palette or blink changes", () => {
    const colony = createColony({ seed: 2, count: 2 });
    const rig = createRig(2);
    colony.robots[0]!.blink = -0.05;
    publishRig(rig, colony.robots, 2);
    const set = vi.spyOn(rig.collections.shell, "set");
    publishRig(rig, colony.robots, 2);
    expect(set).not.toHaveBeenCalled();
    colony.robots[0]!.blink = 1;
    publishRig(rig, colony.robots, 2);
    expect(set).toHaveBeenCalledTimes(PER_ROBOT.shell);
  });

  it("keeps the previous pose when a robot's state is non-finite instead of throwing", () => {
    const colony = createColony({ seed: 2, count: 2 });
    const rig = createRig(2);
    poseRig(rig, colony.robots, 2);
    const shell = Array.from(rig.worlds.subarray(0, 16));
    colony.robots[0]!.position[0] = Number.NaN;
    poseRig(rig, colony.robots, 2);
    expect(rig.skipped).toBe(1);
    expect(Array.from(rig.worlds.subarray(0, 16))).toEqual(shell);
    expect(() => publishRig(rig, colony.robots, 2)).not.toThrow();
  });
});
