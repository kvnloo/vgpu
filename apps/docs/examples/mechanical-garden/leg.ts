// One robot leg in body-local space (+X right, +Y up, +Z forward): an analytic coxa yaw about the
// body's up axis, then femur + tibia as a two-bone math/ik fabrik3 chain hinged about the leg-plane
// normal. The app clamps every target into the reachable band itself, because fabrik3's
// isReachable only checks the outer radius, and it checks the knee side after each solve.
// Segment frames are built from the hinge axis (X = hinge, Y = bone, Z = X × Y), so every child
// joint is a pure rotation about its local X.

import { clamp, deltaAngle, mat3, quat, vec3, type Mat3, type Quat, type Vec3 } from "math";
import { fabrik3 } from "math/ik";

export const COXA = 0.15;
export const FEMUR = 0.34;
export const TIBIA = 0.44;
/** Shortest and longest knee-to-foot distance the app asks for. */
export const REACH_MARGIN = 0.05;
export const REACH_MIN = Math.abs(FEMUR - TIBIA) + REACH_MARGIN;
export const REACH_MAX = 0.96 * (FEMUR + TIBIA);
/** How far the coxa may yaw away from its rest direction. */
export const YAW_LIMIT = (58 * Math.PI) / 180;
/** fabrik3 stops at 0.01 by default; legs need it two orders of magnitude tighter. */
export const SOLVE_THRESHOLD = 1e-4 * (FEMUR + TIBIA);

const UP: Vec3 = [0, 1, 0];
const DOWN: Vec3 = [0, -1, 0];
const FEMUR_UP = (88 * Math.PI) / 180;
const FEMUR_DOWN = (70 * Math.PI) / 180;
/** Tibia limits around straight down: outward (anticlockwise) and inward (clockwise). */
const TIBIA_OUT = (80 * Math.PI) / 180;
const TIBIA_IN = (65 * Math.PI) / 180;
/** Deterministic bent rest pose in leg-plane coordinates (s outward, y up) from the femur base. */
const REST_KNEE_ANGLE = (52 * Math.PI) / 180;
const REST_KNEE: readonly [number, number] = [FEMUR * Math.cos(REST_KNEE_ANGLE), FEMUR * Math.sin(REST_KNEE_ANGLE)];

export interface LegSpec {
  /** Hip position in body space. */
  readonly hip: Vec3;
  /** Rest yaw of the coxa: the outward direction is (sin yaw, 0, cos yaw). */
  readonly restYaw: number;
}

export interface Leg {
  readonly spec: LegSpec;
  readonly chain: ReturnType<typeof fabrik3.createChain3>;
  /** Current coxa yaw. */
  yaw: number;
  /** Outward horizontal direction, hinge axis = dir × up. */
  readonly dir: Vec3;
  readonly axis: Vec3;
  /** Femur base (end of the coxa), knee and foot (effector), body space. */
  readonly femurBase: Vec3;
  readonly knee: Vec3;
  readonly foot: Vec3;
  /** The clamped, in-plane target the chain was asked to reach. */
  readonly goal: Vec3;
  /** Distance from the effector to `goal` after the last accepted solve. */
  error: number;
  /** Solves rejected (non-finite input or result) since the last reset. */
  rejected: number;
  /** Solves that came out on the wrong knee side and were re-laid from the rest pose. */
  relaid: number;
  /** Knee and foot in leg-plane coordinates, used to warm-start the next solve. */
  readonly plane: [number, number, number, number];
}

export function createLeg(spec: LegSpec): Leg {
  const chain = fabrik3.createChain3();
  chain.solveDistanceThreshold = SOLVE_THRESHOLD;
  chain.minIterationChange = SOLVE_THRESHOLD * 1e-2;
  chain.maxIterations = 80;
  // Laid along +Z with a bend; resetLeg() re-lays the real pose before any solve.
  fabrik3.addBone(chain, [0, 0, 0], [0, FEMUR * 0.6, FEMUR * 0.8], fabrik3.createJoint3());
  fabrik3.addBone(chain, [0, FEMUR * 0.6, FEMUR * 0.8], [0, FEMUR * 0.6 - TIBIA * 0.8, FEMUR * 0.8 + TIBIA * 0.6], fabrik3.createJoint3());
  const leg: Leg = {
    spec,
    chain,
    yaw: spec.restYaw,
    dir: [0, 0, 1],
    axis: [1, 0, 0],
    femurBase: [0, 0, 0],
    knee: [0, 0, 0],
    foot: [0, 0, 0],
    goal: [0, 0, 0],
    error: 0,
    rejected: 0,
    relaid: 0,
    plane: [0, 0, 0, 0],
  };
  resetLeg(leg);
  return leg;
}

