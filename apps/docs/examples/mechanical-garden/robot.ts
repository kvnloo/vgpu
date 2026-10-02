// One hexapod: kinematic locomotion on the terrain. Steering sets a heading and a speed; the body
// is carried along that path, and its height and tilt come from the planted feet. Feet are
// stored in world space: a planted foot keeps its x/z and follows the terrain height, and a
// swinging foot arcs over the sampled terrain to a foothold re-queried every step. A tripod gait
// lifts three non-neighbouring feet at a time. Nothing here is physics: the legs are posed by IK to
// meet the feet, and the body heave and sway follow the support tripod.

import { clamp, deltaAngle, mat3, quat, vec3, type Mat3, type Quat, type Vec3 } from "math";
import { spring, type Spring } from "math/time";

import { COXA, createLeg, REACH_MAX, REACH_MIN, resetLeg, solveLeg, YAW_LIMIT, type Leg, type LegSpec } from "./leg";
import { clampToTile, heightAt, type Terrain } from "./terrain";

/** Leg order: front, middle, rear on the right (0–2), then the left (3–5). */
export const LEG_SPECS: readonly LegSpec[] = [
  { hip: [0.17, -0.02, 0.22], restYaw: Math.PI / 2 - 0.62 },
  { hip: [0.2, -0.02, 0], restYaw: Math.PI / 2 },
  { hip: [0.17, -0.02, -0.22], restYaw: Math.PI / 2 + 0.62 },
  { hip: [-0.17, -0.02, 0.22], restYaw: -Math.PI / 2 + 0.62 },
  { hip: [-0.2, -0.02, 0], restYaw: -Math.PI / 2 },
  { hip: [-0.17, -0.02, -0.22], restYaw: -Math.PI / 2 - 0.62 },
];
export const LEG_COUNT = LEG_SPECS.length;
/** Tripods: {front-right, middle-left, rear-right} and {front-left, middle-right, rear-left}. */
export const TRIPOD: readonly number[] = [0, 1, 0, 1, 0, 1];
/** Adjacent legs; a foot never lifts while one of these swings. */
export const NEIGHBOURS: readonly (readonly number[])[] = [
  [1, 3],
  [0, 2, 4],
  [1, 5],
  [0, 4],
  [3, 5, 1],
  [4, 2],
];

/** Body origin height above the mean planted foot. */
export const RIDE_HEIGHT = 0.3;
/** Horizontal distance from the femur base to the rest foothold. */
export const REST_REACH = 0.38;
export const FOOT_RADIUS = 0.035;
export const STRIDE = 0.34;
export const SWING_TIME = 0.24;
export const SWING_LIFT = 0.09;
export const MAX_SPEED = 0.55;
/** Largest body tilt from the foot-plane fit, in radians. */
export const MAX_TILT = 0.38;
const MAX_GRADIENT = Math.tan(MAX_TILT);
/** Robot footprint radius used by steering and destinations. */
export const BODY_RADIUS = 0.62;
/** Footholds stay this far inside the tile edge. */
const FOOT_EDGE = 0.12;
/**
 * Closest the body centre comes to the tile edge. Rest footholds reach 0.80 from the centre (front
 * and rear legs), so every one of them stays on the tile; closer, the foothold clamp would plant an
 * outward foot under its own hip, where the femur cannot reach it.
 */
export const EDGE_MARGIN = 0.95;
/** Planted feet re-step when the terrain under them moved this much since they landed. */
export const TERRAIN_STEP = 0.07;
/** Reach band, as a fraction of the leg's femur+tibia reach, that triggers a step. */
export const STEP_REACH_MAX = 0.92 * (REACH_MAX / 0.96);
export const STEP_REACH_MIN = REACH_MIN + 0.03;
/** Coxa yaw away from rest, in radians, that triggers a step (the joint stops at YAW_LIMIT). */
export const STEP_YAW = YAW_LIMIT - 0.3;
/**
 * Body motion may not push a planted foot past this coxa yaw or reach: the step is cut back
 * instead, so the body waits for the gait rather than dragging feet it cannot reach.
 */
