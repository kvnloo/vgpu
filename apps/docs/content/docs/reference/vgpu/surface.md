---
title: "Surface"
description: "Canvas-backed render target created by `surface(gpu, canvas, opts)`. Use it for browser canvases, `OffscreenCanvas`, multi-canvas rendering, and resize-driven derived targets."
---

## Import

```ts
import type { Surface, SurfaceOptions, SurfaceResizeEvent } from "vgpu";
```

## Signature

```ts
import type { Target } from "vgpu";

interface SurfaceOptions {
  readonly autoResize?: boolean;
  readonly dpr?: number | readonly [number, number];
  readonly size?: readonly [number, number];
  readonly format?: GPUTextureFormat;
  readonly alphaMode?: GPUCanvasAlphaMode;
  readonly colorSpace?: PredefinedColorSpace;
  readonly label?: string;
}

interface SurfaceResizeEvent {
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
  readonly surface: Surface;
}

interface Surface extends Target {
  readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  readonly context: GPUCanvasContext;
  readonly autoResize: boolean;
  readonly layoutBacked: boolean;
  readonly dpr: number;
  readonly disposed: boolean;
  onResize(cb: (event: SurfaceResizeEvent) => void): () => void;
  dispose(): void;
}
```

## Parameters

| Param | Type | Required | Default | Notes |
|---|---|---:|---|---|
| surface.canvas | `HTMLCanvasElement \| OffscreenCanvas` | ✔ | — | Must return a `GPUCanvasContext` from `getContext("webgpu")`. |
| surface.opts | `SurfaceOptions` | ✖ | `{}` | Canvas configuration and resize behavior. |
| opts.autoResize | `boolean` | ✖ | `true` for layout-backed canvases, `false` when `size` is provided or when the canvas has no numeric `clientWidth` | Auto-resize is checked at the frame boundary before user frame callbacks. Explicit `true` on buffer-only canvases throws. |
| opts.dpr | `number \| readonly [number, number]` | ✖ | `globalThis.devicePixelRatio ?? 1` | Number fixes DPR. Tuple clamps runtime DPR to `[min, max]`; layout-backed surfaces re-read DPR each frame. |
| opts.size | `readonly [number, number]` | ✖ | Layout-backed: `clientWidth/clientHeight × dpr`; buffer-only: existing `canvas.width/height` | Physical pixel size. When provided, initial canvas buffer is set and `autoResize` defaults to `false`. |
| opts.format | `GPUTextureFormat` | ✖ | `navigator.gpu.getPreferredCanvasFormat() ?? "bgra8unorm"` | Canvas swapchain format. |
| opts.alphaMode | `GPUCanvasAlphaMode` | ✖ | `"premultiplied"` | Passed to `GPUCanvasContext.configure`. |
| opts.colorSpace | `PredefinedColorSpace` | ✖ | `"srgb"` | Passed to `GPUCanvasContext.configure`. |
| opts.clearColor | `ClearColor` | ✖ | `[0, 0, 0, 1]` | Default clear color of this surface, used by passes that clear without naming one. Writable at runtime as `surface.clearColor`; a pass `clear` color still wins for that pass. Four finite numbers, or a `GPUColor` object. |
| opts.label | `string` | ✖ | `undefined` | Used in error messages and texture labels. |
| onResize.cb | `(event: SurfaceResizeEvent) => void` | ✔ | — | Called synchronously immediately on subscription and after future size changes. |
| event.width | `number` | ✔ | — | Physical pixel width, equal to `surface.size[0]` and `canvas.width`. |
| event.height | `number` | ✔ | — | Physical pixel height, equal to `surface.size[1]` and `canvas.height`. |
| event.dpr | `number` | ✔ | — | Effective DPR used for the current size. |
| event.surface | `Surface` | ✔ | — | Surface that resized, useful for shared handlers. |
| surface.resize.size | `readonly [number, number]` | ✔ | — | Manual physical pixel size. Values are floored and clamped to at least `1`. |

**Returns:** `surface(gpu)` returns `Surface`; `onResize()` returns an unsubscribe function; `dispose()` returns `void`.

**Throws:** `VGPU-SURFACE-CONTEXT` when `getContext("webgpu")` returns `null`; `VGPU-SURFACE-DUPLICATE` when a live surface already owns the canvas; `VGPU-SURFACE-AUTORESIZE-UNSUPPORTED` for explicit `autoResize: true` on buffer-only canvases; `VGPU-SURFACE-DISPOSED` when using a disposed surface, including as a `compile()`, `compileSync()`, `targets: [...]`, or `bundle()` preparation target; `VGPU-SURFACE-NOT-IN-FRAME` when a one-shot `draw.draw(surface)` / `effect.draw(surface)` runs while no frame is active, or a frame that already submitted opens a surface pass — encode surface draws inside `frame(gpu, ...)`, while `compile(surface)` and `bundle(gpu, { target: surface }, ...)` can prepare outside a frame; `VGPU-SURFACE-RESIZE-REENTRANT` when resizing the same surface from its own resize callback; `VGPU-FRAME-REENTRANT` when `frame(gpu)` is called from any `onResize` callback. The immediate `onResize` fire on subscription also counts as being inside an `onResize` callback, so call `frame(gpu)` before subscribing or from code outside the callback.

