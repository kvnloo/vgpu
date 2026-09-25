---
title: "Two-pass rendering: offscreen depth target composited to the canvas"
description: "A 3D scene needs a depth buffer that surfaces and canvases do not have — render into an offscreen `target(gpu, { depth: true })`, then composite that target onto the canvas in a second pass."
---

Surfaces and canvases have no depth buffer, and [Draws](concepts-draws.docs.md) need one for any real 3D scene. The answer is always the same two passes:

1. Render the geometry into an offscreen `target(gpu, { size, depth: true })`.
2. Draw that target's color texture onto the canvas as one full-screen effect.

[Draws](concepts-draws.docs.md), [Passes](concepts-passes.docs.md), and [Frames](concepts-frames.docs.md) each describe one third of this. This guide is the copy-pasteable whole.

## The recipe

```ts
import { draw, effect, frame, geometry, init, sampler, surface, target } from "vgpu";
import { box, composeMatrix, orbitRig, perspective, rigPose, sphere, viewMatrices } from "vgpu/scene";

const gpu = await init();
const canvas = document.querySelector("canvas")!;

// Both objects share shading; vertex entrypoints match their different attribute layouts.
const objectShader = `
  struct Camera { viewProjection: mat4x4f }
  struct Model { model: mat4x4f, color: vec3f }
  @group(0) @binding(0) var<uniform> camera: Camera;
  @group(0) @binding(1) var<uniform> model: Model;

  struct VertexOut { @builtin(position) position: vec4f, @location(0) normal: vec3f }

  fn vertex(position: vec3f, normal: vec3f) -> VertexOut {
    var out: VertexOut;
    out.position = camera.viewProjection * model.model * vec4f(position, 1.0);
    out.normal = (model.model * vec4f(normal, 0.0)).xyz;
    return out;
  }

  @vertex fn vs_box(@location(0) position: vec3f, @location(1) normal: vec3f) -> VertexOut {
    return vertex(position, normal);
  }

  @vertex fn vs_sphere(@location(0) position: vec3f, @location(1) normal: vec3f, @location(2) uv: vec2f) -> VertexOut {
    return vertex(position, normal);
  }

  @fragment fn fs_main(@location(0) normal: vec3f) -> @location(0) vec4f {
    let light = max(dot(normalize(normal), normalize(vec3f(1.0, 1.0, 1.0))), 0.15);
    return vec4f(model.color * light, 1.0);
  }
`;

// Pass 2 reads pass 1's color texture and writes it to the canvas.
const presentShader = `
  @group(0) @binding(0) var scene: texture_2d<f32>;
  @group(0) @binding(1) var sceneSampler: sampler;

  @fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
    return textureSampleLevel(scene, sceneSampler, uv, 0.0);
  }
`;

// ---cut---
const width = 960;
const height = 540;

// Pass 1 target: offscreen, WITH depth — this is the piece a surface cannot give you.
const scene = target(gpu, { size: [width, height], depth: true });
// Pass 2 target: the canvas the user actually sees.
const canvasSurface = surface(gpu, canvas);

const rig = orbitRig({ yaw: 0.62, pitch: 0.44, distance: 4.74 });
const pose = { position: new Float32Array(3), quaternion: new Float32Array(4) };
const projection = perspective({ fov: 45, near: 0.1, far: 100 }, width / height, new Float32Array(16));
const camera = { view: new Float32Array(16), viewProjection: new Float32Array(16) };
viewMatrices(rigPose(rig, pose), projection, camera);
const cubeWorld = composeMatrix({ position: [1, 0, 0] }, new Float32Array(16));
const ballWorld = composeMatrix({
  position: [Math.cos(2.1), 0, Math.sin(2.1)], rotation: [0, 2.1, 0],
}, new Float32Array(16));

const cube = draw(gpu, {
  shader: objectShader, entry: { vertex: "vs_box" },
  geometry: geometry(gpu, box({ size: 1 })), cull: "back",
});
cube.set({
  camera: { viewProjection: camera.viewProjection },
  model: { model: cubeWorld, color: [0.95, 0.45, 0.2] },
});

const ball = draw(gpu, {
  shader: objectShader, entry: { vertex: "vs_sphere" },
  geometry: geometry(gpu, sphere({ radius: 0.6 })), cull: "back",
});
ball.set({
  camera: { viewProjection: camera.viewProjection },
  model: { model: ballWorld, color: [0.3, 0.6, 1] },
});

// The present pass is a single full-screen effect bound to the offscreen target.
const present = effect(gpu, presentShader, {
  set: { scene, sceneSampler: sampler(gpu, { minFilter: "linear", magFilter: "linear" }) },
});

frame(gpu, (currentFrame) => {
  currentFrame.pass({ target: scene, clear: [0.04, 0.05, 0.08, 1], clearDepth: 1 }, (pass) => {
    pass.draw(cube);
    pass.draw(ball);
  });
  currentFrame.pass(canvasSurface, present);
});
```

Three things are doing the work:

