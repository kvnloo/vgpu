// Procedural meshes, built once on the CPU. Every part mesh is one merged vertex buffer whose
// vertices carry a material code, so a robot part (an enamel shell with graphite joints and brass
// fittings) is a single instanced draw. Leg segments run along +Y from the joint at 0 to the next
// joint at the bone length, matching the rig locals; the hinge axis is local +X.
//
// Vertex layout (shared with the terrain): position (3), normal (3), material (1) floats.

import { COXA, FEMUR, TIBIA } from "./leg";
import { FOOT_RADIUS } from "./robot";
import { HALF } from "./terrain";

export const MESH_VERTEX_FLOATS = 7;

/** Material codes; keep in sync with the MATERIAL_* constants in common.wgsl. */
export const MATERIAL = {
  enamel: 0,
  accent: 1,
  graphite: 2,
  brass: 3,
  eye: 4,
  rubber: 5,
  stone: 6,
  moss: 7,
  reed: 8,
  plinth: 9,
} as const;

export interface MeshData {
  readonly vertices: Float32Array<ArrayBuffer>;
  readonly indices: Uint32Array<ArrayBuffer>;
}

type V3 = readonly [number, number, number];

/** A local frame: the primitive's x/y/z axes and origin in mesh space. */
interface Frame {
  readonly x: V3;
  readonly y: V3;
  readonly z: V3;
  readonly origin: V3;
}

const AXES: Frame = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1], origin: [0, 0, 0] };

function at(origin: V3, frame: Frame = AXES): Frame {
  return { ...frame, origin };
}

/** A frame whose +Y runs along local +X (hinge pins across a leg). */
function across(origin: V3): Frame {
  return { x: [0, -1, 0], y: [1, 0, 0], z: [0, 0, 1], origin };
}

/** A frame whose +Y runs along +Z (forward). */
function forward(origin: V3): Frame {
  return { x: [1, 0, 0], y: [0, 0, 1], z: [0, -1, 0], origin };
}

class Builder {
  private readonly vertices: number[] = [];
  private readonly indices: number[] = [];

  private vertex(frame: Frame, p: V3, n: V3, material: number): number {
    const { x, y, z, origin } = frame;
    const nx = x[0] * n[0] + y[0] * n[1] + z[0] * n[2];
    const ny = x[1] * n[0] + y[1] * n[1] + z[1] * n[2];
    const nz = x[2] * n[0] + y[2] * n[1] + z[2] * n[2];
    const length = Math.hypot(nx, ny, nz) || 1;
    this.vertices.push(
      origin[0] + x[0] * p[0] + y[0] * p[1] + z[0] * p[2],
      origin[1] + x[1] * p[0] + y[1] * p[1] + z[1] * p[2],
      origin[2] + x[2] * p[0] + y[2] * p[1] + z[2] * p[2],
      nx / length,
      ny / length,
      nz / length,
      material,
    );
    return this.vertices.length / MESH_VERTEX_FLOATS - 1;
  }

