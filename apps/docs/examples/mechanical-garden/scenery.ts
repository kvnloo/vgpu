// Seeded set dressing on the terrain: dark stones the robots steer around, moss cushions and reed
// tufts. Each item keeps a world matrix that is rebuilt only when sculpting touches its footprint,
// so the renderer republishes scenery on terrain edits, not every frame.

import { mat4, quat, type Mat4, type Quat, type Vec3 } from "math";
import { mulberry32 } from "math/random";

import { clampToTile, heightAt, HALF, normalAt, type Terrain } from "./terrain";

export const STONE_COUNT = 9;
export const MOSS_COUNT = 34;
export const REED_COUNT = 44;

export interface Item {
  readonly x: number;
  readonly z: number;
  /** Footprint radius (stones: obstacle radius). */
  readonly radius: number;
  readonly yaw: number;
  /** Mesh scale x/y/z. */
  readonly scale: Vec3;
  /** How far the item sinks below the lowest ground under its footprint. */
  readonly sink: number;
  /** Variation in [0, 1) for shading and sway phase. */
  readonly variant: number;
  /** Whether it leans with the ground normal (moss, reeds) or stays upright (stones). */
  readonly lean: number;
}

export interface Scenery {
  readonly stones: readonly Item[];
  readonly moss: readonly Item[];
  readonly reeds: readonly Item[];
  /** Column-major world matrices, 16 floats per item, in the same order as the item arrays. */
  readonly stoneWorlds: Float32Array<ArrayBuffer>;
  readonly mossWorlds: Float32Array<ArrayBuffer>;
  readonly reedWorlds: Float32Array<ArrayBuffer>;
  /** Bumped whenever any world matrix changes. */
  revision: number;
}

/** Robots spawn in the middle; the stones leave it clear. */
const CLEAR_CENTRE = 1.1;

export function createScenery(seed: number, terrain: Terrain): Scenery {
  const random = mulberry32.create((seed ^ 0x5bd1e995) >>> 0);
  const sample = () => mulberry32.sample(random);
  const stones: Item[] = [];
  for (let attempt = 0; stones.length < STONE_COUNT && attempt < 400; attempt++) {
    const radius = 0.2 + sample() * 0.26;
    const x = clampToTile((sample() * 2 - 1) * (HALF - 0.6), 0.6);
    const z = clampToTile((sample() * 2 - 1) * (HALF - 0.6), 0.6);
    if (Math.hypot(x, z) < CLEAR_CENTRE + radius) continue;
    // Keep walking lanes between stones: a robot body fits through every gap.
    if (stones.some((s) => Math.hypot(s.x - x, s.z - z) < s.radius + radius + 1.1)) continue;
    const flat = 0.55 + sample() * 0.3;
    stones.push({ x, z, radius, yaw: sample() * Math.PI * 2, scale: [radius, radius * flat, radius * (0.8 + sample() * 0.3)], sink: radius * flat * 0.25, variant: sample(), lean: 0 });
  }
  const moss: Item[] = [];
  for (let attempt = 0; moss.length < MOSS_COUNT && attempt < 800; attempt++) {
    // Moss gathers at the foot of stones, with a few loose cushions.
    const host = stones[Math.floor(sample() * stones.length)]!;
    const loose = sample() < 0.25;
    const angle = sample() * Math.PI * 2;
    const distance = loose ? 0 : host.radius * (0.85 + sample() * 0.5);
    const x = clampToTile(loose ? (sample() * 2 - 1) * (HALF - 0.5) : host.x + Math.cos(angle) * distance, 0.4);
    const z = clampToTile(loose ? (sample() * 2 - 1) * (HALF - 0.5) : host.z + Math.sin(angle) * distance, 0.4);
    const radius = 0.08 + sample() * 0.14;
    if (loose && Math.hypot(x, z) < CLEAR_CENTRE) continue;
    if (moss.some((m) => Math.hypot(m.x - x, m.z - z) < (m.radius + radius) * 0.8)) continue;
    moss.push({ x, z, radius, yaw: sample() * Math.PI * 2, scale: [radius, radius * (0.35 + sample() * 0.2), radius * (0.8 + sample() * 0.3)], sink: radius * 0.1, variant: sample(), lean: 1 });
  }
  const reeds: Item[] = [];
  for (let attempt = 0; reeds.length < REED_COUNT && attempt < 800; attempt++) {
    // Reeds cluster in a few loose clumps.
    const clump = Math.floor(sample() * 5);
    const cx = Math.cos(clump * 2.4 + seed * 0.37) * (HALF - 1.2);
    const cz = Math.sin(clump * 2.4 + seed * 0.37) * (HALF - 1.2);
    const x = clampToTile(cx + (sample() - 0.5) * 1.4, 0.4);
    const z = clampToTile(cz + (sample() - 0.5) * 1.4, 0.4);
    if (stones.some((s) => Math.hypot(s.x - x, s.z - z) < s.radius + 0.06)) continue;
    const height = 0.28 + sample() * 0.32;
    reeds.push({ x, z, radius: 0.05, yaw: sample() * Math.PI * 2, scale: [0.9 + sample() * 0.3, height, 0.9 + sample() * 0.3], sink: 0.01, variant: sample(), lean: 0.35 });
  }
  const scenery: Scenery = {
    stones,
    moss,
    reeds,
    stoneWorlds: new Float32Array(stones.length * 16),
    mossWorlds: new Float32Array(moss.length * 16),
    reedWorlds: new Float32Array(reeds.length * 16),
    revision: 0,
  };
  reseat(scenery, terrain, -HALF, -HALF, HALF, HALF);
  return scenery;
}