export const GUARD_YAW = YAW_LIMIT - 0.08;
export const GUARD_REACH_MAX = REACH_MAX - 0.015;
export const GUARD_REACH_MIN = REACH_MIN + 0.01;
/** Fastest body turn in rad/s: about what two tripod swings can re-plant. */
export const MAX_TURN_RATE = 1.8;
/** Largest turn a landing foot anticipates, in radians, so it lands inside its sector. */
export const PREDICT_TURN = 0.45;
/** Time constant (s) of the realised ground velocity the gait plans with. */
export const GROUND_SMOOTHING = 0.12;

export interface Foot {
  /** World-space foot centre (the tibia tip sits FOOT_RADIUS above the contact point). */
  readonly position: Vec3;
  readonly start: Vec3;
  readonly landing: Vec3;
  /** 0 when planted, else swing progress in (0, 1]. */
  swing: number;
  planted: boolean;
  /** Terrain height under the foot when it landed. */
  contact: number;
  /** Steps since it last landed (for debug colouring). */
  restSteps: number;
}

export interface Robot {
  readonly index: number;
  active: boolean;
  /** Body origin, world space. */
  readonly position: Vec3;
  readonly rotation: Quat;
  readonly heading: Spring<number>;
  readonly speed: Spring<number>;
  /**
   * The body's realised ground velocity in world x/z, smoothed over GROUND_SMOOTHING. It differs
   * from heading × speed when the crowd pushes the robot or the support guard holds it, and the
   * gait plans footholds from it.
   */
  readonly velocity: [number, number];
  readonly height: Spring<number>;
  /** Springed gradient of the fitted foot plane along the body's right and forward axes. */
  readonly slopeRight: Spring<number>;
  readonly slopeForward: Spring<number>;
  /** Head yaw relative to the body, and the antenna's lag (x, z) in body space. */
  readonly look: Spring<number>;
  readonly antennaX: Spring<number>;
  readonly antennaZ: Spring<number>;
  readonly legs: readonly Leg[];
  readonly feet: readonly Foot[];
  /** Body-space foot targets solved this step. */
  readonly targets: readonly Vec3[];
  /** Which tripod may lift next. */
  turn: number;
  /** Steering goal in world x/z. */
  readonly goal: [number, number];
  /** Whether the robot has arrived at its goal. */
  arrived: boolean;
  /** Per-robot variation from the seed. */
  palette: number;
  phase: number;
  blink: number;
  /** Debug counters. */
  steps: number;
  slipped: number;
  /** Steps whose body motion was cut back to keep the planted feet reachable. */
  held: number;
}

export function createRobot(index: number): Robot {
  const legs = LEG_SPECS.map((spec) => createLeg(spec));
  const robot: Robot = {
    index,
    active: false,
    position: [0, 0, 0],
    rotation: [0, 0, 0, 1],
    heading: spring.create(0),
    speed: spring.create(0),
    velocity: [0, 0],
    height: spring.create(0),
    slopeRight: spring.create(0),
    slopeForward: spring.create(0),
    look: spring.create(0),
    antennaX: spring.create(0),
    antennaZ: spring.create(0),
    legs,
    feet: legs.map(() => ({ position: [0, 0, 0], start: [0, 0, 0], landing: [0, 0, 0], swing: 0, planted: true, contact: 0, restSteps: 0 })),
    targets: legs.map(() => [0, 0, 0] as Vec3),
    turn: 0,
    goal: [0, 0],
    arrived: true,
    palette: 0,
    phase: 0,
    blink: 0,
    steps: 0,
    slipped: 0,
    held: 0,
  };
  return robot;
}

function resetSpring(state: Spring<number>, value: number): void {
  state.value = value;
  state.velocity = 0;
}

const restLocal: Vec3 = [0, 0, 0];
const scratch: Vec3 = [0, 0, 0];

