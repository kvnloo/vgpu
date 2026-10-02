// The robots as one packed transform hierarchy, plus the instance collections that publish it.
// Rows are grouped by mesh (all shells, all heads, all antennae, then every coxa, femur, tibia
// and foot), so each mesh's rows form one contiguous run for setWorlds. Within a mesh, rows are
// robot-major. Only the shell row carries the body transform; every other local is relative to
// its parent, so the body root is applied exactly once.
//
// Data flow per rendered frame: simulation state → locals (poseRig) → evaluateHierarchy → worlds →
// setWorlds (publishRig) → the GPU bridges publish.

import { mat4, quat, vec3, type Mat4, type Quat, type Vec3 } from "math";
import { evaluateHierarchy, hierarchyOrder, instances, type HierarchyOrder, type InstanceCollection, type InstanceId } from "vgpu/scene";

import { COXA, FEMUR, legRotations, TIBIA } from "./leg";
import { LEG_COUNT, type Robot } from "./robot";

export const PART_MESHES = ["shell", "head", "antenna", "coxa", "femur", "tibia", "foot"] as const;
export type PartMesh = (typeof PART_MESHES)[number];
/** Rows (and instances) of each mesh per robot. */
export const PER_ROBOT: Readonly<Record<PartMesh, number>> = { shell: 1, head: 1, antenna: 2, coxa: 6, femur: 6, tibia: 6, foot: 6 };
export const ROWS_PER_ROBOT = PART_MESHES.reduce((sum, mesh) => sum + PER_ROBOT[mesh], 0);

/** Head pivot in body space, and the antenna roots in head space (±x). */
export const HEAD_OFFSET: Vec3 = [0, 0.035, 0.27];
export const ANTENNA_OFFSET: Vec3 = [0.055, 0.075, 0.02];

/** Per-instance style: x palette (0–2), y glow (eyes), z part variant, w unused. */
export const PART_ATTRIBUTES = { style: { format: "float32x4", default: [0, 1, 0, 0] } } as const;
export type PartCollection = InstanceCollection<typeof PART_ATTRIBUTES>;

export interface Rig {
  readonly capacity: number;
  readonly order: HierarchyOrder;
  readonly parents: Int32Array;
  readonly locals: Float32Array;
  readonly worlds: Float32Array;
  /** First row of each mesh's run. */
  readonly base: Readonly<Record<PartMesh, number>>;
  readonly collections: Readonly<Record<PartMesh, PartCollection>>;
  /** Live instance handles per mesh, in slot order (robot-major). */
  readonly ids: Readonly<Record<PartMesh, InstanceId[]>>;
  /** Robots currently published. */
  count: number;
  /** Robot poses skipped because a local came out non-finite (the previous pose stays). */
  skipped: number;
  /** Last style written per robot: palette and glow. */
  readonly styles: Float32Array;
}

export function rowOf(rig: Rig, mesh: PartMesh, robot: number, part = 0): number {
  return rig.base[mesh] + robot * PER_ROBOT[mesh] + part;
}

export function createRig(capacity: number): Rig {
  const base = {} as Record<PartMesh, number>;
  let next = 0;
  for (const mesh of PART_MESHES) {
    base[mesh] = next;
    next += capacity * PER_ROBOT[mesh];
  }
  const rows = next;
  const parents = new Int32Array(rows);
  const row = (mesh: PartMesh, robot: number, part = 0) => base[mesh] + robot * PER_ROBOT[mesh] + part;
  for (let robot = 0; robot < capacity; robot++) {
    parents[row("shell", robot)] = -1;
    parents[row("head", robot)] = row("shell", robot);
    for (let side = 0; side < 2; side++) parents[row("antenna", robot, side)] = row("head", robot);
    for (let leg = 0; leg < LEG_COUNT; leg++) {
      parents[row("coxa", robot, leg)] = row("shell", robot);
      parents[row("femur", robot, leg)] = row("coxa", robot, leg);
      parents[row("tibia", robot, leg)] = row("femur", robot, leg);
      parents[row("foot", robot, leg)] = row("tibia", robot, leg);
    }
  }
  const locals = new Float32Array(rows * 16);
  for (let r = 0; r < rows; r++) locals.set(IDENTITY, r * 16);
  const collections = {} as Record<PartMesh, PartCollection>;
  const ids = {} as Record<PartMesh, InstanceId[]>;
  for (const mesh of PART_MESHES) {
    collections[mesh] = instances({ capacity: capacity * PER_ROBOT[mesh], attributes: PART_ATTRIBUTES });
    ids[mesh] = [];
  }
  const rig: Rig = {
    capacity,
    order: hierarchyOrder(parents),
    parents,
    locals,
    worlds: new Float32Array(rows * 16),
    base,
    collections,
    ids,
    count: 0,
    skipped: 0,
    styles: new Float32Array(capacity * 2).fill(-1),
  };
  evaluateHierarchy({ order: rig.order, parents, locals, worlds: rig.worlds });
  return rig;
}

const IDENTITY: Mat4 = mat4.create();
const IDENTITY_QUAT: Quat = [0, 0, 0, 1];
const staging = new Float32Array(ROWS_PER_ROBOT * 16);
const scratch: Mat4 = mat4.create();
const qCoxa: Quat = [0, 0, 0, 1];
const qFemur: Quat = [0, 0, 0, 1];
const qTibia: Quat = [0, 0, 0, 1];
const qInverse: Quat = [0, 0, 0, 1];
const qRelative: Quat = [0, 0, 0, 1];
const qLook: Quat = [0, 0, 0, 1];
const qAntenna: Quat = [0, 0, 0, 1];
const qTilt: Quat = [0, 0, 0, 1];
const offset: Vec3 = [0, 0, 0];
const X: Vec3 = [1, 0, 0];
const Y: Vec3 = [0, 1, 0];
const Z: Vec3 = [0, 0, 1];
const ROW_OFFSETS = (() => {
  // Staging slot of each part within one robot.
  const offsets = {} as Record<PartMesh, number>;
  let next = 0;
  for (const mesh of PART_MESHES) {
    offsets[mesh] = next;
    next += PER_ROBOT[mesh];
  }
  return offsets;
})();