/** The foot position of the rest pose in body space (where the gait plants it on flat ground). */
export function restFoot(out: Vec3, spec: LegSpec, reach: number, drop: number): Vec3 {
  out[0] = spec.hip[0] + Math.sin(spec.restYaw) * (COXA + reach);
  out[1] = spec.hip[1] - drop;
  out[2] = spec.hip[2] + Math.cos(spec.restYaw) * (COXA + reach);
  return out;
}

/** Back to the deterministic bent rest pose; forgets every previous solve. */
export function resetLeg(leg: Leg): void {
  leg.yaw = leg.spec.restYaw;
  leg.plane[0] = REST_KNEE[0];
  leg.plane[1] = REST_KNEE[1];
  leg.plane[2] = REST_KNEE[0] + TIBIA * 0.32;
  leg.plane[3] = REST_KNEE[1] - TIBIA * 0.95;
  leg.error = 0;
  leg.rejected = 0;
  leg.relaid = 0;
  setFrame(leg);
  layFromPlane(leg);
  fabrik3.getEffector(leg.foot, leg.chain);
  vec3.copy(leg.knee, leg.chain.bones[0]!.end);
  vec3.copy(leg.goal, leg.foot);
}

function setFrame(leg: Leg): void {
  const { dir, axis, femurBase, spec } = leg;
  dir[0] = Math.sin(leg.yaw);
  dir[1] = 0;
  dir[2] = Math.cos(leg.yaw);
  vec3.cross(axis, dir, UP);
  femurBase[0] = spec.hip[0] + dir[0] * COXA;
  femurBase[1] = spec.hip[1];
  femurBase[2] = spec.hip[2] + dir[2] * COXA;
}

/** Plane coordinates (s along dir, y along up) from the femur base into body space. */
function planePoint(out: Vec3, leg: Leg, s: number, y: number): Vec3 {
  out[0] = leg.femurBase[0] + leg.dir[0] * s;
  out[1] = leg.femurBase[1] + y;
  out[2] = leg.femurBase[2] + leg.dir[2] * s;
  return out;
}

const laidKnee: Vec3 = [0, 0, 0];
const laidFoot: Vec3 = [0, 0, 0];

function layFromPlane(leg: Leg): void {
  const [femur, tibia] = leg.chain.bones as [fabrik3.Bone3, fabrik3.Bone3];
  planePoint(laidKnee, leg, leg.plane[0], leg.plane[1]);
  planePoint(laidFoot, leg, leg.plane[2], leg.plane[3]);
  // Keep the bone lengths exact: re-lay the knee and foot at their rest distances.
  const ks = Math.hypot(leg.plane[0], leg.plane[1]) || 1;
  vec3.copy(femur.start, leg.femurBase);
  planePoint(femur.end, leg, (leg.plane[0] / ks) * FEMUR, (leg.plane[1] / ks) * FEMUR);
  vec3.copy(tibia.start, femur.end);
  vec3.subtract(laidFoot, laidFoot, laidKnee);
  const fl = vec3.length(laidFoot) || 1;
  vec3.scaleAndAdd(tibia.end, tibia.start, laidFoot, TIBIA / fl);
  fabrik3.setBaseLocation(leg.chain, leg.femurBase);
  fabrik3.setBaseboneHingeConstraint(leg.chain, fabrik3.BaseboneConstraintType.GLOBAL_HINGE, leg.axis, FEMUR_DOWN, FEMUR_UP, leg.dir);
  fabrik3.setHingeJoint(tibia.joint, fabrik3.JointType.GLOBAL_HINGE, leg.axis, TIBIA_IN, TIBIA_OUT, DOWN);
}

const reach: Vec3 = [0, 0, 0];
const crossKnee: Vec3 = [0, 0, 0];
const femurDir: Vec3 = [0, 0, 0];
const tibiaDir: Vec3 = [0, 0, 0];

/**
 * Clamp a body-space target into the leg plane and the reachable band. Returns the goal the chain
 * will be asked for (written to `out`), using the leg's current frame.
 */
export function clampGoal(out: Vec3, leg: Leg, target: Vec3): Vec3 {
  let s = (target[0] - leg.femurBase[0]) * leg.dir[0] + (target[2] - leg.femurBase[2]) * leg.dir[2];
  let y = target[1] - leg.femurBase[1];
  const d = Math.hypot(s, y);
  if (d < 1e-9) {
    s = 0;
    y = -REACH_MIN;
  } else if (d > REACH_MAX) {
    s *= REACH_MAX / d;
    y *= REACH_MAX / d;
  } else if (d < REACH_MIN) {
    s *= REACH_MIN / d;
    y *= REACH_MIN / d;
  }
  return planePoint(out, leg, s, y);
}

/** Which side of the femur→foot line the knee is on: negative = knee up (the only accepted pose). */
export function kneeSide(leg: Leg): number {
  vec3.subtract(femurDir, leg.knee, leg.femurBase);
  vec3.subtract(tibiaDir, leg.foot, leg.knee);
  vec3.cross(crossKnee, femurDir, tibiaDir);
  return vec3.dot(crossKnee, leg.axis);
}

