# Gpu

The main API (`vgpu`) context returned by `init()`. It owns device lifetime and the frame clock; every resource — canvas surfaces, offscreen targets, render, compute, storage, uniforms, samplers, and bundles — is created by a free function that takes the `Gpu` as its first argument.

## Import

```ts
import type { Gpu } from "vgpu";
import { init } from "vgpu/mock";
```

## Signature

```ts
import type { Bundle, BundleOptions, BundleRecorder, Clock, Compute, ComputeOptions, Draw, DrawOptions, Effect, EffectOptions, Frame, FrameLoopHandle, FrameLoopOptions, Geometry, GeometryOptions, GeometryRecipe, GpuErrorListener, PingPongStorage, PingPongTargets, SharedUniforms, StorageAccess, StorageBuffer, StorageOptions, Surface, SurfaceOptions, Target, TargetOptions, TargetTextureOptions, Texture, TextureOptions, Timer, Visibility, VisibilityOptions } from "vgpu";
import type { Device } from "vgpu/core";
import type { ShaderSource } from "vgpu";

interface Gpu {
  readonly device: Device;
  readonly gpu: GPUDevice;
  /** True once `dispose()` ran. Reads stay legal; new work does not. */
  readonly disposed: boolean;
  dispose(): void;
  onError(cb: GpuErrorListener): () => void;
  /** Resolves once the queue work, error deliveries, and in-flight sources captured at call time complete. Never rejects; not a success signal. */
  settled(): Promise<void>;
}

// The creation API: named exports of `vgpu`, `vgpu/node` and `vgpu/mock`, all gpu-first.
declare function surface(gpu: Gpu, canvas: HTMLCanvasElement | OffscreenCanvas, opts?: SurfaceOptions): Surface;
declare function effect(gpu: Gpu, source: string | ShaderSource, opts?: EffectOptions): Effect;
declare function draw(gpu: Gpu, opts: DrawOptions): Draw;
declare function target(gpu: Gpu, opts: TargetOptions): Target;
declare function texture(gpu: Gpu, opts: TextureOptions): Texture;
declare function frame(gpu: Gpu, cb?: (frame: Frame) => void): Frame;
declare function frameLoop(gpu: Gpu, cb: (frame: Frame) => void, opts?: FrameLoopOptions): FrameLoopHandle;
declare function sampler(gpu: Gpu, desc?: GPUSamplerDescriptor): GPUSampler;
declare function geometry(gpu: Gpu, input: GeometryOptions | GeometryRecipe): Geometry;
declare function compute(gpu: Gpu, source: string | ShaderSource, opts?: ComputeOptions): Compute;
declare function storage(gpu: Gpu, bytes: number, access?: StorageAccess | StorageOptions): StorageBuffer;
declare function timer(gpu: Gpu): Timer;
declare function visibility(gpu: Gpu, options?: VisibilityOptions): Visibility;
declare function pingPong(gpu: Gpu, width: number, height: number, opts?: TargetTextureOptions): PingPongTargets;
declare function pingPongStorage(gpu: Gpu, bytes: number): PingPongStorage;
declare function uniforms<T extends Record<string, unknown>>(gpu: Gpu, values: T): SharedUniforms<T>;
declare function bundle(gpu: Gpu, opts: BundleOptions, record: (recorder: BundleRecorder) => void): Bundle;
declare function clock(gpu: Gpu): Clock;
```

## Parameters

`Gpu` is an object, not a callable constructor: it carries no creation methods. Every factory below takes it as `gpu`, its first argument.