  /** Counter-clockwise quads over a (rows+1)×(columns+1) vertex grid starting at `first`. */
  private grid(first: number, rows: number, columns: number): void {
    const stride = columns + 1;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < columns; c++) {
        const a = first + r * stride + c;
        const b = a + 1;
        const d = a + stride;
        const e = d + 1;
        this.indices.push(a, b, d, b, e, d);
      }
    }
  }

  /**
   * Ellipsoid with `radii`, optionally squashed below the equator, and a radial `shape(u, v)`
   * multiplier (u around, v from the bottom pole) for lumpy stones and moss.
   */
  ellipsoid(frame: Frame, radii: V3, material: number, segments = 18, rings = 12, shape?: (u: number, v: number) => number): this {
    const first = this.vertices.length / MESH_VERTEX_FLOATS;
    for (let r = 0; r <= rings; r++) {
      const v = r / rings;
      const phi = Math.PI * (v - 0.5);
      for (let s = 0; s <= segments; s++) {
        const u = s / segments;
        const theta = u * Math.PI * 2;
        const k = shape ? shape(u % 1, v) : 1;
        const ux = Math.cos(phi) * Math.sin(theta);
        const uy = Math.sin(phi);
        const uz = Math.cos(phi) * Math.cos(theta);
        // The normal of an ellipsoid is the unit direction scaled by 1/radii.
        this.vertex(frame, [ux * radii[0] * k, uy * radii[1] * k, uz * radii[2] * k], [ux / radii[0], uy / radii[1], uz / radii[2]], material);
      }
    }
    this.grid(first, rings, segments);
    return this;
  }

  /**
   * Superellipsoid: `squareness` 1 is an ellipsoid, smaller values flatten the faces toward a
   * rounded box (machined panels rather than organic shells).
   */
  rounded(frame: Frame, radii: V3, squareness: number, material: number, segments = 28, rings = 16): this {
    const first = this.vertices.length / MESH_VERTEX_FLOATS;
    const e = squareness;
    const spow = (value: number, exponent: number) => Math.sign(value) * Math.abs(value) ** exponent;
    for (let r = 0; r <= rings; r++) {
      const phi = Math.PI * (r / rings - 0.5);
      const cp = Math.cos(phi);
      const sp = Math.sin(phi);
      for (let s = 0; s <= segments; s++) {
        const theta = (s / segments) * Math.PI * 2;
        const st = Math.sin(theta);
        const ct = Math.cos(theta);
        this.vertex(
          frame,
          [radii[0] * spow(cp, e) * spow(st, e), radii[1] * spow(sp, e), radii[2] * spow(cp, e) * spow(ct, e)],
          [(spow(cp, 2 - e) * spow(st, 2 - e)) / radii[0], spow(sp, 2 - e) / radii[1], (spow(cp, 2 - e) * spow(ct, 2 - e)) / radii[2]],
          material,
        );
      }
    }
    this.grid(first, rings, segments);
    return this;
  }

  /** Tapered tube along +Y from y0 (radius r0) to y1 (radius r1), with flat caps. */
  tube(frame: Frame, y0: number, y1: number, r0: number, r1: number, material: number, sides = 12, caps = true): this {
    const first = this.vertices.length / MESH_VERTEX_FLOATS;
    const slope = (r0 - r1) / (y1 - y0);
    for (let r = 0; r <= 1; r++) {
      const y = r === 0 ? y0 : y1;
      const radius = r === 0 ? r0 : r1;
      for (let s = 0; s <= sides; s++) {
        const theta = (s / sides) * Math.PI * 2;
        const c = Math.cos(theta);
        const n = Math.sin(theta);
        this.vertex(frame, [n * radius, y, c * radius], [n, slope, c], material);
      }
    }
    this.grid(first, 1, sides);
    if (caps) {
      for (const [y, radius, up] of [
        [y0, r0, -1],
        [y1, r1, 1],
      ] as const) {
        const centre = this.vertex(frame, [0, y, 0], [0, up, 0], material);
        for (let s = 0; s <= sides; s++) {
          const theta = (s / sides) * Math.PI * 2;
          this.vertex(frame, [Math.sin(theta) * radius, y, Math.cos(theta) * radius], [0, up, 0], material);
        }
        for (let s = 0; s < sides; s++) {
          if (up > 0) this.indices.push(centre, centre + 1 + s, centre + 2 + s);
          else this.indices.push(centre, centre + 2 + s, centre + 1 + s);
        }
      }
    }
    return this;
  }

  /** Thin tapered blade (a triangular prism) from the origin along a curved spine. */
  blade(spine: (t: number) => V3, width: number, material: number, steps = 5): this {
    const first = this.vertices.length / MESH_VERTEX_FLOATS;
    for (let r = 0; r <= steps; r++) {
      const t = r / steps;
      const p = spine(t);
      const w = width * (1 - t * 0.92);
      for (let s = 0; s <= 3; s++) {
        const theta = (s / 3) * Math.PI * 2;
        const n: V3 = [Math.sin(theta), 0.15, Math.cos(theta)];
        this.vertex(AXES, [p[0] + n[0] * w, p[1], p[2] + n[2] * w], n, material);
      }
    }
    this.grid(first, steps, 3);
    return this;
  }

  /** Open box sides from y0 to y1 with half extent `half`, outward normals (the plinth). */
  walls(half: number, y0: number, y1: number, material: number): this {
    const sides: [V3, V3][] = [
      [[1, 0, 0], [0, 0, -1]],
      [[-1, 0, 0], [0, 0, 1]],
      [[0, 0, 1], [1, 0, 0]],
      [[0, 0, -1], [-1, 0, 0]],
    ];
    for (const [n, t] of sides) {
      const first = this.vertices.length / MESH_VERTEX_FLOATS;
      for (const y of [y0, y1]) {
        for (const side of [-1, 1]) {
          this.vertex(AXES, [n[0] * half + t[0] * half * side, y, n[2] * half + t[2] * half * side], n, material);
        }
      }
      this.indices.push(first, first + 1, first + 2, first + 1, first + 3, first + 2);
    }
    return this;
  }

  build(): MeshData {
    return { vertices: new Float32Array(this.vertices), indices: new Uint32Array(this.indices) };
  }
}