A surface is never a valid input binding. Passing one as a binding value to `draw(gpu)`, `effect(gpu)`, or `compute(gpu)` — in the constructor `set` option or a later `.set()`, inside or outside a frame — throws `VGPU-SURFACE-NOT-BINDABLE` from that call. The error names the binding and drawable in `where` (for example `post.source`). vgpu rejects the surface before it reads `color`, `colors`, or `depth`, so no canvas texture is acquired; that holds for disposed surfaces too. Fix: “Render to an offscreen target and bind that target or its texture. Use Surface only as a render destination.”

A live surface is a valid preparation target outside a frame. `draw.compile(surface)`, `effect.compile(surface)`, `compileSync(surface)`, `draw(gpu, { targets: [surface] })`, and `bundle(gpu, { target: surface }, ...)` read the surface's configured render signature — `format`, no depth attachment, sample count 1. They do not acquire the current canvas texture, read or allocate attachments, resize the canvas, notify `onResize` listeners, or submit work. Rendering to the surface — pass draws and bundle replay — stays inside `frame(gpu)` or `frameLoop(gpu)`.

## Examples

```ts
import { init, effect, frame, surface } from "vgpu";

declare const canvas: HTMLCanvasElement;

const gpu = await init();
const canvasSurface = surface(gpu, canvas, { dpr: [1, 2] });
const wave = effect(gpu, `@fragment fn fs_main() -> @location(0) vec4f { return vec4f(0.2, 0.6, 1, 1); }`);

frame(gpu, (currentFrame) => {
  currentFrame.pass({ target: canvasSurface }, (pass) => pass.draw(wave));
});
```

To sample a rendered image — post-processing, feedback, compositing — render it into an offscreen `Target` first, bind that target, and present the result to the surface:

```ts
import { init, effect, frame, sampler, surface, target } from "vgpu";

declare const canvas: HTMLCanvasElement;

const gpu = await init();
const canvasSurface = surface(gpu, canvas);
const sceneTarget = target(gpu, { size: canvasSurface.size }); // offscreen, sampleable, same size as the canvas
const scene = effect(gpu, `
  @fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f { return vec4f(uv, 0.5, 1); }
`);
const present = effect(gpu, `
  @group(0) @binding(0) var sceneTexture: texture_2d<f32>;
  @group(0) @binding(1) var sceneSampler: sampler;
  @fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
    return textureSample(sceneTexture, sceneSampler, uv);
  }
`, { set: { sceneTexture: sceneTarget, sceneSampler: sampler(gpu) } }); // bind the Target, never the Surface

canvasSurface.onResize(({ width, height }) => sceneTarget.resize([width, height])); // the binding follows the new attachment

frame(gpu, (currentFrame) => {
  currentFrame.pass({ target: sceneTarget }, (pass) => pass.draw(scene)); // produce offscreen
  currentFrame.pass({ target: canvasSurface }, (pass) => pass.draw(present)); // present to the canvas
});
```

The surface appears only as a pass `target`. Because `present` binds `sceneTarget` itself, the binding picks up the replacement attachment after every `sceneTarget.resize(...)`; no rebind is needed. Binding `{ sceneTexture: canvasSurface }` instead throws `VGPU-SURFACE-NOT-BINDABLE`.

```ts
import { init, effect, frame, surface, target } from "vgpu/mock";

const gpu = await init();
declare const canvas: HTMLCanvasElement;
const canvasSurface = surface(gpu, canvas);

const bloomSize = (w: number, h: number): [number, number] => [w / 2, h / 2];
const bloom = target(gpu, { size: bloomSize(canvasSurface.size[0], canvasSurface.size[1]) });
const brightPass = effect(gpu, `
  struct Params { resolution: vec2f }
  @group(0) @binding(0) var<uniform> params: Params;
  @fragment fn fs_main() -> @location(0) vec4f { return vec4f(1); }
`, { set: { params: { resolution: bloom.size } } });
const composite = effect(gpu, `@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1); }`);

canvasSurface.onResize(({ width, height }) => {
  bloom.resize(bloomSize(width, height));
  brightPass.set({ params: { resolution: bloom.size } });
});

frame(gpu, (currentFrame) => {
  currentFrame.pass({ target: bloom }, (pass) => pass.draw(brightPass));
  currentFrame.pass({ target: canvasSurface }, (pass) => pass.draw(composite));
});
```

