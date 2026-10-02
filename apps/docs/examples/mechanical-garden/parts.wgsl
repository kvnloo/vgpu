import { pcg3d, unitFloat } from "@vgpu/wgsl-std/hash";
import { saturate } from "@vgpu/wgsl-std/math";
import { instanceWorldMatrix, transformNormal, transformPosition } from "@vgpu/wgsl-std/scene";
import {
  Camera,
  Scene,
  Surface,
  finish,
  lightSurface,
  swayed,
  sunShadow,
} from "./common.wgsl";

@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var<uniform> scene: Scene;
@group(0) @binding(2) var shadowMap: texture_depth_2d;
@group(0) @binding(3) var shadowSampler: sampler_comparison;

// Robot parts and scenery share this shader: every mesh vertex carries a material code, and the
// instance style is (palette, glow, part or variant, unused).
struct PartInput {
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) material: f32,
  @location(3) world0: vec4f,
  @location(4) world1: vec4f,
  @location(5) world2: vec4f,
  @location(6) world3: vec4f,
  @location(7) style: vec4f,
}

struct PartVarying {
  @builtin(position) clip: vec4f,
  @location(0) worldPosition: vec3f,
  @location(1) normal: vec3f,
  @location(2) localPosition: vec3f,
  @location(3) @interpolate(flat, either) material: u32,
  @location(4) @interpolate(flat, either) style: vec4f,
}

@vertex
fn vs_main(input: PartInput) -> PartVarying {
  let world = instanceWorldMatrix(input.world0, input.world1, input.world2, input.world3);
  let local = swayed(input.position, input.material, input.style.z, scene.time);
  var output: PartVarying;
  output.worldPosition = transformPosition(world, local);
  output.normal = transformNormal(world, input.normal);
  output.localPosition = input.position;
  output.material = u32(input.material + 0.5);
  output.style = input.style;
  output.clip = camera.viewProjection * vec4f(output.worldPosition, 1.0);
  return output;
}

// Linear enamel and accent per palette: ivory/coral, teal/ivory, coral/teal.
fn enamelColor(palette: u32) -> vec3f {
  switch palette {
    case 1u: { return vec3f(0.018, 0.2, 0.2); }
    case 2u: { return vec3f(0.74, 0.15, 0.09); }
    default: { return vec3f(0.8, 0.74, 0.6); }
  }
}

fn accentColor(palette: u32) -> vec3f {
  switch palette {
    case 1u: { return vec3f(0.8, 0.74, 0.6); }
    case 2u: { return vec3f(0.018, 0.2, 0.2); }
    default: { return vec3f(0.74, 0.15, 0.09); }
  }
}

fn speckle(position: vec3f, scale: f32) -> f32 {
  let cell = vec3u(vec3i(floor(position * scale) + vec3f(4096.0)));
  return unitFloat(pcg3d(cell).x);
}

fn surfaceFor(input: PartVarying) -> Surface {
  var surface = Surface(vec3f(0.5), vec3f(0.04), 32.0, 1.0, vec3f(0.0));
  let palette = u32(input.style.x + 0.5);
  // Case values are the MATERIAL codes in common.wgsl / meshes.ts (the linker keeps only consts
  // referenced from expressions, so the selectors are literals).
  switch input.material {
    case 0u: { // MATERIAL_ENAMEL
      surface.albedo = enamelColor(palette);
      surface.shininess = 90.0;
      surface.specular = vec3f(0.05);
    }
    case 1u: { // MATERIAL_ACCENT
      surface.albedo = accentColor(palette);
      surface.shininess = 70.0;
      surface.specular = vec3f(0.05);
    }
    case 2u: { // MATERIAL_GRAPHITE
      surface.albedo = vec3f(0.028, 0.029, 0.033);
      surface.shininess = 40.0;
      surface.specular = vec3f(0.06);
    }
    case 3u: { // MATERIAL_BRASS
      surface.albedo = vec3f(0.2, 0.12, 0.035);
      surface.specular = vec3f(0.8, 0.55, 0.22);
      surface.shininess = 60.0;
    }
    case 4u: { // MATERIAL_EYE
      let glow = input.style.y;
      surface.albedo = vec3f(0.05);
      surface.specular = vec3f(0.08);
      surface.shininess = 120.0;
      surface.emission = vec3f(0.55, 1.6, 1.7) * glow;
    }
    case 5u: { // MATERIAL_RUBBER
      surface.albedo = vec3f(0.018, 0.017, 0.016);
      surface.shininess = 10.0;
      surface.specular = vec3f(0.03);
    }
    case 6u: { // MATERIAL_STONE
      let grain = speckle(input.localPosition, 22.0);
      let tone = mix(0.045, 0.075, input.style.z);
      surface.albedo = vec3f(tone, tone * 0.97, tone * 0.94) * (0.75 + 0.5 * grain);
      surface.shininess = 22.0;
      surface.specular = vec3f(0.035);
      // Lichen flecks on the upper faces.
      let fleck = step(0.93, speckle(input.localPosition, 9.0)) * saturate(input.normal.y * 1.5);
      surface.albedo = mix(surface.albedo, vec3f(0.32, 0.3, 0.16), fleck * 0.7);
    }
    case 7u: { // MATERIAL_MOSS
      let grain = speckle(input.localPosition, 30.0);
      surface.albedo = mix(vec3f(0.035, 0.07, 0.018), vec3f(0.09, 0.15, 0.03), grain * 0.7 + input.style.z * 0.3);
      surface.shininess = 8.0;
      surface.specular = vec3f(0.02);
      surface.occlusion = mix(0.55, 1.0, saturate(input.localPosition.y * 2.0 + 0.6));
    }
    case 8u: { // MATERIAL_REED
      let t = saturate(input.localPosition.y);
      surface.albedo = mix(vec3f(0.06, 0.09, 0.025), vec3f(0.42, 0.34, 0.13), t * t);
      surface.shininess = 16.0;
      surface.specular = vec3f(0.03);
      surface.occlusion = mix(0.45, 1.0, t);
    }
    case 9u: { // MATERIAL_PLINTH
      // Dark glazed stoneware with a thin brass lip at the rim.
      let rim = smoothstep(-0.05, -0.015, input.localPosition.y);
      surface.albedo = mix(vec3f(0.03, 0.032, 0.036), vec3f(0.2, 0.12, 0.035), rim);
      surface.specular = mix(vec3f(0.05), vec3f(0.8, 0.55, 0.22), rim);
      surface.shininess = mix(70.0, 50.0, rim);
      surface.occlusion = mix(0.5, 1.0, saturate(input.localPosition.y / 0.9 + 1.0));
    }
    default: {}
  }
  return surface;
}

@fragment
fn fs_main(input: PartVarying, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  // Reed blades are two-sided.
  let normal = select(-input.normal, input.normal, front);
  let n = normalize(normal);
  let viewDirection = normalize(camera.eye - input.worldPosition);
  let shadow = sunShadow(shadowMap, shadowSampler, scene.lightViewProjection, input.worldPosition, n);
  let surface = surfaceFor(input);
  let radiance = lightSurface(surface, n, viewDirection, scene.sunDirection, scene.sunColor, scene.skyColor, shadow);
  return finish(radiance, scene.exposure);
}