/** Small deterministic integer hash in [0, 1) (shape noise without Math.random). */
function hash(a: number, b: number): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

/** Smooth periodic lumps for a closed surface: a few low harmonics around and along. */
function lumps(seed: number, amount: number): (u: number, v: number) => number {
  const terms = Array.from({ length: 4 }, (_, k) => ({ a: hash(seed, k) * Math.PI * 2, f: 1 + k, g: hash(seed, k + 9) * 2 - 1 }));
  return (u, v) => {
    let value = 0;
    for (const term of terms) value += Math.sin(u * Math.PI * 2 * term.f + term.a + v * 3 * term.g) * Math.sin(v * Math.PI);
    return 1 + (value / terms.length) * amount;
  };
}

export type PartMeshes = Record<"shell" | "head" | "antenna" | "coxa" | "femur" | "tibia" | "foot", MeshData>;

export function buildPartMeshes(): PartMeshes {
  const { enamel, accent, graphite, brass, eye, rubber } = MATERIAL;
  // Body: a machined chassis. A graphite keel carries the hips; a rounded-box enamel deck sits on
  // it with an accent spine panel, brass bolts and a rear sensor pack.
  const shell = new Builder()
    .rounded(at([0, -0.03, 0]), [0.19, 0.065, 0.27], 0.3, graphite)
    .rounded(at([0, 0.045, -0.01]), [0.215, 0.085, 0.29], 0.45, enamel, 32, 18)
    .rounded(at([0, 0.122, -0.03]), [0.055, 0.022, 0.2], 0.3, accent, 20, 10)
    .rounded(at([0, 0.07, -0.29]), [0.11, 0.05, 0.035], 0.35, graphite, 20, 10);
  for (const side of [-1, 1]) {
    for (const z of [0.16, -0.2]) shell.tube(at([0.13 * side, 0.115, z]), -0.01, 0.012, 0.016, 0.014, brass, 10);
    for (const z of [0.22, 0, -0.22]) {
      const x = (z === 0 ? 0.2 : 0.17) * side;
      shell.tube(at([x, -0.07, z]), 0, 0.08, 0.05, 0.05, graphite, 14);
    }
  }
  // Head: a rounded-box enamel cowl, a dark glass visor and two luminous eyes on a graphite neck.
  const head = new Builder()
    .tube(forward([0, 0.02, -0.07]), 0, 0.08, 0.05, 0.045, graphite, 14)
    .rounded(at([0, 0.045, 0.05]), [0.12, 0.08, 0.095], 0.4, enamel, 28, 14)
    .rounded(at([0, 0.04, 0.115]), [0.098, 0.045, 0.04], 0.3, graphite, 24, 12)
    .ellipsoid(at([0.046, 0.042, 0.153]), [0.032, 0.03, 0.02], eye, 16, 10)
    .ellipsoid(at([-0.046, 0.042, 0.153]), [0.032, 0.03, 0.02], eye, 16, 10);
  // Antenna: a brass whisker with a glowing bead.
  const antenna = new Builder()
    .ellipsoid(at([0, 0, 0]), [0.018, 0.014, 0.018], graphite, 10, 6)
    .tube(AXES, 0, 0.15, 0.006, 0.004, brass, 6)
    .ellipsoid(at([0, 0.155, 0]), [0.016, 0.016, 0.016], eye, 10, 8);
  // Coxa: a graphite hip turret and a stout brass link out to the femur hinge.
  const coxa = new Builder()
    .tube(AXES, 0, COXA, 0.03, 0.028, brass, 12)
    .rounded(at([0, 0.03, 0]), [0.045, 0.05, 0.045], 0.5, graphite, 16, 10);
  // Femur: a hinge drum at the base, a brass strut under a rounded-box enamel armour plate.
  const femur = new Builder()
    .tube(across([-0.044, 0, 0]), 0, 0.088, 0.038, 0.038, graphite, 18)
    .tube(AXES, 0, FEMUR, 0.022, 0.02, brass, 12)
    .rounded(at([0, FEMUR * 0.5, 0.004]), [0.034, FEMUR * 0.34, 0.04], 0.5, enamel, 20, 14);
  // Tibia: a knee drum, an accent shin guard and a brass piston down to the ankle.
  const tibia = new Builder()
    .tube(across([-0.04, 0, 0]), 0, 0.08, 0.034, 0.034, graphite, 18)
    .rounded(at([0, TIBIA * 0.28, 0.004]), [0.026, TIBIA * 0.17, 0.031], 0.5, accent, 18, 12)
    .tube(AXES, TIBIA * 0.08, TIBIA - FOOT_RADIUS * 0.5, 0.017, 0.012, brass, 12)
    .tube(AXES, TIBIA * 0.52, TIBIA * 0.57, 0.021, 0.021, graphite, 14)
    .tube(AXES, TIBIA - FOOT_RADIUS * 1.6, TIBIA - FOOT_RADIUS * 0.6, 0.02, 0.026, graphite, 12);
  // Foot: a rubber pad whose underside touches the ground at the contact point.
  const foot = new Builder().ellipsoid(at([0, 0, 0]), [FOOT_RADIUS * 1.3, FOOT_RADIUS, FOOT_RADIUS * 1.3], rubber, 16, 8);
  return {
    shell: shell.build(),
    head: head.build(),
    antenna: antenna.build(),
    coxa: coxa.build(),
    femur: femur.build(),
    tibia: tibia.build(),
    foot: foot.build(),
  };
}

