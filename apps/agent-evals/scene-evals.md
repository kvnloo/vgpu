# Scene evals

Three two-turn tasks that observe whether a coding agent, starting from `npx vgpu`, can build
headless scene renderers with correct hierarchy transforms, custom-shader bindings, and stable
object identity. The harness reruns the submitted source on inputs it chooses and grades the
decoded output on the host.

**It is not a benchmark.** A run is an observation of one agent on one branch. There are no
scores to compare across branches, no rankings, and no statistical claims. Scene-helper adoption,
tool choice, batching, and draw counts are recorded as observations and never gate a run.

The contract revision is `scene-evals-v1` (`SCENE_CONTRACT_REVISION` in
`evals/lib/scene-contracts.mjs`). Any change to case semantics or acceptance thresholds gets a new
revision, and earlier results stay attached to the revision that produced them.

## The tasks

| Task | Turn 1 (construction) | Turn 2 (follow-up) | Frames rerun after turn 2 |
| --- | --- | --- | --- |
| `scene-robot-arm` | Five-part arm; rest and shoulder poses | Parent translation/rotation plus independent elbow/wrist edits | `A, B, C, D, A` |
| `scene-shader-bindings` | Three boxes drawn with the supplied `integration.wgsl` | Absolute camera-position updates | `A, B, A` |
| `scene-warehouse` | 2,304 boxes, color pass and application-ID pass | Persistent delete/move/recolor by `appId` | four frames |

Each task seed contains only `package.json`, `contract.md`, and — for the shader task —
`integration.wgsl`. Seeds contain no renderer, no expected matrices or images, no hidden inputs,
no grader, and no reference-control source.

The construction prompt names `contract.md`, the `node render.mjs` entry point, and ends with
``Use `npx vgpu`.``. Robot and warehouse prompts and seeds name no scene function, import path,
documentation command, GPU plumbing, or strategy. The shader task deliberately supplies its WGSL
interface and requires the file unchanged: that is an integration condition, not a discovery
result. Stage-2 prompts live in `scene-contracts.mjs`. Warehouse operation semantics are
introduced there; the robot pose fields and shader camera convention are already in the
construction contracts.

A second-turn pass establishes correctness on that batch, not necessarily adaptation to a new
requirement. Run the preserved first-turn source against the second-turn inputs before making
an adaptation claim. The [pilot findings](scene-evals-findings.md) record these controls. A future
revision that measures adaptation should reserve a capability absent from the construction
contract and test that the first-turn implementation actually lacks it.

## Running it

Build and pack with Node 22, the repository's pinned version, then launch Eve with Node 24.
Packing builds the repository, so it must not run under the Node version Eve needs.

```bash
# Node 22: build the branch and pack it into .work/tarballs/
fnm exec --using=22 pnpm build
fnm exec --using=22 node apps/agent-evals/scripts/pack-vgpu.mjs --skip-build

# Node 24: one task per process, reusing the checked pack
fnm exec --using=24 node scripts/agent-evals.mjs --task scene-robot-arm --skip-pack \
  --max-concurrency 1 --timeout 1200000 --verbose
```