/** Place the robot standing still at (x, z) facing `heading`, feet planted at rest. */
export function placeRobot(robot: Robot, terrain: Terrain, x: number, z: number, heading: number): void {
  robot.active = true;
  resetSpring(robot.heading, heading);
  resetSpring(robot.speed, 0);
  robot.velocity[0] = 0;
  robot.velocity[1] = 0;
  resetSpring(robot.look, 0);
  resetSpring(robot.antennaX, 0);
  resetSpring(robot.antennaZ, 0);
  resetSpring(robot.slopeRight, 0);
  resetSpring(robot.slopeForward, 0);
  robot.position[0] = x;
  robot.position[2] = z;
  robot.goal[0] = x;
  robot.goal[1] = z;
  robot.arrived = true;
  robot.turn = 0;
  robot.steps = 0;
  robot.slipped = 0;
  robot.held = 0;
  setRotation(robot, heading, 0, 0);
  // Feet first on the ground under the rest pose, then the body height from them.
  robot.position[1] = heightAt(terrain, x, z) + RIDE_HEIGHT;
  for (let leg = 0; leg < LEG_COUNT; leg++) {
    const foot = robot.feet[leg]!;
    restFootWorld(foot.position, robot, leg);
    foot.position[1] = heightAt(terrain, foot.position[0], foot.position[2]) + FOOT_RADIUS;
    foot.contact = foot.position[1] - FOOT_RADIUS;
    foot.planted = true;
    foot.swing = 0;
    foot.restSteps = 0;
    resetLeg(robot.legs[leg]!);
  }
  resetSpring(robot.height, meanPlanted(robot) + RIDE_HEIGHT);
  robot.position[1] = robot.height.value;
  solveLegs(robot);
}

const bodyFrame: Mat3 = mat3.create();
const axisUp: Vec3 = [0, 0, 0];
const axisForward: Vec3 = [0, 0, 0];
const axisRight: Vec3 = [0, 0, 0];

/**
 * Body rotation from a heading and the gradient of the ground plane y = gr·right + gf·forward:
 * up is the plane normal, forward is the heading direction carried onto the plane.
 */
export function setRotation(robot: Robot, heading: number, gradientRight: number, gradientForward: number): void {
  const c = Math.cos(heading);
  const s = Math.sin(heading);
  // Heading frame: right = (cos h, 0, −sin h), forward = (sin h, 0, cos h).
  vec3.set(axisUp, -gradientRight * c - gradientForward * s, 1, gradientRight * s - gradientForward * c);
  vec3.normalize(axisUp, axisUp);
  vec3.set(axisForward, s, gradientForward, c);
  vec3.normalize(axisForward, axisForward);
  vec3.cross(axisRight, axisUp, axisForward);
  vec3.normalize(axisRight, axisRight);
  bodyFrame[0] = axisRight[0];
  bodyFrame[1] = axisRight[1];
  bodyFrame[2] = axisRight[2];
  bodyFrame[3] = axisUp[0];
  bodyFrame[4] = axisUp[1];
  bodyFrame[5] = axisUp[2];
  bodyFrame[6] = axisForward[0];
  bodyFrame[7] = axisForward[1];
  bodyFrame[8] = axisForward[2];
  quat.normalize(robot.rotation, quat.fromMat3(robot.rotation, bodyFrame));
}

/** World position of a leg's rest foothold under the current body pose (y left at body height). */
export function restFootWorld(out: Vec3, robot: Robot, leg: number): Vec3 {
  const spec = LEG_SPECS[leg]!;
  restLocal[0] = spec.hip[0] + Math.sin(spec.restYaw) * (COXA + REST_REACH);
  restLocal[1] = 0;
  restLocal[2] = spec.hip[2] + Math.cos(spec.restYaw) * (COXA + REST_REACH);
  // Rest footholds follow heading only, not tilt, so they stay put on slopes.
  const h = robot.heading.value;
  const c = Math.cos(h);
  const s = Math.sin(h);
  out[0] = robot.position[0] + c * restLocal[0] + s * restLocal[2];
  out[1] = robot.position[1];
  out[2] = robot.position[2] - s * restLocal[0] + c * restLocal[2];
  return out;
}

function meanPlanted(robot: Robot): number {
  let sum = 0;
  let count = 0;
  for (const foot of robot.feet) {
    if (!foot.planted) continue;
    sum += foot.position[1] - FOOT_RADIUS;
    count++;
  }
  return count > 0 ? sum / count : robot.position[1] - RIDE_HEIGHT;
}

const inverse: Quat = [0, 0, 0, 1];