function stage(slot: number, rotation: Quat, translation: Vec3): void {
  mat4.fromRotationTranslation(scratch, rotation, translation);
  staging.set(scratch, slot * 16);
}

/** Locals of one robot into the staging block; false when any value is non-finite. */
function stageRobot(robot: Robot): boolean {
  stage(ROW_OFFSETS.shell, robot.rotation, robot.position);
  quat.setAxisAngle(qLook, Y, robot.look.value);
  stage(ROW_OFFSETS.head, qLook, HEAD_OFFSET);
  for (let side = 0; side < 2; side++) {
    const sign = side === 0 ? 1 : -1;
    // Forward/back lag about X, sideways lag about Z, splayed a little outward.
    quat.setAxisAngle(qAntenna, X, robot.antennaZ.value);
    quat.setAxisAngle(qTilt, Z, -robot.antennaX.value - sign * 0.32);
    quat.multiply(qAntenna, qAntenna, qTilt);
    vec3.set(offset, ANTENNA_OFFSET[0] * sign, ANTENNA_OFFSET[1], ANTENNA_OFFSET[2]);
    stage(ROW_OFFSETS.antenna + side, qAntenna, offset);
  }
  for (let leg = 0; leg < LEG_COUNT; leg++) {
    const l = robot.legs[leg]!;
    legRotations(l, qCoxa, qFemur, qTibia);
    stage(ROW_OFFSETS.coxa + leg, qCoxa, l.spec.hip);
    quat.multiply(qRelative, quat.invert(qInverse, qCoxa), qFemur);
    vec3.set(offset, 0, COXA, 0);
    stage(ROW_OFFSETS.femur + leg, qRelative, offset);
    quat.multiply(qRelative, quat.invert(qInverse, qFemur), qTibia);
    vec3.set(offset, 0, FEMUR, 0);
    stage(ROW_OFFSETS.tibia + leg, qRelative, offset);
    vec3.set(offset, 0, TIBIA, 0);
    stage(ROW_OFFSETS.foot + leg, IDENTITY_QUAT, offset);
  }
  for (let k = 0; k < staging.length; k++) if (!Number.isFinite(staging[k]!)) return false;
  return true;
}

/** Write the locals of the first `count` robots and evaluate the hierarchy. */
export function poseRig(rig: Rig, robots: readonly Robot[], count: number): void {
  for (let index = 0; index < count; index++) {
    if (!stageRobot(robots[index]!)) {
      rig.skipped++;
      continue;
    }
    for (const mesh of PART_MESHES) {
      for (let part = 0; part < PER_ROBOT[mesh]; part++) {
        const from = (ROW_OFFSETS[mesh] + part) * 16;
        rig.locals.set(staging.subarray(from, from + 16), rowOf(rig, mesh, index, part) * 16);
      }
    }
  }
  evaluateHierarchy({ order: rig.order, parents: rig.parents, locals: rig.locals, worlds: rig.worlds });
}

const style: [number, number, number, number] = [0, 1, 0, 0];

/**
 * Match the instance populations to `count` robots (adding or releasing tail handles, so earlier
 * slots never move), refresh styles that changed, and copy the posed worlds into the collections.
 */
/** Eye glow while blinking, rounded like the float32 style cache so an unchanged blink compares equal. */
const BLINK_GLOW = Math.fround(0.08);

export function publishRig(rig: Rig, robots: readonly Robot[], count: number): void {
  for (const mesh of PART_MESHES) {
    const collection = rig.collections[mesh];
    const ids = rig.ids[mesh];
    const wanted = count * PER_ROBOT[mesh];
    while (ids.length > wanted) collection.remove(ids.pop()!);
    while (ids.length < wanted) {
      const part = ids.length % PER_ROBOT[mesh];
      style[2] = part;
      ids.push(collection.add({ style }));
    }
  }
  if (count < rig.count) rig.styles.fill(-1, count * 2);
  rig.count = count;
  for (let index = 0; index < count; index++) {
    const robot = robots[index]!;
    const glow = robot.blink < 0 ? BLINK_GLOW : 1;
    if (rig.styles[index * 2] === robot.palette && rig.styles[index * 2 + 1] === glow) continue;
    rig.styles[index * 2] = robot.palette;
    rig.styles[index * 2 + 1] = glow;
    style[0] = robot.palette;
    style[1] = glow;
    for (const mesh of PART_MESHES) {
      for (let part = 0; part < PER_ROBOT[mesh]; part++) {
        style[2] = part;
        rig.collections[mesh].set(rig.ids[mesh][index * PER_ROBOT[mesh] + part]!, { style });
      }
    }
  }
  for (const mesh of PART_MESHES) {
    if (rig.ids[mesh].length > 0) rig.collections[mesh].setWorlds(rig.ids[mesh], rig.worlds, rig.base[mesh]);
  }
}

/** World translation of a row (float32 storage). */
export function rowPosition(out: Vec3, rig: Rig, row: number): Vec3 {
  out[0] = rig.worlds[row * 16 + 12]!;
  out[1] = rig.worlds[row * 16 + 13]!;
  out[2] = rig.worlds[row * 16 + 14]!;
  return out;
}