| Param | Type | Required | Default | Notes |
|---|---|---:|---|---|
| surface.canvas | `HTMLCanvasElement \| OffscreenCanvas` | ✔ | — | Canvas-like object with a `webgpu` context. A canvas may have one live `Surface`. |
| surface.opts | `SurfaceOptions` | ✖ | `{}` | Per-surface canvas format, size, DPR, and auto-resize behavior. |
| effect.source | `string \| ShaderSource` | ✔ | — | WGSL string or loader-produced `ShaderSource { version: 1, wgsl }`. |
| effect.opts | `EffectOptions` | ✖ | `{}` | `label` defaults to `"effect"`; `set` defaults to no initial bindings. |
| draw.opts | `DrawOptions` | ✔ | — | Includes required `shader`; see `DrawOptions`. |
| target.opts | `TargetOptions` | ✔ | — | Offscreen target options. `size` is required. |
| texture.opts | `TextureOptions` | ✔ | — | Standalone sampled/storage texture. `size` and `format` are required; usage defaults to sampled, storage, and copy usage. |
| frame.cb | `(frame: Frame) => void` | ✖ | `undefined` | If provided, submits when the callback returns and cancels (submits nothing) when it throws; if omitted, caller must call `frame.submit()` or `frame.cancel()`. |
| sampler.desc | `GPUSamplerDescriptor` | ✖ | `undefined` | Cached by descriptor. `sampler(gpu)` is the canonical default sampler. |
| geometry.input | `GeometryOptions \\| GeometryRecipe` | ✔ | — | A raw buffer descriptor, or a `vgpu/scene` recipe such as `box()` or `plane()`. |
| compute.source | `string \| ShaderSource` | ✔ | — | WGSL string or `ShaderSource`. Must contain a `@compute` entry point. |
| compute.opts | `ComputeOptions` | ✖ | `{}` | `label` defaults to `"compute"`; `set` defaults to no initial bindings. |
| storage.bytes | `number` | ✔ | — | Byte size for a main API (`vgpu`) storage buffer. |
| storage.access | `StorageAccess \| StorageOptions` | ✖ | `"read-write"` | Access string, or a `StorageOptions` bag `{ access?, indirect? }`. See `Compute` for storage buffer semantics, including `{ indirect: true }` for GPU-driven draw/dispatch arguments. |
| timer | — | — | — | No parameters. GPU pass timing; needs the `"timestamp-query"` device feature. See `Timer` for feature gating, spans, and result delivery. |
| visibility.options | `VisibilityOptions` | ✖ | `{}` | Occlusion queries for visibility culling — core WebGPU, no device feature required. See `Visibility` for capacity and handle semantics. |
| pingPong.width | `number` | ✔ | — | Floored and clamped to at least `1`. |
| pingPong.height | `number` | ✔ | — | Floored and clamped to at least `1`. |
| pingPong.opts | `TargetTextureOptions` | ✖ | `{}` | Texture/attachment options only; size comes from positional width/height. |
| pingPongStorage.bytes | `number` | ✔ | — | Creates two `"read-write"` storage buffers. |
| uniforms.values | `Record<string, unknown>` | ✔ | — | Cloned initial JS values; WGSL layout is adopted when first bound. |
| bundle.opts | `BundleOptions` | ✔ | — | Requires a `target` or target signature. |
| bundle.cb | `(recorder: BundleRecorder) => void` | ✔ | — | Records bundle commands immediately. |
| onError.cb | `GpuErrorListener` | ✔ | — | Receives asynchronous vgpu errors; returns an unsubscribe function. |
| clock | — | — | — | No parameters. The frame clock of this gpu: `{ time, deltaTime, frameCount, advance(dtSeconds) }`, one instance per gpu. See `Clock`. |

**Returns:** each factory returns the resource named in its signature. `dispose()` and frame/pass callbacks return `void`. `onError(cb)` returns its unsubscribe function. `settled()` returns a `Promise<void>` that always fulfills — see "Wait for submitted work" below.

**Throws:** `VGPU-GPU-DISPOSED` when any factory (or `clock(gpu)`) runs after `gpu.dispose()` — the device and everything it owned are gone, so the handle it would return could only fail later; create resources before disposing, or `init()` a new gpu; `VGPU-GPU-FOREIGN` when the first argument was not created by `init()` (a plain object, a `GPUDevice`, a gpu from another library): it carries no vgpu kernel, so pass the object returned by `init()` from `vgpu`, `vgpu/node` or `vgpu/mock`; `VGPU-LIMIT-STORAGE-VERTEX` / `VGPU-LIMIT-STORAGE-FRAGMENT` when a selected render entry exceeds its granted storage-buffer limit. The structured detail reports `stage`, `entryPoint`, `count`, `limit`, and each counted binding's `name`, `group`, and `binding`; request a supported limit or reduce/move the data; `VGPU-SHADER-SOURCE-INVALID` for malformed `ShaderSource`; `VGPU-SET-VALUE-INVALID` when a JS-owned buffer value does not exactly match its reflected WGSL shape, integer range, or runtime extent; `VGPU-SET-TEXTURE-FILTERABILITY` when a known facade texture format cannot satisfy an ordinarily sampled float binding (detail reports format, texture binding/name/label, and paired sampler identity); `VGPU-RING1-UNSUPPORTED` for unsupported effect/compute/target cases; `VGPU-TARGET-REQUIRED` when one-shot drawing needs an explicit target; `VGPU-TARGET-SIZE-REQUIRED` for runtime JS calls to `target(gpu)` without `size`; `VGPU-SURFACE-*` errors from `surface()`, surface resize, surface readback, or using disposed surfaces; plus method-specific `VGPU-R1-*`, `VGPU-R3-*`, and `VGPU-R4-*` errors documented on `Effect`, `Draw`, `Compute`, `Frame`, `Bundle`, `Target`, and `SharedUniforms`.