/** World point → body space under the current pose. */
export function toBody(out: Vec3, robot: Robot, world: Vec3): Vec3 {
  vec3.subtract(out, world, robot.position);
  quat.invert(inverse, robot.rotation);
  return vec3.transformQuat(out, out, inverse);
}

function solveLegs(robot: Robot): void {
  for (let leg = 0; leg < LEG_COUNT; leg++) {
    const target = robot.targets[leg]!;
    toBody(target, robot, robot.feet[leg]!.position);
    solveLeg(robot.legs[leg]!, target);
  }
}

/** Distance from the femur base to a body-space point, as the reach checks see it. */
function reachOf(robot: Robot, leg: number, local: Vec3): number {
  const l = robot.legs[leg]!;
  const spec = l.spec;
  const hx = local[0] - spec.hip[0];
  const hz = local[2] - spec.hip[2];
  const horizontal = Math.hypot(hx, hz) - COXA;
  return Math.hypot(horizontal, local[1] - spec.hip[1]);
}

export interface StepContext {
  readonly terrain: Terrain;
  readonly dt: number;
  /** Desired speed scale in [0, 1] (reduced motion lowers it). */
  readonly pace: number;
  /** Steering acceleration toward the goal plus separation, x/z. */
  readonly steerX: number;
  readonly steerZ: number;
  /** Body displacement the crowd asks for this step, x/z (see colony resolveCrowding). */
  readonly pushX?: number;
  readonly pushZ?: number;
}

const local: Vec3 = [0, 0, 0];