Run the three tasks serially, one process each. `VERCEL_OIDC_TOKEN` must already be in the
environment from the configured project; see [Model access](#model-access-project-oidc-only).

`--skip-pack` is consumed by the launcher and never forwarded to `eve eval`. Before Eve starts, it
reads `.work/tarballs/tarballs.json` (or `$VGPU_EVALS_TARBALLS_DIR/tarballs.json`), requires its
`sourceKey` to equal the current `sourceKey()` from `scripts/pack-vgpu.mjs`, and requires every
listed tarball to exist as a file beside the manifest. A missing, stale, or incomplete pack exits
with environment code **2**; nothing is rebuilt automatically. Without `--skip-pack` the launcher
packs as it always has.

### Local tests

The `node:test` files make no model calls, no network requests, and no GPU calls:

```bash
fnm exec --using=24 node --test apps/agent-evals/tests/*.test.mjs
fnm exec --using=24 pnpm --filter @vgpu/agent-evals exec tsc --noEmit
```

Root `pnpm test:fast` does **not** run them: `apps/agent-evals` is outside the root Vitest suite,
so run the command above explicitly.

| File | Covers |
| --- | --- |
| `tests/scene-math.test.mjs` | Host matrix composition, projection signs and depth, rotated masks, warehouse operations |
| `tests/grade-scene.test.mjs` | Grader boundaries on synthetic analytic images and state |
| `tests/scene-harness.test.mjs` | Turn/attempt paths, fresh-copy execution, timeouts, cleanup, seed contents |
| `tests/scene-auth.test.mjs` | OIDC guard, rejected API keys, `--skip-pack` consumption and manifest checks |
| `tests/scene-guidance.test.mjs` | [Docs guidance experiment](#docs-guidance-experiment-opt-in): selector and repetition parsing, pinned model/image, corpus restriction on synthetic and the real `a8a9bc8a`/`929b97f5` manifests, baseline tarball isolation and tamper rejection, lock normalization, unchanged default seeds, per-turn deviation records |
| `tests/scene-guidance-analysis.test.mjs` | Delivered guide content versus discovery, per-turn exposure, truncation, event deduplication, usage totals, and possible contamination |

Synthetic images validate grader logic only. They are not native controls.

### Native controls

The control runner executes a real reference implementation and deliberately broken variants
through the host `executeFreshSource` rerun and the production grader, with no model and no judge:

```bash
fnm exec --using=24 node apps/agent-evals/scripts/scene-controls.mjs --task scene-robot-arm --backend host

# Linux/Mesa in the pinned Eve image
export VGPU_EVALS_DOCKER_IMAGE=ghcr.io/vercel/eve@sha256:de79f9a495add7cd1691e3496afc1c3227b0846f9ae0b26126f120c91af3445c
fnm exec --using=24 node apps/agent-evals/scripts/scene-controls.mjs --task scene-robot-arm --backend docker
```

`--task` is required and takes exactly one scene task ID; there is no "all tasks" expansion.
`--backend` is `host` (default) or `docker`; any other value is rejected. One invocation runs the
positive reference at both stages, then every broken control for that task, sequentially.

| Exit | Meaning |
| --- | --- |
| `0` | Every positive passed and every broken control was rejected by its intended class of output check |
| `1` | An unexpected control result |
| `2` | Missing or stale pack, native setup failure, or another infrastructure error |

Each run writes a fresh `.work/scene-controls/<timestamp>-<unique-id>/<task>/` with `summary.json`
(positive and negative verdicts, metric distributions) plus raw source, inputs, outputs, and logs.
A prior calibration is never overwritten. The underlying exit status and reason are preserved in
every case.

| Task | Broken control | Expected rejection |
| --- | --- | --- |
| Robot | Reverse joint multiplication order | Matrix and/or projected geometry on a noncommuting pose |
| Robot | Parent movement not propagated to descendants | Descendant matrices/locations at frame C |
| Robot | Correct CPU matrices, frozen rendered frame | Pixel/tip checks after A; numeric checks still pass |
| Shader | CPU camera recomputed, uniform never uploaded | Matrix/origin checks pass; B image position fails |
| Shader | Previous frame's camera uploaded | A–B–A image checks expose the lag |
| Shader | `gain=1, floor=0` instead of the supplied style | Geometry passes; interior color fails |
| Warehouse | Packed slot used as application identity | Update/remove targets or reported IDs after compaction |
| Warehouse | Initial instance count kept | Deleted/extra geometry or count |
| Warehouse | CPU items updated, no publication after move/recolor | Inventory passes; GPU centers/colors/IDs fail |
| Warehouse | Instance indices encoded as IDs | Complete ID set and per-item IDs |
| Warehouse | Deleted boxes retained | Deleted-cell, ID-set, and count checks |

A broken control must initialize native rendering and produce valid artifacts; a syntax or setup
error is not a useful negative. `summary.json` records which checks rejected each fault, not just
that something failed. These controls validate the executable protocol, fresh-source executor,
native output, and grader; they do not pass through Eve's live sandbox hook. The standalone
harness regressions exercise that hook transport with a faithful fake whose commands return real
exit codes, including failed source copy, manifest, evidence export, and cleanup. Paid pilots are
the end-to-end check of the real Eve transport, exact event correlation, cleanup marker, driver,
and grader together.

## Docs guidance experiment (opt-in)

`VGPU_EVALS_SCENE_GUIDANCE` runs a scene task as one arm of a docs-only comparison: the agent gets
the same runtime and the same pinned `math@0.1.0` in both arms, and only the `vgpu docs` corpus
differs. Leave it unset for ordinary runs — unset or empty changes nothing about packing, seeds,
installs, prompts, or grading.

| Value | Installed `vgpu docs` corpus |
| --- | --- |
| `baseline` | The generated docs manifest from `a8a9bc8a`, before the scene-math guide |
| `math` | The generated docs manifest from `929b97f5`: adds `/guides/scene-math.docs.md` and the "Scope and external math" content in `/guides/scene-composition.docs.md` |

Any other value (including `BASELINE`) exits with environment code **2** before anything is
packed or started, and so does setting it for a non-scene task. Contracts, prompts, seeds, graders,
and thresholds are the `scene-evals-v1` ones in both arms. Experiment runs install `math` and
default runs do not, so never pool the two.

### Launch an arm

Pack exactly as for a default run, then launch each arm in its own process with the fixed model
and the pinned image:

```bash
fnm exec --using=22 pnpm build
fnm exec --using=22 node apps/agent-evals/scripts/pack-vgpu.mjs --skip-build

export VGPU_EVALS_MODEL=anthropic/claude-sonnet-5
export VGPU_EVALS_DOCKER_IMAGE=ghcr.io/vercel/eve@sha256:de79f9a495add7cd1691e3496afc1c3227b0846f9ae0b26126f120c91af3445c
VGPU_EVALS_SCENE_GUIDANCE=baseline fnm exec --using=24 node scripts/agent-evals.mjs \
  --task scene-robot-arm --skip-pack --max-concurrency 1 --timeout 1200000 --verbose
```

Experiment mode refuses to start unless `VGPU_EVALS_MODEL` is exactly `anthropic/claude-sonnet-5`
and `VGPU_EVALS_DOCKER_IMAGE` is exactly that digest; the unset defaults do not count. The check
runs after the [OIDC guard](#model-access-project-oidc-only), exits **2**, and nothing is packed,
fetched, or started. Because `VGPU_EVALS_MODEL` is set, the launcher's 16-token model preflight
also runs.

`VGPU_EVALS_SCENE_REPETITIONS=2` makes the task's eval file export two cases instead of one. Eve
names dataset entries by file plus index (`scene-robot-arm/0000`, `scene-robot-arm/0001`), and
`--task` still selects both. Each case is a fresh session from the same cached template, and
`scene-run.json` records `repetition` as `1` or `2`. Unset or `1` keeps the original single
eval; an empty string or any other value exits **2**. It applies to scene tasks only, with or without
`VGPU_EVALS_SCENE_GUIDANCE`. The frozen 12-slot comparison leaves it unset: each slot is one
standalone Eve invocation, and the lead-owned ledger records the outer repetition.

The completed September 29 comparison is recorded in
[findings](scene-math-evals-findings.md) and [machine-readable results](scene-math-evals-results.json).

The arm label stays on the host. The launcher deletes `VGPU_EVALS_SCENE_GUIDANCE` from its
environment before it spawns Eve, and selects the arm only by pointing `VGPU_EVALS_TARBALLS_DIR` at
that arm's prepared directory. Tarball file names are identical in both arms, so the sandbox sees
the same `/workspace/.vgpu-tarballs/vgpu-0.5.0.tgz` either way.

### Prepared tarball pairs

The launcher builds both arms from the checked pack before Eve starts, after the usual
[`--skip-pack` staleness check](#running-it). You can also prepare or revalidate the pair by hand;
the command prints the path of its `scene-guidance.json`:

```bash
fnm exec --using=24 node apps/agent-evals/scripts/scene-guidance.mjs \
  [--tarballs <pack-dir>] [--out <fixtures-dir>]   # defaults: .work/tarballs, .work/scene-guidance
```

Preparation fails, and the launcher exits **2** with `scene guidance preparation failed`, unless
all of these hold:

- the source pack's `sourceKey` equals the current `sourceKey()`;
- the packed vgpu tarball's `package/dist/cli/lib/generated/docs-manifest.generated.js` is
  byte-identical to `packages/vgpu/lib/generated/docs-manifest.generated.js` at `929b97f5`;
- compared with the same file at `a8a9bc8a`, everything outside `records` is identical, exactly one
  record is added (`/guides/scene-math.docs.md`, symbol `scene-math`, repo path
  `docs/topics/scene-math.docs.md`), none is removed, and exactly one changes
  (`/guides/scene-composition.docs.md`), in its `content` field only. Records are keyed by virtual
  path plus anchor (or symbol when there is no anchor).

Both arms get byte-for-byte copies of every tarball. For `baseline` only, the vgpu tarball is
extracted, that one manifest is replaced with the `a8a9bc8a` bytes, and the tree is re-archived
with `tar` — not `npm pack`, whose `prepack` regenerates the docs. The result is extracted again
and must differ from the packed tree in that one path only, comparing file contents, modes, and symlinks.
Every file in it is then scanned for treatment markers (`/guides/scene-math.docs.md`,
`docs/topics/scene-math.docs.md`, `# Using math with scene data`, `math@0.1.0`); any hit fails.

The pair lands in `.work/scene-guidance/scene-math-guidance-v1-<sourceKey>-<baseline12>-<math12>/`,
named from the source key and the first 12 hex digits of each corpus hash:

| Path | Contents |
| --- | --- |
| `scene-guidance.json` | Experiment, `sourceKey`, `runtimeGitSha`, `baselineGitSha`, `currentDocsGitSha`, dependency, record comparison, per-arm corpus and vgpu tarball hashes |
| `baseline/tarballs/`, `math/tarballs/` | The six tarballs plus a `tarballs.json` that adds a `sha256` to every entry and a `sceneGuidance` block |
| `corpora/baseline-docs-manifest.generated.js`, `corpora/math-docs-manifest.generated.js` | Both corpora's exact bytes |

`sceneGuidance` carries `experiment`, `variant`, `baselineGitSha`, `currentDocsGitSha`,
`runtimeGitSha`, `docsManifestPath`, `docsSha256`, `counterpartDocsSha256`, `dependency`,
`comparison`, and `sourceTarballsManifestSha256`. `sourceKey` is unchanged: both arms run the same
runtime tree.

A fixture directory is written once — built in a staging directory, then renamed into place.
When it already exists, the launcher revalidates it instead of rebuilding: identity and corpus
hashes in `scene-guidance.json`, each arm's label and `math@0.1.0` identity, every tarball's
SHA-256, and the docs manifest hash read back out of the vgpu tarball. A mismatch fails as a tamper
or stale artifact and is never repaired in place; delete that directory to rebuild it. A new pack
or a different corpus gets a new directory.

### Template cache per corpus

The sandbox revalidation key is `vgpu-<sourceKey>-<docsSha256>-<taskId>-<seedHash>`, using the
arm's corpus hash, not its name. The two arms never share a cached template; repetitions of one
arm do. Default runs put `default-corpus` in that position.

### Bootstrap corpus and math checks

In experiment mode only, bootstrap adds `math@0.1.0` to the same `npm install` as the tarballs and
`pngjs`. After both installs and before `vgpu doctor` — so before any model turn — it fails the
template as an infrastructure error unless:

- exactly one `*/dist/cli/lib/generated/docs-manifest.generated.js` exists under `node_modules`;
- that file's SHA-256 equals the arm's `docsSha256`;
- `node_modules/math/package.json` and the lock's `node_modules/math` entry are both `0.1.0`, and
  the locked integrity equals the pinned `sha512-hq5K…` (`SCENE_EXPERIMENT_MATH_INTEGRITY`).

It then writes `.work/template-provenance/<taskId>-<docsSha256>.json`: arm, `sourceKey`, template
key, expected and installed docs hashes, installed manifest paths, `vgpu` and `math` versions, math
integrity, a SHA-256 of `package-lock.json` with the vgpu entry's `resolved`/`integrity` normalized
(equal across arms when only the corpus differs), a SHA-256 of `npm ls --all --json`, model, image,
and sandbox Node. Bootstrap runs once per template, so this file describes the cached build. The
eval rereads it every time it writes `scene-run.json` and stores it as `templateProvenance`, or
`{ "unavailable": true }` when it is missing; outside experiment mode the field is `null`.

### Per-turn provenance and deviations

Before archiving each turn, the `turn.completed` hook reads the installed state again and stores it
as `sceneGuidance` in that attempt's `complete.json`, which `scene-run.json` keeps under each turn's
`complete`:

- `condition`, and `expected` `docsSha256`, `vgpuVersion`, `mathVersion` from the arm's manifest;
- `observed` `docsSha256`, `docsManifestPaths`, `vgpuVersion`, `mathVersion`;
- `protocolDeviation`, plus `observationError` when the read itself failed.

`protocolDeviation` is `true` when there is not exactly one installed docs manifest, its hash
differs from the arm's, or the installed `vgpu` or `math` version differs — for example after the
agent installs `vgpu@latest`. It is observational: it never changes a
gate, a classification, or the run outcome, and the run is kept. Outside experiment mode it is
`null`.

The run-level record adds `repetition`, the arm's `sceneGuidance` block, and `templateProvenance`.
Source hints add `mentionsMathImport`, a regex over source text for a `"math"` or `'math'` string in
every mode; like the other hints, it is not evidence that the package executed.

These records prove which corpus was installed at bootstrap and at the end of each turn. They do not
show a swap and restore inside one turn, and they do not show what the agent read: installed docs
are available, not consumed.

Analyze a saved Eve transcript with:

```bash
node apps/agent-evals/scripts/analyze-scene-guidance.mjs events.ndjson baseline analysis.json
```

Use `math` for the guidance arm. This reports usage, tool counts, and guide markers in returned
tool content, including the turn and step where content first appeared. A title or slug alone
counts as surfaced; registered section headings count as content delivered. Neither proves
understanding. Baseline surfaced-only matches are possible contamination requiring transcript
review. Inspect archived source to determine whether imported math or scene helpers actually run.

## The executable contract

Every submission exposes exactly this command:

```sh
node render.mjs /absolute/input.json /absolute/output-directory
```

The output directory is fresh and empty for every invocation. The program reads all frames,
processes them in order in one process, writes `result.json` and its PNGs into the output
directory, disposes GPU resources, and exits. No server, no browser.

```ts illustrative
type Vec3 = [number, number, number];
type Vec4 = [number, number, number, number];

type RobotFrame = {
  basePosition: Vec3;
  baseAngle: number;
  shoulderAngle: number;
  elbowAngle: number;
  wristAngle: number;
};
type ShaderFrame = { cameraPosition: Vec3 };
type WarehouseItem = { appId: number; position: Vec3; tint: Vec4 };
type WarehouseOperation =
  | { op: "delete"; appId: number }
  | { op: "move"; appId: number; position: Vec3 }
  | { op: "recolor"; appId: number; tint: Vec4 };
type WarehouseFrame = { operations: WarehouseOperation[] };

type Batch<F> = { version: 1; requestId: string; frames: F[] };
type RobotInput = Batch<RobotFrame>;
type ShaderInput = Batch<ShaderFrame>;
type WarehouseInput = Batch<WarehouseFrame> & { items: WarehouseItem[] };

type RobotState = {
  joints: { base: number[]; shoulder: number[]; elbow: number[]; wrist: number[]; tip: number[] };
}; // each matrix: 16 finite column-major numbers, without mesh center/size
type ShaderState = {
  viewProjection: number[]; // 16 finite column-major numbers
  origins: { left: Vec3; right: Vec3; upper: Vec3 };
};
type WarehouseState = { count: number; items: WarehouseItem[] }; // sorted by appId

type BatchOutput<S> = {
  version: 1;
  requestId: string;
  frames: { index: number; color: string; ids?: string; state: S }[];
};
```

- `version`, `requestId`, and the frame count must match the input. Frame `index` values are
  zero-based and in order.
- `color` and `ids` are relative file paths below the output directory. `000-color.png` and
  `000-ids.png` are canonical examples; filenames are not graded. An absolute path or one that
  escapes the directory fails the output contract, and the grader never reads it.
- `ids` is required on every warehouse frame and absent elsewhere.
- PNGs must decode at exactly the task's size with RGBA bytes. Missing, corrupt, and wrong-size
  files fail. Numeric state must be finite and have the documented lengths.
- Every harness input is valid. Agents are not asked to handle malformed input.

All images use offscreen `rgba8unorm`, alpha 255, an opaque black clear, a depth attachment, and
no MSAA, blending, lighting, tone mapping, or rescaling. PNG rows use the normal top-left origin.
Geometry is boxes; colors are exact primary/secondary RGB values. These requirements live in each
seed's `contract.md`, never in the neutral agent instructions.

Transforms use column vectors and column-major matrices. The camera for every task has identity
orientation and orthographic projection with WebGPU depth (`[0, 1]`). A world point projects to
pixel `x = W * (ndcX + 1) / 2`, `y = H * (1 - ndcY) / 2`.

## scene-robot-arm

512×384. Camera position `[0,0,8]`, orthographic `left=-4, right=4, bottom=-3, top=3, near=0.1,
far=20`. Angles are absolute radians about +Z:

```text
base     = T(basePosition) Rz(baseAngle)
shoulder = base T(0,0.35,0) Rz(shoulderAngle)
elbow    = shoulder T(1.5,0,0) Rz(elbowAngle)
wrist    = elbow T(1.1,0,0) Rz(wristAngle)
tip      = wrist T(0.5,0,0)
```

Mesh size and center are separate from the joint transforms:

| Part | Joint | Local center | Dimensions | RGB |
| --- | --- | --- | --- | --- |
| Base | base | `[0,0,0]` | `[0.6,0.5,0.3]` | yellow |
| Upper arm | shoulder | `[0.75,0,0]` | `[1.5,0.22,0.25]` | red |
| Forearm | elbow | `[0.55,0,0]` | `[1.1,0.18,0.2]` | green |
| Tool | wrist | `[0.25,0,0]` | `[0.5,0.24,0.2]` | blue |
| Tip marker | tip | `[0,0,0.2]` | `[0.12,0.12,0.12]` | magenta |

| Frame | `basePosition` | `baseAngle` | `shoulderAngle` | `elbowAngle` | `wristAngle` |
| --- | --- | --- | --- | --- | --- |
| A rest | `[-1.8,-0.7,0]` | 0 | 0 | 0 | 0 |
| B shoulder | `[-1.8,-0.7,0]` | 0 | 0.6 | 0 | 0 |
| C parent | `[-1.4,-0.2,0]` | 0.35 | 0.6 | 0 | 0 |
| D articulated | `[-1.4,-0.2,0]` | 0.35 | 0.6 | -0.85 | 0.25 |
| A return | `[-1.8,-0.7,0]` | 0 | 0 | 0 | 0 |

Turn 1 asks for rest and shoulder posing and reruns `[A, B]`. The follow-up asks for base
translation/rotation and independent elbow/wrist edits while keeping earlier behavior, and reruns
`[A, B, C, D, A]`. Every pose field is an absolute replacement, so the returning A must satisfy
A's expectations independently.

Minimal input and output shape (zero pose, one frame):

```json
{ "version": 1, "requestId": "example", "frames": [
  { "basePosition": [0, 0, 0], "baseAngle": 0, "shoulderAngle": 0, "elbowAngle": 0, "wristAngle": 0 }
] }
```

```json
{ "version": 1, "requestId": "example", "frames": [
  { "index": 0, "color": "000-color.png", "state": { "joints": {
    "base":     [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1],
    "shoulder": [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0.35,0,1],
    "elbow":    [1,0,0,0, 0,1,0,0, 0,0,1,0, 1.5,0.35,0,1],
    "wrist":    [1,0,0,0, 0,1,0,0, 0,0,1,0, 2.6,0.35,0,1],
    "tip":      [1,0,0,0, 0,1,0,0, 0,0,1,0, 3.1,0.35,0,1]
  } } }
] }
```

Nodes, flat hierarchy arrays, and application-owned matrix composition all pass. The transform
path used is recorded separately from correctness.

## scene-shader-bindings

Same size, camera, and projection as the robot. Three axis-aligned boxes of side 0.6:
`left=[-1.5,-0.6,0]` red, `right=[1.3,-0.4,0]` green, `upper=[-0.1,1,0]` blue.

`integration.wgsl` is supplied verbatim: `style` at group 0 / binding 0, `viewState` at group 1 /
binding 0, world matrix columns at vertex locations 2–5, tint at location 6, entry points `vs_main`
and `fs_main`, no imports. The program loads it at runtime, keeps its bytes unchanged, and binds
`style` with `gain=0.75, floor=0.125`. Interior colors are therefore 223 in tint channels of one
and 32 in tint channels of zero.

Turn 1 reruns camera A `[0,0,8]`. The follow-up asks for camera translation with fixed identity
orientation — no retargeting toward the origin — and unchanged object origins, and reruns
`[A, B, A]` with B `[0.8,0.45,8]` in one invocation. Camera position is an absolute replacement.
In frame B every rectangle moves 51.2 px left and 28.8 px down.

```json
{ "version": 1, "requestId": "example", "frames": [ { "cameraPosition": [0, 0, 8] } ] }
```

```json
{ "version": 1, "requestId": "example", "frames": [
  { "index": 0, "color": "000-color.png", "state": {
    "viewProjection": [0.25,0,0,0, 0,0.3333333333,0,0, 0,0,-0.0502512563,0, 0,0,0.3969849246,1],
    "origins": { "left": [-1.5, -0.6, 0], "right": [1.3, -0.4, 0], "upper": [-0.1, 1, 0] }
  } }
] }
```

The camera matrix may come from scene functions or application-owned math. What matters is that
the uploaded binding changes: uniform values are copied, so recomputing a CPU matrix without
refreshing the draw's `viewState` binding leaves the image unchanged and fails the B frame.

## scene-warehouse

576×576. Camera position `[0,0,8]`, orthographic bounds `[-24,24]` on x and y, near 0.1, far 20.
2,304 axis-aligned side-0.6 boxes. For initial index `i = 0..2303`:

```text
appId    = 10001 + 17 * i
row      = floor(i / 48)
column   = i % 48
position = [column - 23.5, 23.5 - row, 0]
tint     = [red, green, blue, cyan, magenta, yellow][i % 6]   (alpha 1)
```

The full item array is always in the input; agents never infer IDs from slots.

Turn 1 reruns frame 1 only. The follow-up discloses sequential, persistent operations addressed by
stable `appId`, and reruns all four frames:

| Frame | Operations | Live items |
| --- | --- | --- |
| 1 | none | 2304 |
| 2 | delete `10290` | 2303 |
| 3 | move `49152` to `[-6.5,23.5,0]`; recolor it cyan | 2303 |
| 4 | delete `26950`; move `49135` to `[13.5,3.5,0]`; recolor it blue; recolor `49152` magenta | 2302 |

The ID pass writes `[id & 255, (id >> 8) & 255, (id >> 16) & 255, 255]` with background
`[0,0,0,255]`. Color and ID passes use the same current geometry and state.

```json
{ "version": 1, "requestId": "example",
  "items": [ { "appId": 10001, "position": [-23.5, 23.5, 0], "tint": [1, 0, 0, 1] } ],
  "frames": [ { "operations": [] } ] }
```

```json
{ "version": 1, "requestId": "example", "frames": [
  { "index": 0, "color": "000-color.png", "ids": "000-ids.png", "state": {
    "count": 1,
    "items": [ { "appId": 10001, "position": [-23.5, 23.5, 0], "tint": [1, 0, 0, 1] } ]
  } }
] }
```

App-owned maps, reordered packing, several instance batches, and rebuilt instance streams all
pass. There is no performance gate and no fixed draw-count gate.

## How a turn is verified

After every completed turn, the `turn.completed` hook in `agent/hooks/finalize-turn.ts` runs these
steps in the live sandbox. They all happen before the next agent turn starts:

1. **Resolve the stage.** The hook requires the event's `turnId` and `meta.id`; if either is
   missing, that is an infrastructure error. The stage is the position of the `turnId` among the
   distinct turns recorded in `turns/order.json`, not a count of hook callbacks. Eve delivers
   hooks at least once, so a retried completion event can arrive for the same `turnId`. It keeps
   that turn's stage and gets a new attempt directory. The stage is recorded before any
   verification runs, so a failed first hook cannot demote the next logical turn to stage 1.
2. **Archive the submission.** The hook tars `/workspace` before any verifier output exists. It
   excludes `node_modules`, `.git`, `.vgpu-tarballs` and `.next`. The tar is written as
   `workspace.tar` plus `workspace.tar.sha256` under the exact turn and event (see
   [Artifacts](#artifacts)). It is also written to the legacy session path.
3. **Copy the source outside `/workspace`.** `/workspace` is copied into
   `/var/tmp/vgpu-scene-<uuid>/app/`, and `/workspace/node_modules` is symlinked into the copy.
   The host-selected `input.json` and an empty `output/` directory sit next to `app/`. Digests of
   `/workspace` taken before and after the run record whether the program wrote there by absolute
   path. That is observed, not prevented.
4. **Probe native health.** A small `vgpu/node` probe clears a 4×4 `rgba8unorm` target and reads
   it back. It runs from `app/` with a 30-second cap and is deleted before the submission runs.
   If the probe fails or times out, the turn is an infrastructure error and `render.mjs` does not
   run.
5. **Run the submission with a time limit.** `node render.mjs <input> <output>` runs with `app/`
   as its working directory. It gets 60 seconds; on timeout the whole process group is killed with
   `SIGKILL`. The hook keeps the exit code, signal, elapsed time, Node version, platform and
   architecture, plus the last 64 KiB of stdout and of stderr.
6. **Export evidence, then clean up.** The following files are packed into `verify.tar` in `/tmp`,
   outside the temporary tree:
   - the output directory;
   - input, probe and execution records;
   - a SHA-256 manifest of the copied source, plus the fixture hash for the shader task;
   - `verdict.json`.

   After packing, the hook removes the temporary tree and checks that it is gone. It copies
   `verify.tar` to the host and deletes the sandbox copy. `complete.json` is the last file
   written. If cleanup or export fails, or the turn is classified as an infrastructure error, the
   hook throws.

Grading runs on the host and holds the expected matrices, masks and verdict. None of these enter
the sandbox. The grader reads only the exported rerun output, never PNGs the agent left in its
workspace.

The source copy leaves out only these top-level directories of `/workspace`:

- `node_modules`
- `.git`
- `.vgpu-tarballs`
- `.agent-evals`
- `.next`
- `.cache`
- `.work`

Everything else is copied, including authored top-level or nested `build/` and `dist/`
directories. Source and assets the program needs at runtime must not live in an excluded root
directory. Address them by paths that survive the copy, for example relative to
`import.meta.url`.

Both the live sandbox copy and the host executor used by controls apply this root-only exclusion
list. The sandbox `tar` copy preserves symbolic links while the host executor skips them, so a
submission must not depend on symlinked source or assets for portable control behavior.

The eval (`evals/lib/scene-eval.ts`) sends both turns in one session with a 20-minute
`timeoutMs`. It grades turn 1 from that exact completion event's archive before sending turn 2,
continues to the follow-up after an ordinary turn-1 correctness failure to observe recovery, and
stops on an infrastructure error. It never falls back to the session's latest export for scene
grading.

## Hard gates

Each check is a labeled `t.check(..., equals(true))`. Robot color coverage is gated per part and
per frame, and robot containment is gated per frame; its aggregate ratios are diagnostic only.
Other checks cover the complete batch as described below. "Non-background" means a pixel that
differs from `[0,0,0]` by more than 2 in any channel.

| Check | Passes when |
| --- | --- |
| `protocol` | `version`, `requestId`, frame count, zero-based ordered `index`, string `color` (and `ids` for warehouse), and an object `state` on every frame |
| `artifacts` | Every image path is relative and stays below the output directory, and decodes at the task's size with a full RGBA buffer |
| `robot-matrices` | All five joint matrices on every frame are 16 finite numbers within `1e-4` of the host reference |
| `robot-pixels` | On every frame, every part has a nonempty expected interior with ≥ 98% RGB matches within ±2, including the tip marker; on every frame ≥ 99% of non-background pixels lie inside the union of silhouettes dilated by 2 px |
| `fixture-file-unmodified` | `integration.wgsl` is byte-identical to the supplied fixture |
| `shader-state` | `viewProjection` within `1e-4` of the host reference and all three origins unchanged within `1e-4`, on every frame |
| `shader-pixels` | ≥ 98% of rectangle-interior pixels match 223/32 within ±2; ≥ 99% of non-background pixels inside the rectangles dilated by 2 px |
| `warehouse-state` | Exact `count`; items sorted by `appId` with exact IDs and positions/tints within `1e-4` of the independently applied operations |
| `warehouse-pixels` | See below |

Robot interiors come from each part's front rectangle projected with the host transforms, at pixel
centers, using true distance to the rotated edges — not an axis-aligned bounding box. A pixel is
expected to show the frontmost raw silhouette covering it, and only when it lies at least 2 px
inside that silhouette's edges. The magenta tip is frontmost by construction, so overlap handling
never removes it; its interior is only about 3–4 px across per frame, so a frame without the
marker fails that frame's tip-part ratio directly.

Shader rectangles are 38.4 × 38.4 px, centered on each origin projected through the frame's
camera, with the same 2 px interior band.

`warehouse-pixels` fails if any of these hold on any frame:

- an ID-image pixel carries an ID that is not live, including deleted IDs;
- an ID pixel's color-image pixel differs from that item's tint by more than 2, or the pixel lies
  more than 4.6 px from the item's projected center on either axis (the 7.2 px box dilated by 1 px);
- an ID-zero pixel is not black in the color image, which covers deleted and vacated cells;
- the set of nonzero IDs in the image differs from the live set;
- a live ID covers fewer than 40 or more than 81 pixels;
- the 3×3 neighborhood at an item's projected center lacks the exact ID or its color within ±2.

The host reference math in `evals/lib/scene-math.mjs` is scalar code independent of `vgpu/scene`,
of the reference control, and of anything the submission reports. Numeric state proves nothing
about the image and the image proves nothing about the state: each is graded against the host
reference separately, so correct CPU matrices paired with a stale image fail, and so does the
reverse.

## Observations (never gated)

Recorded per turn for the lead's review, never a pass/fail input:

- the transform path actually used (scene hierarchy, flat arrays, hand-written matrices);
- scene API adoption, binding refresh strategy, stable-ID handling, batching;
- observed rendering and readback calls in the source;
- commands run and docs usage, from `bashCalls`/`docsUsage` in `evals/lib/transcript.ts`;
- draw counts, recorded as unknown when the evidence does not show them.

An import, or prose saying an API was used, is not evidence that it executed. A valid alternative
implementation passes the hard gates, and gating adoption would reward ritual rather than working
output. The automated source fields are regex-derived source hints only; semantic lead review
separately determines whether a shader was actually loaded and bindings or scene APIs were used.

## Outcome classifications

| Outcome | Examples |
| --- | --- |
| `pass` | The rerun exited 0 within 60 s and every hard gate passed |
| `application-failure` | Missing `render.mjs`, nonzero exit, timeout, wrong or missing JSON, corrupt/wrong-size PNGs, an escaping output path, any failed gate — all in a healthy environment |
| `infrastructure-error` | Missing archive or identifiers, sandbox transport/setup failure, failed native health probe, doctor/startup failure, cleanup failure, an oracle bug |

A failure the evidence cannot attribute stays explicitly unclassified pending lead inspection; it
is never silently blamed on the model. The host verdict is authoritative.

## Artifacts

All raw evidence is ignored by git and stays under `apps/agent-evals/.work/` and Eve's `.eve/`:

| Path | Contents |
| --- | --- |
| `.work/tarballs/tarballs.json` | Pack manifest: `sourceKey`, git SHA/branch, tarball list |
| `.work/snapshots/<sessionId>/workspace.tar` | Legacy latest-turn export, still written for older task readers |
| `.work/snapshots/<sessionId>/turns/order.json` | First-seen `turnId`s in order; defines the stage |
| `.work/snapshots/<sessionId>/turns/<turnId>/<eventId>/workspace.tar` | Immutable submission for one completion attempt, plus `workspace.tar.sha256` |
| `.work/snapshots/<sessionId>/turns/<turnId>/<eventId>/verify.tar` | Rerun input, probe and execution records, `output/` (`result.json` and PNGs), source manifest, fixture hash, `verdict.json` |
| `.work/snapshots/<sessionId>/turns/<turnId>/<eventId>/complete.json` | Stage, IDs, input hash, classification, cleanup/export status; written last |
| `.work/scene-controls/<timestamp>-<unique-id>/<task>/summary.json` | One native control run |

`turnId` and `eventId` are URL-encoded into path segments.

The sandbox verdict records these fields:

- task, stage, turn ID and event `meta.id`;
- the SHA-256 of the input;
- the command, working directory and timeout;
- the probe and execution records;
- the host runtime and the sandbox runtime;
- the source-copy exclusions;
- whether a `/workspace` mutation was observed;
- its stated limitations.

The host-side grade adds:

- the contract revision;
- commit, `sourceKey` and tarball hashes;
- the model slug;
- the Eve version;
- the Docker image digest where available;
- raw check measurements.

Provider usage that Eve did not report is marked unavailable, never estimated.

Scene readers use only exact `turnId`/`eventId` coordinates. The legacy session path exists so
existing tasks keep working; scene grading never reads it.

## Budgets

- **60 seconds** per `render.mjs` invocation, including killing a hung child.
- **20 minutes** per task run (`timeoutMs: 1200000`, `--timeout 1200000`).
- The OIDC token must have at least **25 minutes** left: the 20-minute run plus 5 minutes of setup.

## Model access: project OIDC only

Scene tasks accept exactly one credential: a `VERCEL_OIDC_TOKEN` from the configured Vercel project,
routed through AI Gateway. The guard in `agent/lib/scene-auth.mjs` runs in the launcher before the
explicit-model preflight and before packing, and again in the scene driver before the first
`t.send`, so a direct `eve eval` is covered too. It fails when:

- any of `AI_GATEWAY_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, or
  `GOOGLE_GENERATIVE_AI_API_KEY` is set — alone or alongside the OIDC token;
- `VERCEL_OIDC_TOKEN` is absent, not a three-segment JWT, or has no numeric `exp`;
- fewer than 25 minutes remain before `exp`.

A failure is an environment error; a scene run does not skip silently for lack of a token. The
guard only decodes the expiry locally: it makes no request, validates no signature, never prints
the token, and never refreshes or rewrites credentials. If your shell or `.env.local` contains a
competing key, run from an environment that holds only the project token. Scene evals add no judge
calls; any later optional judge must use the same OIDC path and stay observational.

Other tasks keep their existing routing.

## Trust model and limits

Scene grading assumes a **non-adversarial** agent. The rerun and the source copy remove two failure
modes of earlier tasks — grading a file the agent left behind, and grading output from the
agent's own working directory — but verification still executes inside the container the agent
had root in for its whole turn, with its installed dependencies. See
[Trust model](README.md#trust-model-v0) for why no in-container gate is proof against an agent
optimizing to pass.

Rereading a produced PNG and checking its geometry does not prove GPU provenance or use of scene
APIs. A CPU-painted image, pixels uploaded to a texture, or an unused import cannot be ruled out
by these checks. There is no runtime module tracing, readback preload, or prototype wrapping in
this revision. The lead's source and transcript review is what distinguishes a correct
alternative implementation from a bypass or an unsupported claim; bypass and unknown are recorded
separately from correctness, and adoption never becomes a gate.

The rerun also trusts the sandbox's installed dependency tree. Missing dependencies are reported
in the native-health reason, but deliberate dependency tampering is not attributed or prevented.
The source-copy boundary does not harden symlink targets or prevent absolute writes; symlink/path
behavior and `/workspace` mutation are retained as limitations and evidence for lead review.

Native controls demonstrate that correct GPU output passes and that each named fault is caught on
a given environment. They do not attest to anything a submission did.