// The last accepted pose, restored as a whole when a solve is rejected: yaw (and so the frame),
// knee, foot, goal and the warm-start plane coordinates.
const prevKnee: Vec3 = [0, 0, 0];
const prevFoot: Vec3 = [0, 0, 0];
const prevGoal: Vec3 = [0, 0, 0];
const prevPlane: [number, number, number, number] = [0, 0, 0, 0];

/**
 * Point the leg at a body-space foot target. Returns the remaining effector error, or Infinity
 * when the input was rejected (the previous pose is kept).
 */
export function solveLeg(leg: Leg, target: Vec3): number {
  if (!vec3.finite(target)) {
    leg.rejected++;
    return Infinity;
  }
  const prevYaw = leg.yaw;
  vec3.copy(prevKnee, leg.knee);
  vec3.copy(prevFoot, leg.foot);
  vec3.copy(prevGoal, leg.goal);
  for (let k = 0; k < 4; k++) prevPlane[k] = leg.plane[k]!;
  const hx = target[0] - leg.spec.hip[0];
  const hz = target[2] - leg.spec.hip[2];
  if (hx * hx + hz * hz > 1e-8) {
    const wanted = Math.atan2(hx, hz);
    leg.yaw = leg.spec.restYaw + clamp(deltaAngle(leg.spec.restYaw, wanted), -YAW_LIMIT, YAW_LIMIT);
  }
  setFrame(leg);
  clampGoal(leg.goal, leg, target);
  layFromPlane(leg);
  let error = fabrik3.solve(leg.chain, leg.goal);
  readChain(leg);
  if (Number.isFinite(error) && kneeSide(leg) >= 0) {
    // Wrong knee side (or a straightened chain): start over from the bent rest pose.
    leg.relaid++;
    leg.plane[0] = REST_KNEE[0];
    leg.plane[1] = REST_KNEE[1];
    vec3.subtract(reach, leg.goal, leg.femurBase);
    leg.plane[2] = reach[0] * leg.dir[0] + reach[2] * leg.dir[2];
    leg.plane[3] = reach[1];
    layFromPlane(leg);
    error = fabrik3.solve(leg.chain, leg.goal);
    readChain(leg);
  }
  if (!Number.isFinite(error) || !vec3.finite(leg.knee) || !vec3.finite(leg.foot) || kneeSide(leg) >= 0) {
    leg.yaw = prevYaw;
    setFrame(leg);
    vec3.copy(leg.knee, prevKnee);
    vec3.copy(leg.foot, prevFoot);
    vec3.copy(leg.goal, prevGoal);
    for (let k = 0; k < 4; k++) leg.plane[k] = prevPlane[k]!;
    leg.rejected++;
    return Infinity;
  }
  leg.error = error;
  // Remember the pose in plane coordinates so the next solve warm-starts after the coxa turns.
  vec3.subtract(reach, leg.knee, leg.femurBase);
  leg.plane[0] = reach[0] * leg.dir[0] + reach[2] * leg.dir[2];
  leg.plane[1] = reach[1];
  vec3.subtract(reach, leg.foot, leg.femurBase);
  leg.plane[2] = reach[0] * leg.dir[0] + reach[2] * leg.dir[2];
  leg.plane[3] = reach[1];
  return error;
}

function readChain(leg: Leg): void {
  vec3.copy(leg.knee, leg.chain.bones[0]!.end);
  fabrik3.getEffector(leg.foot, leg.chain);
}

const frame3: Mat3 = mat3.create();
const segment: Vec3 = [0, 0, 0];
const zAxis: Vec3 = [0, 0, 0];

/** Rotation whose columns are (axis, bone direction, axis × bone): +Y of the mesh along the bone. */
export function segmentRotation(out: Quat, axis: Vec3, from: Vec3, to: Vec3): Quat {
  vec3.subtract(segment, to, from);
  vec3.normalize(segment, segment);
  vec3.cross(zAxis, axis, segment);
  vec3.normalize(zAxis, zAxis);
  frame3[0] = axis[0];
  frame3[1] = axis[1];
  frame3[2] = axis[2];
  frame3[3] = segment[0];
  frame3[4] = segment[1];
  frame3[5] = segment[2];
  frame3[6] = zAxis[0];
  frame3[7] = zAxis[1];
  frame3[8] = zAxis[2];
  return quat.normalize(out, quat.fromMat3(out, frame3));
}

/** Body-space rotations of the coxa, femur and tibia segments. */
export function legRotations(leg: Leg, coxa: Quat, femur: Quat, tibia: Quat): void {
  segmentRotation(coxa, leg.axis, leg.spec.hip, leg.femurBase);
  segmentRotation(femur, leg.axis, leg.femurBase, leg.knee);
  segmentRotation(tibia, leg.axis, leg.knee, leg.foot);
}