/** Advance one fixed step. */
export function stepRobot(robot: Robot, context: StepContext): void {
  const { terrain, dt } = context;
  robot.steps++;
  // --- Steering: heading and speed springs on the fixed step, the turn rate capped.
  const steer = Math.hypot(context.steerX, context.steerZ);
  const wanted = steer > 1e-4 ? Math.atan2(context.steerX, context.steerZ) : robot.heading.value;
  const heading0 = robot.heading.value;
  spring.dampAngle(robot.heading, wanted, 0.45, dt);
  const maxTurn = MAX_TURN_RATE * dt;
  const turn = clamp(deltaAngle(heading0, robot.heading.value), -maxTurn, maxTurn);
  robot.heading.velocity = clamp(robot.heading.velocity, -MAX_TURN_RATE, MAX_TURN_RATE);
  const misalign = Math.abs(deltaAngle(heading0 + turn, wanted));
  const desiredSpeed = MAX_SPEED * context.pace * clamp(steer, 0, 1) * Math.max(0, Math.cos(Math.min(misalign, Math.PI / 2)));
  spring.damp(robot.speed, desiredSpeed, 0.35, dt);
  const speed = Math.max(0, robot.speed.value);
  // The walk, the crowd's push and the tile clamp form one move, and the body makes only as much of
  // it as its planted feet can follow (see supportFraction).
  const walkX = robot.position[0] + Math.sin(heading0 + turn) * speed * dt + (context.pushX ?? 0);
  const walkZ = robot.position[2] + Math.cos(heading0 + turn) * speed * dt + (context.pushZ ?? 0);
  const moveX = clampToTile(walkX, EDGE_MARGIN) - robot.position[0];
  const moveZ = clampToTile(walkZ, EDGE_MARGIN) - robot.position[2];
  const fraction = supportFraction(robot, heading0, turn, moveX, moveZ);
  if (fraction < 1) {
    robot.held++;
    robot.heading.velocity *= fraction;
  }
  robot.heading.value = heading0 + turn * fraction;
  robot.position[0] += moveX * fraction;
  robot.position[2] += moveZ * fraction;
  const smoothing = 1 - Math.exp(-dt / GROUND_SMOOTHING);
  robot.velocity[0] += ((moveX * fraction) / dt - robot.velocity[0]) * smoothing;
  robot.velocity[1] += ((moveZ * fraction) / dt - robot.velocity[1]) * smoothing;

  // --- Feet: planted feet follow the terrain; swinging feet arc toward a fresh foothold. The gait
  // runs on the realised ground speed: a robot walking into a neighbour that pushes back must not
  // plant its feet a stride ahead of a body that stays put.
  const yawRate = robot.heading.velocity;
  const ground = Math.hypot(robot.velocity[0], robot.velocity[1]);
  const stance = STRIDE / Math.max(ground, 0.05);
  const lead = clamp(SWING_TIME + 0.5 * Math.min(stance, 1.2), 0, 0.7);
  for (let leg = 0; leg < LEG_COUNT; leg++) {
    const foot = robot.feet[leg]!;
    if (foot.planted) {
      foot.restSteps++;
      foot.position[1] = heightAt(terrain, foot.position[0], foot.position[2]) + FOOT_RADIUS;
      continue;
    }
    predictFoothold(foot.landing, robot, leg, yawRate, lead * (1 - foot.swing), terrain);
    foot.swing = Math.min(1, foot.swing + dt / SWING_TIME);
    swingPosition(foot, terrain);
    if (foot.swing >= 1) {
      foot.planted = true;
      foot.swing = 0;
      foot.restSteps = 0;
      vec3.copy(foot.position, foot.landing);
      foot.contact = foot.position[1] - FOOT_RADIUS;
    }
  }

  // --- Gait: lift the tripod whose turn it is when its feet stray, never next to a swinging foot.
  let swinging = 0;
  for (const foot of robot.feet) if (!foot.planted) swinging++;
  if (swinging === 0) {
    let need = needsStep(robot, robot.turn, terrain, ground);
    if (need === 0) {
      const other = 1 - robot.turn;
      if (needsStep(robot, other, terrain, ground) > 0) {
        robot.turn = other;
        need = 1;
      }
    }
    if (need > 0) {
      for (let leg = 0; leg < LEG_COUNT; leg++) {
        if (TRIPOD[leg] !== robot.turn) continue;
        const foot = robot.feet[leg]!;
        if (!legWantsStep(robot, leg, terrain, ground, 0.03)) continue;
        if (NEIGHBOURS[leg]!.some((n) => !robot.feet[n]!.planted)) continue;
        foot.planted = false;
        foot.swing = 0;
        vec3.copy(foot.start, foot.position);
        predictFoothold(foot.landing, robot, leg, yawRate, lead, terrain);
      }
      robot.turn = 1 - robot.turn;
    }
  }

  // --- Body pose from the planted feet.
  fitBody(robot, dt, swinging);

  // --- Head looks into the turn; the antenna lags the body's acceleration.
  spring.update(robot.look, clamp(deltaAngle(robot.heading.value, wanted) * 0.8, -0.7, 0.7), 0.3, 0.8, dt);
  spring.update(robot.antennaX, clamp(-yawRate * 0.12, -0.4, 0.4), 0.18, 0.35, dt);
  spring.update(robot.antennaZ, clamp(-robot.speed.velocity * 0.25, -0.4, 0.4), 0.18, 0.35, dt);

  solveLegs(robot);
  for (let leg = 0; leg < LEG_COUNT; leg++) {
    if (robot.feet[leg]!.planted && robot.legs[leg]!.error > 0.01) robot.slipped++;
  }
}

/** Whether any foot of a tripod needs a step (1) or not (0). */
function needsStep(robot: Robot, tripod: number, terrain: Terrain, speed: number): number {
  for (let leg = 0; leg < LEG_COUNT; leg++) {
    if (TRIPOD[leg] === tripod && legWantsStep(robot, leg, terrain, speed, 0)) return 1;
  }
  return 0;
}

/**
 * A planted foot wants a step when it strayed more than half a stride from its rest foothold,
 * when its reach left the comfortable band, or when the terrain under it moved since it landed.
 * `slack` > 0 asks only "is it measurably out of place" (used to pick which feet of a tripod lift).
 */
export function legWantsStep(robot: Robot, leg: number, terrain: Terrain, speed: number, slack: number): boolean {
  const foot = robot.feet[leg]!;
  if (!foot.planted) return false;
  restFootWorld(scratch, robot, leg);
  const drift = Math.hypot(foot.position[0] - scratch[0], foot.position[2] - scratch[2]);
  if (slack > 0) return drift > slack || reachOut(robot, leg) || terrainMoved(foot, terrain);
  const strideLimit = speed > 0.02 ? STRIDE * 0.5 : STRIDE * 0.32;
  return drift > strideLimit || reachOut(robot, leg) || terrainMoved(foot, terrain);
}