export type SceneryMeshes = Record<"stone" | "moss" | "reed" | "plinth", MeshData>;

/** Plinth depth below the tile rim. */
export const PLINTH_DEPTH = 0.9;

export function buildSceneryMeshes(): SceneryMeshes {
  // Unit stone: a lumpy pebble, flattened underneath; the item scale sizes it.
  const stoneLumps = lumps(3, 0.22);
  const stone = new Builder().ellipsoid(at([0, 0, 0]), [1, 1, 1], MATERIAL.stone, 22, 14, (u, v) =>
    v < 0.5 ? stoneLumps(u, v) * (0.35 + 0.65 * (v * 2) ** 2) : stoneLumps(u, v),
  );
  // Unit moss cushion: a soft lumpy dome.
  const mossLumps = lumps(11, 0.3);
  const moss = new Builder().ellipsoid(at([0, -0.25, 0]), [1, 1, 1], MATERIAL.moss, 18, 10, (u, v) =>
    v < 0.5 ? mossLumps(u, v) * 0.3 : mossLumps(u, v),
  );
  // Unit reed tuft: seven curved blades of unit height around the origin.
  const reed = new Builder();
  for (let k = 0; k < 7; k++) {
    const angle = k * 2.399 + hash(k, 5) * 0.6;
    const lean = 0.08 + hash(k, 7) * 0.22;
    const height = 0.7 + hash(k, 3) * 0.3;
    const r0 = 0.015 + hash(k, 8) * 0.02;
    reed.blade(
      (t) => [Math.cos(angle) * (r0 + lean * t * t), height * t, Math.sin(angle) * (r0 + lean * t * t)],
      0.007,
      MATERIAL.reed,
    );
  }
  const plinth = new Builder().walls(HALF, -PLINTH_DEPTH, 0.002, MATERIAL.plinth);
  return { stone: stone.build(), moss: moss.build(), reed: reed.build(), plinth: plinth.build() };
}
