import { pcg2d, unitFloat } from "@vgpu/wgsl-std/hash";
import { voronoi2d } from "@vgpu/wgsl-std/noise";
import { fbmSimplex2d } from "@vgpu/wgsl-std/noise/simplex";
import { saturate } from "@vgpu/wgsl-std/math";
import { Camera, Scene, Surface, finish, lightSurface, sunShadow } from "./common.wgsl";

@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var<uniform> scene: Scene;
@group(0) @binding(2) var shadowMap: texture_depth_2d;
@group(0) @binding(3) var shadowSampler: sampler_comparison;

const CONTOUR_SPACING: f32 = 0.08;
const GLAZE_LINE: f32 = -0.07;

struct TerrainInput {
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  // How far the vertex sits below its neighbourhood (positive in hollows), in [-1, 1].
  @location(2) cavity: f32,
}

struct TerrainVarying {
  @builtin(position) clip: vec4f,
  @location(0) worldPosition: vec3f,
  @location(1) normal: vec3f,
  @location(2) cavity: f32,
}

@vertex
fn vs_main(input: TerrainInput) -> TerrainVarying {
  var output: TerrainVarying;
  output.worldPosition = input.position;
  output.normal = input.normal;
  output.cavity = input.cavity;
  output.clip = camera.viewProjection * vec4f(input.position, 1.0);
  return output;
}

/** Round iron speckle: a few cells in a jittered grid carry one anti-aliased dot. */
fn speckle(position: vec2f, scale: f32) -> f32 {
  let scaled = position * scale;
  let cell = vec2u(vec2i(floor(scaled) + vec2f(8192.0)));
  let h = pcg2d(cell);
  let pick = unitFloat(pcg2d(cell + vec2u(7u, 3u)).x);
  let centre = vec2f(unitFloat(h.x), unitFloat(h.y)) * 0.6 + 0.2;
  let radius = mix(0.06, 0.14, pick * pick);
  let distance = length(fract(scaled) - centre);
  let aa = max(fwidth(scaled.x), 1e-4);
  return (1.0 - smoothstep(radius - aa, radius + aa, distance)) * step(0.82, pick);
}

/** Anti-aliased ring of half-width `half` (world units) at `radius` around `centre`. */
fn ring(position: vec2f, centre: vec2f, radius: f32, half: f32, footprint: f32) -> f32 {
  let distance = abs(length(position - centre) - radius);
  return 1.0 - smoothstep(half - footprint, half + footprint, distance);
}

/** Soft darkening under the robot bodies: the shadow map is too coarse for the contact itself. */
fn contactShade(position: vec3f) -> f32 {
  var shade = 1.0;
  for (var i = 0u; i < min(scene.contactCount, 48u); i++) {
    let body = scene.contacts[i];
    let offset = position.xz - body.xz;
    let reach = body.w;
    let d2 = dot(offset, offset) / (reach * reach);
    if (d2 < 4.0) {
      let above = saturate(1.0 - (body.y - position.y) / 0.7);
      shade *= 1.0 - 0.42 * exp(-d2 * 1.6) * above;
    }
  }
  return shade;
}

@fragment
fn fs_main(input: TerrainVarying) -> @location(0) vec4f {
  let p = input.worldPosition;
  let n = normalize(input.normal);
  let footprint = max(fwidth(p.x), fwidth(p.z));

  // Stoneware bisque on the crests, a cool celadon glaze pooling in the hollows.
  let tone = fbmSimplex2d(p.xz * 0.9, 3, 2.1, 0.5) * 0.5 + 0.5;
  let bisque = mix(vec3f(0.14, 0.112, 0.082), vec3f(0.2, 0.162, 0.118), tone * 0.65 + saturate(p.y * 1.5) * 0.35);
  let glaze = vec3f(0.03, 0.085, 0.078);
  // The glaze runs below a fixed line, so lowered ground fills with celadon pools.
  let pooled = (GLAZE_LINE - p.y) * 9.0 + input.cavity * 1.2;
  let glazed = smoothstep(0.0, 0.5, pooled);
  // Crackle: the fine craze lines of a fired glaze, only inside the pools.
  let craze = voronoi2d(p.xz * 15.0);
  let edge = craze.f2 - craze.f1;
  let crackle = (1.0 - smoothstep(0.0, max(fwidth(edge) * 1.5, 0.03), edge)) * (1.0 - smoothstep(0.004, 0.02, footprint));
  var albedo = mix(bisque, glaze * (1.0 - crackle * 0.3), glazed);
  // Iron speckle fired into the clay (it sinks under the glaze).
  albedo *= 1.0 - speckle(p.xz, 14.0) * 0.6 * (1.0 - glazed * 0.7);

  // Faint contour lines incised every CONTOUR_SPACING of height.
  let level = p.y / CONTOUR_SPACING;
  let lineFootprint = max(fwidth(level), 1e-4);
  let contour = 1.0 - smoothstep(0.0, lineFootprint * 1.2, abs(fract(level + 0.5) - 0.5));
  albedo *= 1.0 - contour * 0.16 * (1.0 - smoothstep(0.02, 0.2, footprint));

  var surface = Surface(albedo, vec3f(0.04), mix(14.0, 110.0, glazed), 1.0, vec3f(0.0));
  surface.occlusion = contactShade(p) * mix(1.0, 0.72, saturate(input.cavity * 2.0));

  // Brush: warm ring for raise, cool for lower, coral cross-hair when aiming a destination.
  let brush = scene.brush;
  if (brush.w != 0.0) {
    let width = max(footprint * 1.2, 0.012);
    let edge = ring(p.xz, brush.xy, brush.z, width, footprint);
    let inner = ring(p.xz, brush.xy, brush.z * 0.35, width * 0.6, footprint) * 0.6;
    var tint = vec3f(1.6, 1.05, 0.45);
    if (brush.w < 0.0) {
      tint = vec3f(0.45, 1.05, 1.6);
    } else if (brush.w > 1.5) {
      tint = vec3f(1.7, 0.45, 0.3);
    }
    surface.emission += tint * (edge + inner) * 0.6;
    let inside = 1.0 - smoothstep(brush.z - footprint, brush.z + footprint, length(p.xz - brush.xy));
    surface.albedo = mix(surface.albedo, surface.albedo * 1.12 + tint * 0.02, inside * 0.5);
  }

  // Destination: a pulsing coral ring that settles, with a small cross at its centre.
  let destination = scene.destination;
  if (destination.z > 0.5) {
    let age = destination.w;
    let settle = 1.0 - exp(-age * 3.0);
    let pulse = 0.5 + 0.5 * sin(age * 3.2);
    let width = max(footprint * 1.2, 0.014);
    let radius = mix(0.9, 0.34, settle) + pulse * 0.03;
    let mark = ring(p.xz, destination.xy, radius, width, footprint);
    let offset = abs(p.xz - destination.xy);
    let crossBar = (1.0 - smoothstep(width - footprint, width + footprint, min(offset.x, offset.y))) * step(max(offset.x, offset.y), 0.12);
    surface.emission += vec3f(1.9, 0.5, 0.32) * (mark * (0.55 + 0.45 * pulse) + crossBar * 0.8);
  }

  let viewDirection = normalize(camera.eye - p);
  let shadow = sunShadow(shadowMap, shadowSampler, scene.lightViewProjection, p, n);
  let radiance = lightSurface(surface, n, viewDirection, scene.sunDirection, scene.sunColor, scene.skyColor, shadow);
  return finish(radiance, scene.exposure);
}