/** Whether a planted foot left the comfortable reach band or yaw sector of its leg. */
function reachOut(robot: Robot, leg: number): boolean {
  toBody(local, robot, robot.feet[leg]!.position);
  const reach = reachOf(robot, leg, local);
  return reach > STEP_REACH_MAX || reach < STEP_REACH_MIN || yawOf(leg, local) > STEP_YAW;
}

/** Coxa yaw away from rest, in radians, that a body-space point asks of a leg. */
function yawOf(leg: number, point: Vec3): number {
  const spec = LEG_SPECS[leg]!;
  return Math.abs(deltaAngle(spec.restYaw, Math.atan2(point[0] - spec.hip[0], point[2] - spec.hip[2])));
}

const strainBefore: number[] = LEG_SPECS.map(() => 0);
const SUPPORT_FRACTIONS = [1, 0.5, 0.25];

/**
 * How much of this step's turn and move the body may take: the largest of 1, ½ or ¼ that pushes
 * no planted foot further past GUARD_YAW or the guarded reach band, else 0. A foot already past
 * them (sculpted terrain, a late landing) only blocks motion that makes it worse; the gait steps
 * it because STEP_YAW and the step reach band sit inside the guard. Body space here ignores tilt,
 * which the guard margins absorb.
 */
function supportFraction(robot: Robot, heading0: number, turn: number, moveX: number, moveZ: number): number {
  const x0 = robot.position[0];
  const z0 = robot.position[2];
  for (let leg = 0; leg < LEG_COUNT; leg++) strainBefore[leg] = strain(robot, leg, heading0, x0, z0);
  for (const fraction of SUPPORT_FRACTIONS) {
    // The move ends inside the tile (stepRobot clamps it), so every fraction of it does too.
    const x = x0 + moveX * fraction;
    const z = z0 + moveZ * fraction;
    let ok = true;
    for (let leg = 0; leg < LEG_COUNT && ok; leg++) {
      const after = strain(robot, leg, heading0 + turn * fraction, x, z);
      ok = after <= 0 || after <= strainBefore[leg]! + 1e-9;
    }
    if (ok) return fraction;
  }
  return 0;
}

/** How far a planted foot sits outside the guarded yaw sector and reach band for a body pose. */
function strain(robot: Robot, leg: number, heading: number, x: number, z: number): number {
  const foot = robot.feet[leg]!;
  if (!foot.planted) return 0;
  const c = Math.cos(heading);
  const s = Math.sin(heading);
  const dx = foot.position[0] - x;
  const dz = foot.position[2] - z;
  local[0] = c * dx - s * dz;
  local[1] = foot.position[1] - robot.position[1];
  local[2] = s * dx + c * dz;
  const reach = reachOf(robot, leg, local);
  return Math.max(0, yawOf(leg, local) - GUARD_YAW) + Math.max(0, reach - GUARD_REACH_MAX) + Math.max(0, GUARD_REACH_MIN - reach);
}

function terrainMoved(foot: Foot, terrain: Terrain): boolean {
  return Math.abs(heightAt(terrain, foot.position[0], foot.position[2]) - foot.contact) > TERRAIN_STEP;
}

/** Where a foot should land: the rest foothold under the body pose `lead` seconds ahead. */
function predictFoothold(out: Vec3, robot: Robot, leg: number, yawRate: number, lead: number, terrain: Terrain): Vec3 {
  const spec = LEG_SPECS[leg]!;
  const lx = spec.hip[0] + Math.sin(spec.restYaw) * (COXA + REST_REACH);
  const lz = spec.hip[2] + Math.cos(spec.restYaw) * (COXA + REST_REACH);
  const h = robot.heading.value + clamp(yawRate * lead, -PREDICT_TURN, PREDICT_TURN);
  const px = robot.position[0] + robot.velocity[0] * lead;
  const pz = robot.position[2] + robot.velocity[1] * lead;
  const c = Math.cos(h);
  const s = Math.sin(h);
  out[0] = clampToTile(px + c * lx + s * lz, FOOT_EDGE);
  out[2] = clampToTile(pz - s * lx + c * lz, FOOT_EDGE);
  out[1] = heightAt(terrain, out[0], out[2]) + FOOT_RADIUS;
  return out;
}