- **`depth: true` on the offscreen target.** Without it the draws have no depth attachment and the two objects paint over each other in submission order. `clearDepth: 1` resets it every frame; use `clearDepth: 0` together with `depth: { compare: "greater" }` on the draw for reversed-Z in deep scenes.
- **Binding the target itself.** `set({ scene })` passes the `Target` where the WGSL declares a `texture_2d<f32>`; vgpu binds its color texture. Pair it with a `sampler(gpu, ...)` for the `sampler` binding.
- **One `frame()`.** Both passes are encoded into one command encoder and submitted once — see [Frames](concepts-frames.docs.md). Do not use one-shot `.draw()` calls inside a frame callback; they submit on their own and break the ordering.

Animating? Move the `frame(gpu, ...)` body into [`frameLoop(gpu, ...)`](concepts-frames.docs.md) and re-`set()` the model matrices from `clock(gpu).time` each tick. The targets, draws, and the present effect are all created once, outside the loop.

Camera and model matrices are ordinary application-owned arrays. Update them before the frame and call `set()` on each draw that needs the new values; mutation alone does not refresh a uniform. The shader owns both binding declarations. The normal calculation above assumes rotation and uniform scale; for nonuniform scale or shear, use `transformNormal` from `@vgpu/wgsl-std/scene` with the complete world matrix. [Scene composition](scene-composition.docs.md) covers that helper and external camera state.

The box supplies `position` and `normal`; the sphere also supplies `uv`. Their vertex entrypoints declare these complete layouts, even though this shader does not use UVs for shading.

## Headless / no-bundler variant

Rendering this from Node, a script, or a test instead of a browser? Everything is identical except that the second target is another offscreen target rather than a canvas surface, and you read the pixels back at the end:

```ts
import { draw, effect, frame, geometry, init, sampler, target } from "vgpu/node";
import { box, composeMatrix, orbitRig, perspective, rigPose, viewMatrices } from "vgpu/scene";

const objectShader = "/* the same vertex + fragment shader as above */";
const presentShader = "/* the same present shader as above */";
const width = 960;
const height = 540;

// ---cut---
const gpu = await init();
const scene = target(gpu, { size: [width, height], depth: true });
const output = target(gpu, { size: [width, height] });   // stands in for the canvas surface

const rig = orbitRig({ yaw: 0.62, pitch: 0.44, distance: 4.74 });
const pose = { position: new Float32Array(3), quaternion: new Float32Array(4) };
const projection = perspective({ fov: 45, near: 0.1, far: 100 }, width / height, new Float32Array(16));
const camera = { view: new Float32Array(16), viewProjection: new Float32Array(16) };
viewMatrices(rigPose(rig, pose), projection, camera);
const cubeWorld = composeMatrix({ position: [1, 0, 0] }, new Float32Array(16));
const cube = draw(gpu, {
  shader: objectShader, entry: { vertex: "vs_box" },
  geometry: geometry(gpu, box({ size: 1 })), cull: "back",
});
cube.set({
  camera: { viewProjection: camera.viewProjection },
  model: { model: cubeWorld, color: [0.95, 0.45, 0.2] },
});
const present = effect(gpu, presentShader, {
  set: { scene, sceneSampler: sampler(gpu, { minFilter: "linear", magFilter: "linear" }) },
});

frame(gpu, (currentFrame) => {
  currentFrame.pass({ target: scene, clear: [0.04, 0.05, 0.08, 1], clearDepth: 1 }, (pass) => {
    pass.draw(cube);
  });
  currentFrame.pass(output, present);
});

const pixels = await output.color.read({ mipLevel: 0, region: "all" });   // RGBA bytes — assert on them, or encode a PNG
gpu.dispose();
```

To load the two shaders from `.wgsl` files instead of inline strings in this setup, resolve them first: [Using vgpu without a bundler](no-bundler.docs.md).

## Do you actually need two passes?

- **One full-screen fragment shader, no geometry?** No. `effect(gpu, source).draw(canvasSurface)` renders straight to the canvas — see [Getting started](getting-started.docs.md).
- **Flat 2D geometry with explicit paint order?** No. Open a single pass on the canvas and draw in order, as [Passes](concepts-passes.docs.md) shows.
- **Any 3D geometry that can occlude itself or another object?** Yes — you need the depth attachment, and only an offscreen target has one.
- **Post-processing on top of a 3D scene?** Yes, and the present pass is where it goes: replace `presentShader` with your post effect, which already samples the scene texture.

## See also

- [Draws](concepts-draws.docs.md) — why 3D geometry needs a depth target, plus `cull` and reversed-Z.
- [Passes](concepts-passes.docs.md) — the single-shader present-pass pattern used here.
- [Frames](concepts-frames.docs.md) — how `frame()` batches passes into one submit, and `frameLoop()` for animation.
- [Getting started](getting-started.docs.md) — the browser-first walkthrough this recipe extends.
- [Using vgpu without a bundler](no-bundler.docs.md) — loading the shaders above from `.wgsl` files.