const world: Mat4 = mat4.create();
const rotation: Quat = [0, 0, 0, 1];
const yawRotation: Quat = [0, 0, 0, 1];
const tilt: Quat = [0, 0, 0, 1];
const normal: Vec3 = [0, 1, 0];
const up: Vec3 = [0, 1, 0];
const position: Vec3 = [0, 0, 0];

/** Lowest ground under an item's footprint (centre plus a ring of eight samples). */
function groundUnder(terrain: Terrain, item: Item): number {
  let low = heightAt(terrain, item.x, item.z);
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    low = Math.min(low, heightAt(terrain, item.x + Math.cos(a) * item.radius * 0.8, item.z + Math.sin(a) * item.radius * 0.8));
  }
  return low;
}

function seat(out: Float32Array, row: number, terrain: Terrain, item: Item): boolean {
  position[0] = item.x;
  position[1] = (item.lean > 0 ? heightAt(terrain, item.x, item.z) : groundUnder(terrain, item)) - item.sink;
  position[2] = item.z;
  quat.setAxisAngle(yawRotation, up, item.yaw);
  if (item.lean > 0) {
    normalAt(normal, terrain, item.x, item.z);
    // Partial lean: blend up toward the ground normal, then rotate up onto it.
    normal[0] *= item.lean;
    normal[2] *= item.lean;
    const length = Math.hypot(normal[0], normal[1], normal[2]);
    normal[0] /= length;
    normal[1] /= length;
    normal[2] /= length;
    quat.rotationTo(tilt, up, normal);
    quat.multiply(rotation, tilt, yawRotation);
  } else {
    quat.copy(rotation, yawRotation);
  }
  mat4.fromRotationTranslationScale(world, rotation, position, item.scale);
  let changed = false;
  for (let k = 0; k < 16; k++) {
    const value = Math.fround(world[k]!);
    if (out[row * 16 + k] !== value) {
      out[row * 16 + k] = value;
      changed = true;
    }
  }
  return changed;
}

function reseatList(out: Float32Array, terrain: Terrain, items: readonly Item[], x0: number, z0: number, x1: number, z1: number): boolean {
  let changed = false;
  for (let k = 0; k < items.length; k++) {
    const item = items[k]!;
    if (item.x + item.radius < x0 || item.x - item.radius > x1 || item.z + item.radius < z0 || item.z - item.radius > z1) continue;
    if (seat(out, k, terrain, item)) changed = true;
  }
  return changed;
}

/** Re-seat every item whose footprint overlaps the world-space box; returns whether any moved. */
export function reseat(scenery: Scenery, terrain: Terrain, x0: number, z0: number, x1: number, z1: number): boolean {
  const a = reseatList(scenery.stoneWorlds, terrain, scenery.stones, x0, z0, x1, z1);
  const b = reseatList(scenery.mossWorlds, terrain, scenery.moss, x0, z0, x1, z1);
  const c = reseatList(scenery.reedWorlds, terrain, scenery.reeds, x0, z0, x1, z1);
  const changed = a || b || c;
  if (changed) scenery.revision++;
  return changed;
}

/**
 * Push a point (x, z) out of every stone by `clearance` and keep it `margin` inside the tile,
 * writing the result into out. Returns whether a stone moved it.
 */
export function avoidStones(out: [number, number], scenery: Scenery, x: number, z: number, clearance: number, margin = 0.5): boolean {
  let moved = false;
  out[0] = clampToTile(x, margin);
  out[1] = clampToTile(z, margin);
  for (let pass = 0; pass < 3; pass++) {
    for (const stone of scenery.stones) {
      const dx = out[0] - stone.x;
      const dz = out[1] - stone.z;
      const distance = Math.hypot(dx, dz);
      const limit = stone.radius + clearance;
      if (distance >= limit) continue;
      const nx = distance > 1e-6 ? dx / distance : 1;
      const nz = distance > 1e-6 ? dz / distance : 0;
      out[0] = clampToTile(stone.x + nx * limit, margin);
      out[1] = clampToTile(stone.z + nz * limit, margin);
      moved = true;
    }
  }
  return moved;
}