## Examples

```ts
import { init, draw, frame, target } from "vgpu/mock";

const gpu = await init();
const colorTarget = target(gpu, { size: [128, 128], depth: true });
const drawable = draw(gpu, {
  shader: `
    @vertex fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
      var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
      return vec4f(p[vi], 0, 1);
    }
    @fragment fn fs_main() -> @location(0) vec4f { return vec4f(1, 0, 1, 1); }
  `,
  // optional sync pre-warm; `await draw.compile(target)` is preferred during browser load
  targets: [colorTarget],
});

frame(gpu, (currentFrame) => {
  currentFrame.pass({ target: colorTarget, clear: [0, 0, 0, 1] }, (pass) => pass.draw(drawable));
});
```

```ts
import { init, effect, frameLoop, surface } from "vgpu";

declare const canvas: HTMLCanvasElement;

const gpu = await init();
const canvasSurface = surface(gpu, canvas, { dpr: [1, 2] });
const wave = effect(gpu, `@fragment fn fs_main() -> @location(0) vec4f { return vec4f(0.2, 0.4, 1.0, 1.0); }`);

frameLoop(gpu, (frame) => {
  frame.pass({ target: canvasSurface }, (pass) => pass.draw(wave));
});
```

## Error delivery

`gpu.onError(cb)` subscribes to asynchronous vgpu errors and returns an unsubscribe function. Listeners run in subscription order; removing one stops future deliveries; a throwing listener is reported to `console.error` without stopping the rest. If no listener is registered, vgpu reports the error to `console.error` by default.

`gpu.settled()` resolves after the work captured when you call it completes: GPU queue work already submitted, pending error deliveries, and in-flight pipeline work. This includes compute compilation and native compute validation through error delivery, so `onError` listeners for those failures have already run when it fulfills. It never rejects, so it is safe for deterministic tests and teardown. It is not a successful-execution assertion: await a pipeline’s `compile()` to handle compilation rejection and subscribe to `onError` for asynchronous execution failures.

## Wait for submitted work

`settled()` takes a snapshot synchronously, before it awaits anything, and waits for exactly that snapshot:

- **Submitted queue work.** While the gpu is active, the call captures a WebGPU `queue.onSubmittedWorkDone()` fence. It covers everything already submitted to the device queue: `frame(gpu, cb)` callbacks that returned, `frame.submit()`, one-shot `drawable.draw(target)` and `compute.dispatch()` calls, and raw `gpu.gpu.queue.submit()` calls on the same queue.
- **Pending error deliveries** queued for `onError`.
- **In-flight sources** tracked by vgpu at call time, such as pipeline compilation and native validation. Errors these sources report through `onError` are delivered before the call fulfills.

Work that starts after the call returns does not extend it: later submissions, new pipelines, and deliveries unrelated to the captured sources belong to the next `settled()` call. A manual `frame(gpu)` that is still open — not yet submitted or cancelled — is not queue work, so `settled()` neither waits for it nor submits it.

```ts
import { init, draw, target } from "vgpu/mock";

const gpu = await init();
const colorTarget = target(gpu, { size: [64, 64] });
const triangle = draw(gpu, {
  shader: `
    @vertex fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
      var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
      return vec4f(p[vi], 0, 1);
    }
    @fragment fn fs_main() -> @location(0) vec4f { return vec4f(1, 0.5, 0, 1); }
  `,
});

// ---cut---
triangle.draw(colorTarget); // one-shot draw: encodes and submits immediately
const drawDone = gpu.settled(); // captures the queue fence for that submission now
triangle.draw(colorTarget); // submitted after the call — not part of drawDone
await drawDone;
```

`drawDone` fulfills once the first submission completes on the GPU. The second draw is outside its snapshot; call `settled()` again to wait for it.

Because `settled()` waits for the GPU to finish queued work, it can take as long as that work takes — longer than awaiting deliveries and pipelines alone. Fulfillment means completion, not success: a failed submission, an invalid pipeline, or a lost device still fulfills it, and failures stay on their existing channels.

- `settled()` never rejects and never reports an error of its own. When the queue has no `onSubmittedWorkDone()` method (some mocks), the method throws synchronously, or its promise rejects, `settled()` skips that fence and still fulfills — `onError` receives nothing extra.
- A pipeline's `compile()` rejection stays on that `compile()` promise. `settled()` waits for the compilation without turning its rejection into an `onError` delivery; handle rejection on the `compile()` promise itself.
- Asynchronous execution and validation failures arrive once, through `onError`, whether or not you await `settled()`.