```ts
import { init, effect, frame, surface } from "vgpu";

declare const canvasA: HTMLCanvasElement;
declare const canvasB: HTMLCanvasElement;

const gpu = await init();
const main = surface(gpu, canvasA);
const preview = surface(gpu, canvasB, { autoResize: false, size: [320, 180] });
const shader = effect(gpu, `@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1); }`);

frame(gpu, (currentFrame) => {
  currentFrame.pass({ target: main }, (p) => p.draw(shader));
  currentFrame.pass({ target: preview }, (p) => p.draw(shader));
});
```

```ts
import { init, surface, target } from "vgpu";

declare const offscreen: OffscreenCanvas;
declare function postMessage(message: unknown): void;

const gpu = await init();
const canvasSurface = surface(gpu, offscreen);
const half = target(gpu, { size: [Math.max(1, canvasSurface.size[0] / 2), Math.max(1, canvasSurface.size[1] / 2)] });

canvasSurface.onResize(({ width, height }) => {
  half.resize([width / 2, height / 2]);
  postMessage({ type: "resized", width, height });
});

canvasSurface.resize([640, 360]);
```

Prepare pipelines and bundles for the surface during loading, then render inside the frame loop:

```ts
import { init, bundle, effect, frameLoop, surface } from "vgpu";

declare const canvas: HTMLCanvasElement;

const gpu = await init();
const canvasSurface = surface(gpu, canvas);
const background = effect(gpu, `@fragment fn fs_main() -> @location(0) vec4f { return vec4f(0.1, 0.2, 0.4, 1); }`);

await background.compile(canvasSurface); // outside a frame: reads canvasSurface.format, acquires no canvas texture
const statics = bundle(gpu, { target: canvasSurface }, (recorded) => recorded.draw(background)); // also outside a frame

frameLoop(gpu, (currentFrame) => {
  currentFrame.pass({ target: canvasSurface }, (pass) => pass.bundles(statics)); // replay stays inside the frame
});
```

Resizing the surface changes only its size, so the compiled pipeline and the recorded bundle keep matching its render signature. Normal bundle staleness still applies: a bundle that samples a resized `Target` must be re-recorded.

## Notes

- Use a `Surface` for the swapchain/backbuffer: it is an ephemeral current-frame render target, not a stable reusable or ping-pong intermediate. Use `target(gpu, ...)` for intermediate, reusable, sampleable/readable images; see `Target` for the contrast.
- A surface pass may be the final presentation pass; do not use a surface as a ping-pong resource. For post-processing, render into a `Target`, then sample it in a draw or effect targeting the surface in the same frame.
- Do not bind a surface: `set({ source: canvasSurface })` throws `VGPU-SURFACE-NOT-BINDABLE` in every resource slot (sampled color or depth, storage texture, sampler, buffer). Bind an offscreen `Target` to follow its attachment across resizes, or bind an explicit `Texture` such as `sceneTarget.color` to keep that exact texture until you rebind it.
- `surface.color` is still a `Texture`, but it wraps the canvas's current texture, which the browser replaces after each presentation. Binding it explicitly is not a substitute for an offscreen target: the binding does not follow later frames and is not safe to reuse after the frame presents.
- Prepare against the surface itself once it exists; keep a signature such as `{ colors: [navigator.gpu.getPreferredCanvasFormat()] }` for preparation before `surface(gpu, canvas)` runs. Do not hardcode `bgra8unorm` or `rgba8unorm` for a canvas.
- Layout-backed detection is structural: `typeof canvas.clientWidth === "number"`; it does not use `instanceof`.
- Resize callbacks run in surface creation order at the frame boundary, before the user frame callback.
- Manual `surface.resize()` fires callbacks synchronously at the call site and works for `OffscreenCanvas`.
- `surface.color.read({ mipLevel: 0, region: "all" })` reads the canvas texture current when you call it; vgpu keeps no copy of an earlier presented frame. To read a rendered image back later, render it into a `Target` and read `target.color`. It returns RGBA bytes. Canvas formats `bgra8unorm` and `bgra8unorm-srgb` are supported and swizzled to RGBA, which matters on platforms where `navigator.gpu.getPreferredCanvasFormat()` returns BGRA.
- `surface.color.readFloats({ mipLevel: 0, region: "all" })` returns the same pixels decoded to a `Float32Array` of components (`unorm8` canvas formats normalized to `[0, 1]`); it is the readback to use if a surface is ever configured with a float format.
- A canvas can have only one live surface. Call `surface.dispose()` before creating another one for the same canvas.
- **See also:** `init`, `surface`, `Target`, `Frame`, `Bundle`.
