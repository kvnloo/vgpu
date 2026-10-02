import {
  frame,
  frameLoop,
  type Frame,
  type FrameLoopCallback,
  type FrameRunner,
  type Gpu,
} from "../src/index.ts";

declare const gpu: Gpu;
declare const runner: FrameRunner;
declare const promiseLikeCallback: (currentFrame: Frame) => PromiseLike<void>;

function syncVoid(_currentFrame: Frame): void {}
function syncValue(_currentFrame: Frame): number { return 1; }
function syncNever(_currentFrame: Frame): never { throw new Error("stop"); }
async function asyncNamed(_currentFrame: Frame): Promise<void> {}
function erasedAny(_currentFrame: Frame): any { return undefined; }
function maybeAsync(_currentFrame: Frame): void | Promise<void> {
  return Math.random() > 0.5 ? undefined : Promise.resolve();
}

// Manual forms and synchronous block, void, expression, value, and throwing callbacks stay valid.
frame(gpu);
frame(gpu, undefined);
frame(gpu, () => {});
frame(gpu, syncVoid);
frame(gpu, syncValue);
frame(gpu, syncNever);
frame(gpu, () => 1);
frameLoop(gpu, syncVoid);
frameLoop(gpu, syncValue);
frameLoop(gpu, syncNever);
runner.frame();
runner.frame(undefined);
runner.frame(syncVoid);
runner.frame(syncValue);
runner.frame(syncNever);
runner.loop(syncVoid);
runner.loop(syncValue);
runner.loop(syncNever);

// An explicitly erased `any` return supplies no static proof of a thenable. Runtime validation
// remains responsible for the actual value.
frame(gpu, erasedAny);
frameLoop(gpu, erasedAny);
runner.frame(erasedAny);
runner.loop(erasedAny);

// The existing exported callback alias remains source-compatible.
const exportedCallback: FrameLoopCallback = syncVoid;
frameLoop(gpu, exportedCallback);
runner.loop(exportedCallback);

// Promise and PromiseLike returns, including unions, are rejected while their return types remain
// visible to inference.
// @ts-expect-error frame callbacks cannot return a Promise
frame(gpu, async () => {});
// @ts-expect-error named Promise-returning frame callbacks are rejected
frame(gpu, asyncNamed);
// @ts-expect-error PromiseLike-returning frame callbacks are rejected
frame(gpu, promiseLikeCallback);
// @ts-expect-error unions containing a Promise are rejected
frame(gpu, maybeAsync);
// @ts-expect-error frameLoop callbacks cannot return a Promise
frameLoop(gpu, async () => {});
// @ts-expect-error named Promise-returning frameLoop callbacks are rejected
frameLoop(gpu, asyncNamed);
// @ts-expect-error frameLoop rejects PromiseLike callbacks
frameLoop(gpu, promiseLikeCallback);
// @ts-expect-error frameLoop rejects unions containing a Promise
frameLoop(gpu, maybeAsync);
// @ts-expect-error inline async FrameRunner.frame callbacks cannot widen to any
runner.frame(async () => {});
// @ts-expect-error FrameRunner.frame callbacks cannot return a Promise
runner.frame(asyncNamed);
// @ts-expect-error FrameRunner.frame rejects PromiseLike callbacks
runner.frame(promiseLikeCallback);
// @ts-expect-error FrameRunner.frame rejects unions containing a Promise
runner.frame(maybeAsync);
// @ts-expect-error inline async FrameRunner.loop callbacks cannot widen to any
runner.loop(async () => {});
// @ts-expect-error FrameRunner.loop callbacks cannot return a Promise
runner.loop(asyncNamed);
// @ts-expect-error FrameRunner.loop rejects PromiseLike callbacks
runner.loop(promiseLikeCallback);
// @ts-expect-error FrameRunner.loop rejects unions containing a Promise
runner.loop(maybeAsync);

// Return types already erased by assignment or a wrapper cannot be recovered by TypeScript. These
// remain accepted at compile time and are rejected by the runtime thenable defense.
const erasedVoid: FrameLoopCallback = async () => {};
const erasedUnknown: (currentFrame: Frame) => unknown = async () => {};
const erasedAnyThenable: (currentFrame: Frame) => any = async () => {};
function eraseReturn<R>(callback: (currentFrame: Frame) => R): (currentFrame: Frame) => unknown {
  return callback;
}
const erasedByWrapper = eraseReturn(asyncNamed);

frame(gpu, erasedVoid);
frame(gpu, erasedUnknown);
frame(gpu, erasedByWrapper);
frame(gpu, erasedAnyThenable);
frameLoop(gpu, erasedVoid);
frameLoop(gpu, erasedUnknown);
frameLoop(gpu, erasedAnyThenable);
runner.frame(erasedVoid);
runner.frame(erasedUnknown);
runner.frame(erasedAnyThenable);
runner.loop(erasedVoid);
runner.loop(erasedByWrapper);
runner.loop(erasedAnyThenable);