### After device loss or `dispose()`

When vgpu has already observed device loss, or `gpu.dispose()` already ran, `settled()` creates no new queue fence: there is no usable queue to wait on. It still waits for the deliveries and sources vgpu is tracking at that moment. `dispose()` stops tracking in-flight pipeline compilations as part of normal teardown, so after `dispose()` the call waits only for deliveries that were already pending.

Loss or disposal that happens after the call does not shorten it: a fence and sources already captured keep their wait. `settled()` does not wait for device loss, and it does not restart or recover a lost device.

### Choose compile, settled, or readback

Await only the promise that answers your question:

| You need | Await | What it waits for |
|---|---|---|
| A pipeline ready before its first frame, or its compilation failure as a rejection | `drawable.compile(target)`, `fullscreenEffect.compile(target)`, `simulation.compile()` | That one pipeline. Rejects on compilation failure. |
| The pixels or bytes a GPU pass produced | `colorTarget.color.read({ mipLevel: 0, region: "all" })`, `colorTarget.color.readFloats({ mipLevel: 0, region: "all" })`, `particles.read()` on a `StorageBuffer` | The copy it issues, which runs after the work that wrote the resource. |
| Submitted queue work and tracked asynchronous work to finish: before assertions on `onError`, between tests, before teardown | `gpu.settled()` | The call-time snapshot above. Never rejects. |

If you only need pixels or bytes, await the readback directly: its copy is ordered after earlier queue work. Await `settled()` separately when you also need its tracked error deliveries or pipeline work. Keep these waits outside frame callbacks; waiting after every frame serializes encoding with GPU completion and reduces the overlap between CPU encoding and GPU execution.

### Teardown

Subscribe to `onError` for asynchronous failures, await `compile()` for compilation failures, then `await gpu.settled()` before `gpu.dispose()` so submitted work and pending deliveries finish first:

```ts
import { init, effect, frame, target } from "vgpu/mock";

const gpu = await init();
const errors: string[] = [];
gpu.onError((error) => errors.push(error.code)); // asynchronous failures arrive here, once

const colorTarget = target(gpu, { size: [64, 64] });
const tint = await effect(gpu, `@fragment fn fs_main() -> @location(0) vec4f { return vec4f(0.2, 0.4, 1.0, 1.0); }`).compile(colorTarget); // compilation failures reject here

frame(gpu, (currentFrame) => {
  currentFrame.pass({ target: colorTarget, clear: [0, 0, 0, 1] }, (pass) => pass.draw(tint));
});

await gpu.settled(); // the submitted frame and pending deliveries have completed
console.log(errors); // every error reported for that work has been delivered
gpu.dispose();
```

`settled()` fulfills even if the frame failed; read `errors` to find out. `dispose()` is the teardown signal — it stops loops and releases resources; do not wait for device loss to tear down a gpu you own. For a gpu from `initFromDevice(device)`, `dispose()` releases the vgpu wrapper and leaves the borrowed device to its owner.

## Notes

- There is no implicit screen property and no implicit default target. Pass `target` explicitly to frame passes and one-shot draws.
- Canvas-specific `size`, `dpr`, and `autoResize` live on `surface(gpu, canvas, opts)`, not on `init()`.
- Time is explicit JS state, and it lives on the clock, not on the context: read `clock(gpu).time` / `.deltaTime` / `.frameCount` and pass them through `set()` or `SharedUniforms` when shaders need them.
- Every factory rejects a disposed gpu with `VGPU-GPU-DISPOSED`, and an object vgpu did not create with `VGPU-GPU-FOREIGN`. Both are thrown synchronously, from the call that made the mistake.
- **See also:** `init`, `Clock`, `Surface`, `Effect`, `Draw`, `Compute`, `Frame`, `Target`, `Bundle`, `SharedUniforms`, `Timer`, `Visibility`.

## Sampled float texture layouts

vgpu infers sampled-texture layouts per selected WGSL entry point. A non-multisampled `texture_*<f32>` used by `textureSample*` or `textureGather*` with an ordinary sampler receives WebGPU `sampleType: "float"`; a texture used only by `textureLoad` remains `"unfilterable-float"`. Calls through helper functions are included.

The WGSL `f32` scalar type does not make every concrete texture format filterable. In particular, `r32float`, `rg32float`, and `rgba32float` require the device's `float32-filterable` feature for ordinary sampling. Use a filterable format, request that feature when supported, or use `textureLoad` without a sampler.
