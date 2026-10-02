---
"vgpu": minor
---

## Summary

Reject async and thenable `frame` / `frameLoop` callbacks before their frame is implicitly submitted. Inferred Promise and PromiseLike returns are rejected by the public types, while runtime checks protect JavaScript and callbacks whose return type was erased.

## Migration

### Affected usage

Update callbacks passed to `frame`, `frameLoop`, or the equivalent `FrameRunner` methods when they are `async`, return a Promise/PromiseLike, or have a union return type containing one. Callbacks already typed as `void`, `unknown`, or `any` can still compile because those erased types supply no static proof, but now fail at runtime if their actual result is thenable. Synchronous helpers need no rewrite.

### Steps

Await asynchronous preparation before calling `frame` or registering `frameLoop`, then keep all frame encoding synchronous. Move asynchronous teardown outside the callback. Do not hide frame-touching async continuations behind `void`, a cast, or a return-type-erasing wrapper: the frame is canceled when the thenable is detected, so later encoding through that frame fails with `VGPU-FRAME-CANCELED`.

Work explicitly submitted before an invalid callback result remains submitted, and CPU-side async continuation effects are not rolled back.

### Verification

Typecheck the affected calls and confirm Promise/PromiseLike callback returns are rejected. For runtime-erased cases, confirm `VGPU-ASYNC-FRAME-CALLBACK`, zero implicit submissions for the canceled frame, and one stopped tick for an offending loop callback.
