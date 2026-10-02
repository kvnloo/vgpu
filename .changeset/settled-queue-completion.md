---
"vgpu": patch
---

## Summary

`gpu.settled()` now includes queue work already submitted when it is called while retaining resolve-only and existing error-delivery semantics. Fulfillment can take longer and remains a completion signal, not a successful-execution guarantee.

## Migration

None: Call signatures and error channels are unchanged; `settled()` now waits for the queue work already submitted when called, and already-lost/disposed wrappers retain their existing tracked waits without creating a new fence.