const SWING_SAMPLES = 6;

/** Swing arc: eased x/z, linear y plus a clearance bump that clears every sampled bump on the path. */
function swingPosition(foot: Foot, terrain: Terrain): void {
  const t = foot.swing;
  const e = t * t * (3 - 2 * t);
  const { start, landing, position } = foot;
  let clearance = 0;
  for (let k = 1; k < SWING_SAMPLES; k++) {
    const s = k / SWING_SAMPLES;
    const x = start[0] + (landing[0] - start[0]) * s;
    const z = start[2] + (landing[2] - start[2]) * s;
    const line = start[1] + (landing[1] - start[1]) * s;
    clearance = Math.max(clearance, heightAt(terrain, x, z) + FOOT_RADIUS - line);
  }
  position[0] = start[0] + (landing[0] - start[0]) * e;
  position[2] = start[2] + (landing[2] - start[2]) * e;
  const bump = 4 * t * (1 - t) * (SWING_LIFT + clearance);
  position[1] = start[1] + (landing[1] - start[1]) * t + bump;
  // Never dip under the surface right below the foot either.
  position[1] = t >= 1 ? landing[1] : Math.max(position[1], heightAt(terrain, position[0], position[2]) + FOOT_RADIUS);
}

/** Body height and tilt from a least-squares plane through the planted feet, then springs. */
function fitBody(robot: Robot, dt: number, swinging: number): void {
  const h = robot.heading.value;
  const c = Math.cos(h);
  const s = Math.sin(h);
  let n = 0;
  let sx = 0;
  let sz = 0;
  let sy = 0;
  let sxx = 0;
  let szz = 0;
  let sxz = 0;
  let sxy = 0;
  let szy = 0;
  for (const foot of robot.feet) {
    if (!foot.planted) continue;
    const dx = foot.position[0] - robot.position[0];
    const dz = foot.position[2] - robot.position[2];
    // Heading frame: r = right, f = forward.
    const r = c * dx - s * dz;
    const f = s * dx + c * dz;
    const y = foot.position[1] - FOOT_RADIUS;
    n++;
    sx += r;
    sz += f;
    sy += y;
    sxx += r * r;
    szz += f * f;
    sxz += r * f;
    sxy += r * y;
    szy += f * y;
  }
  let slopeRight = 0;
  let slopeForward = 0;
  let base = robot.height.value - RIDE_HEIGHT;
  if (n >= 3) {
    // Solve the 3×3 normal equations for y = a + b·r + c·f.
    const mr = sx / n;
    const mf = sz / n;
    const my = sy / n;
    const crr = sxx / n - mr * mr;
    const cff = szz / n - mf * mf;
    const crf = sxz / n - mr * mf;
    const cry = sxy / n - mr * my;
    const cfy = szy / n - mf * my;
    const det = crr * cff - crf * crf;
    if (Math.abs(det) > 1e-8) {
      slopeRight = (cry * cff - cfy * crf) / det;
      slopeForward = (cfy * crr - cry * crf) / det;
    }
    base = my - slopeRight * mr - slopeForward * mf;
  }
  // Clamp the tilt (the gradient's length), keeping its direction.
  const gradient = Math.hypot(slopeRight, slopeForward);
  if (gradient > MAX_GRADIENT) {
    slopeRight *= MAX_GRADIENT / gradient;
    slopeForward *= MAX_GRADIENT / gradient;
  }
  spring.update(robot.slopeRight, slopeRight, 0.16, 1, dt);
  spring.update(robot.slopeForward, slopeForward, 0.16, 1, dt);
  // Heave: the body dips a little while a tripod is airborne.
  spring.update(robot.height, base + RIDE_HEIGHT - (swinging > 0 ? 0.012 : 0), 0.1, 0.9, dt);
  robot.position[1] = robot.height.value;
  setRotation(robot, robot.heading.value, robot.slopeRight.value, robot.slopeForward.value);
}
