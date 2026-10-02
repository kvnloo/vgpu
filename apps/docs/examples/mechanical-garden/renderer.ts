import GUI, { type Controller } from "lil-gui";
import type { Vec3 } from "math";
import { clock, frameLoop, surface, type Gpu, type Surface } from "vgpu";
import { orbitRig, smoothRig, type OrbitRig } from "vgpu/scene";

import { applyView, cameraRay, followRobot, VIEWS } from "./camera";
import {
  advance,
  clearDestination,
  createColony,
  DEFAULT_PRESET,
  DEFAULT_SEED,
  FIXED_DT,
  MAX_ROBOTS,
  PRESETS,
  readStats,
  reset,
  setCount,
  setDestination,
  setPreset,
  step,
  type Colony,
  type ColonyStats,
  type PresetName,
} from "./colony";
import { installInput, TOOLS, type GardenInput, type Tool } from "./input";
import { createPipeline, type BrushOverlay, type GardenPipeline } from "./pipeline";
import { BRUSH_RADIUS, BRUSH_STRENGTH, HALF, raycast } from "./terrain";

interface RendererOptions {
  readonly canvas: HTMLCanvasElement;
  readonly container?: HTMLElement;
}

export interface Settings {
  preset: PresetName;
  robots: number;
  seed: number;
  paused: boolean;
  pace: number;
  tool: Tool;
  radius: number;
  strength: number;
  cursorX: number;
  cursorZ: number;
  follow: boolean;
  autoOrbit: boolean;
  debug: boolean;
}

const IDLE_ORBIT_SPEED = 0.05;
const CAMERA_TIME_CONSTANT = 0.12;
const NARROW_WIDTH = 640;
const SHORT_HEIGHT = 560;
const GUI_WIDTH = 236;
/**
 * A GUI "raise/lower at cursor" press sculpts for this many fixed simulation steps (0.5 s of
 * simulated time). Every step that runs consumes one, including manual Step while paused, so a
 * pulse fired while paused ends after the same amount of sculpting as a running one.
 */
export const PULSE_STEPS = Math.round(0.5 / FIXED_DT);
const STATS_INTERVAL = 0.5;
/** Calm defaults under prefers-reduced-motion (the user can still change both). */
export const REDUCED_PACE = 0.45;
const REDUCED_TIME_SCALE = 0.3;

export function createRenderer({ canvas, container = canvas.parentElement ?? undefined }: RendererOptions) {
  let disposed = false;
  let failed = false;
  let gpu: Gpu | undefined;
  let output: Surface | undefined;
  let colony: Colony | undefined;
  let pipeline: GardenPipeline | undefined;
  let input: GardenInput | undefined;
  let gui: GUI | undefined;
  let loop: { stop(): void } | undefined;
  let unsubscribeResize: (() => void) | undefined;
  const goal: OrbitRig = orbitRig(VIEWS[DEFAULT_PRESET]);
  const current: OrbitRig = orbitRig(VIEWS[DEFAULT_PRESET]);
  const motion = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : undefined;
  let reducedMotion = motion?.matches ?? false;
  let onMotionChange: ((event: MediaQueryListEvent) => void) | undefined;
  // The idle orbit pauses while a pointer is anywhere over the demo, lil-gui panel included.
  const hoverTarget: HTMLElement = container ?? canvas;
  let hovered = false;
  const onPointerEnter = () => {
    hovered = true;
  };
  const onPointerLeave = () => {
    hovered = false;
  };

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    runCleanups([
      () => loop?.stop(),
      () => unsubscribeResize?.(),
      () => onMotionChange && motion?.removeEventListener("change", onMotionChange),
      () => hoverTarget.removeEventListener("pointerenter", onPointerEnter),
      () => hoverTarget.removeEventListener("pointerleave", onPointerLeave),
      () => input?.dispose(),
      () => gui?.destroy(),
      () => gpu?.dispose(),
    ]);
  }

  function fail(error: unknown): never {
    failed = true;
    try {
      dispose();
    } catch {
      // Teardown must not replace the render, resize or initialization error.
    }
    throw error;
  }

  function guard<T>(action: () => T): T {
    try {
      return action();
    } catch (error) {
      return fail(error);
    }
  }

  function pixelRatio(): number {
    return output ? output.size[1] / Math.max(1, canvas.clientHeight) : 1;
  }

  function aspect(): number {
    return output && output.size[1] > 0 ? output.size[0] / output.size[1] : 16 / 9;
  }

  const rayOrigin: Vec3 = [0, 0, 0];
  const rayDirection: Vec3 = [0, 0, 0];
  const rayHit: Vec3 = [0, 0, 0];
  function pick(clientX: number, clientY: number, out: [number, number]): boolean {
    if (!pipeline || !colony || !output) return false;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = 1 - ((clientY - rect.top) / rect.height) * 2;
    cameraRay(pipeline.camera.pose, pipeline.lens, output.size[0] / output.size[1], ndcX, ndcY, rayOrigin, rayDirection);
    if (!raycast(colony.terrain, rayOrigin, rayDirection, rayHit)) return false;
    out[0] = rayHit[0];
    out[1] = rayHit[2];
    return true;
  }

  const initialize = async () => {
    const { init } = await import("vgpu");
    if (disposed) return;
    const nextGpu = await init();
    if (disposed) {
      nextGpu.dispose();
      return;
    }

    gpu = nextGpu;
    output = surface(gpu, canvas, { dpr: [1, 2] });
    const garden = createColony({ seed: DEFAULT_SEED, count: PRESETS[DEFAULT_PRESET].count });
    colony = garden;
    pipeline = createPipeline(gpu, garden, output.size);
    const settings: Settings = {
      preset: DEFAULT_PRESET,
      robots: garden.count,
      seed: DEFAULT_SEED,
      paused: false,
      pace: reducedMotion ? REDUCED_PACE : 1,
      tool: "orbit",
      radius: garden.brush.radius,
      strength: garden.brush.strength,
      cursorX: 0,
      cursorZ: 0,
      follow: false,
      autoOrbit: !reducedMotion,
      debug: false,
    };
    garden.pace = settings.pace;
    // A GUI sculpt press runs for PULSE_STEPS fixed steps.
    const pulse = { mode: "raise" as "raise" | "lower", steps: 0 };
    /** The sculpt mode right now: a pending GUI pulse, else the tool. The aim overlay reads it too. */
    const brushMode = () => (pulse.steps > 0 ? pulse.mode : settings.tool === "lower" ? "lower" : "raise");
    /** The brush for the next fixed step: the pointer or Enter/Space in a sculpt tool, or a GUI pulse. */
    const updateBrush = () => {
      const pressed = input?.cursor.pressed ?? false;
      const sculptTool = settings.tool === "raise" || settings.tool === "lower";
      garden.brush.mode = brushMode();
      garden.brush.active = pulse.steps > 0 || (sculptTool && pressed);
      if (input) {
        garden.brush.x = input.cursor.x;
        garden.brush.z = input.cursor.z;
      }
      garden.brush.radius = settings.radius;
      garden.brush.strength = settings.strength;
    };
    /** Runs before every fixed step, manual or clocked: set the brush, then use up one pulse step. */
    const beforeStep = () => {
      updateBrush();
      pulse.steps = Math.max(0, pulse.steps - 1);
    };

    gui = new GUI({ title: "Mechanical Garden", container, width: GUI_WIDTH });
    const short = (container?.clientHeight ?? SHORT_HEIGHT) < SHORT_HEIGHT;
    const controls = configureGui(gui, settings, short, {
      preset: (preset) => guard(() => {
        setPreset(garden, preset);
        settings.robots = garden.count;
        settings.follow = preset === "close-up";
        applyView(goal, preset, aspect());
        controls.sync();
      }),
      robots: (count) => guard(() => setCount(garden, count)),
      reset: () => guard(() => {
        reset(garden, settings.seed, garden.count);
        pulse.steps = 0;
        controls.sync();
      }),
      pause: (paused) => {
        garden.paused = paused;
      },
      step: () => guard(() => {
        settings.paused = true;
        garden.paused = true;
        beforeStep();
        step(garden);
        controls.sync();
      }),
      pace: (pace) => {
        garden.pace = pace;
      },
      cursor: () => {
        if (!input) return;
        input.cursor.x = settings.cursorX;
        input.cursor.z = settings.cursorZ;
      },
      sculpt: (mode) => {
        pulse.mode = mode;
        pulse.steps = PULSE_STEPS;
      },
      destination: () => guard(() => setDestination(garden, settings.cursorX, settings.cursorZ)),
      clearDestination: () => guard(() => clearDestination(garden)),
      home: () => applyView(goal, settings.preset, aspect()),
    });
    if ((container?.clientWidth ?? NARROW_WIDTH) < NARROW_WIDTH) gui.close();

    input = installInput(canvas, goal, {
      tool: () => settings.tool,
      pick,
      onDestination: (x, z) => guard(() => setDestination(garden, x, z)),
      onTool: (tool) => {
        settings.tool = tool;
        controls.sync();
      },
      onPause: () => {
        settings.paused = !settings.paused;
        garden.paused = settings.paused;
        controls.sync();
      },
      onStep: controls.actions.step,
    });
    hoverTarget.addEventListener("pointerenter", onPointerEnter);
    hoverTarget.addEventListener("pointerleave", onPointerLeave);
    // Reduced motion sets calm defaults; a value the user changed is theirs and survives.
    onMotionChange = (event) => {
      reducedMotion = event.matches;
      if (!controls.touched.has("autoOrbit")) settings.autoOrbit = !reducedMotion;
      if (!controls.touched.has("pace")) {
        settings.pace = reducedMotion ? REDUCED_PACE : 1;
        garden.pace = settings.pace;
      }
      controls.sync();
    };
    motion?.addEventListener("change", onMotionChange);
    // The first measured size frames the opening view for its aspect (and snaps the camera there);
    // later resizes keep wherever the user put the camera.
    let framed = false;
    unsubscribeResize = output.onResize(() =>
      guard(() => {
        if (!output || !pipeline) return;
        pipeline.resize(output.size, pixelRatio());
        if (!framed && output.size[0] > 0 && output.size[1] > 0) {
          framed = true;
          applyView(goal, settings.preset, aspect());
          applyView(current, settings.preset, aspect());
        }
      }),
    );

    const ticks = clock(gpu);
    const brush: BrushOverlay = [0, 0, 1, 0];
    const stats: ColonyStats = { robots: 0, swinging: 0, meanSpeed: 0, worstResidual: 0, rejected: 0 };
    let renderTime = 0;
    let statsAge = STATS_INTERVAL;
    const uploads: UploadRates = { instances: 0, terrainBytes: 0, rigRows: 0 };
    let terrainTotal = pipeline.counters.terrainBytes;
    let rigTotal = pipeline.counters.rigRows;
    let simMs = 0;
    let lastCursorX = Number.NaN;
    let lastCursorZ = Number.NaN;
    loop = frameLoop(gpu, (currentFrame) => {
      guard(() => {
        if (disposed || !output || !pipeline || !input || !gui) return;
        const dt = Math.min(ticks.deltaTime, 0.1);
        const { cursor } = input;

        const started = performance.now();
        const ran = advance(garden, dt, beforeStep);
        if (ran > 0) simMs += ((performance.now() - started) / ran - simMs) * 0.1;

        // Camera: follow robot 0, idle orbit when nobody is interacting, then glide.
        const guiFocused = gui.domElement.matches(":focus-within");
        if (settings.follow && garden.count > 0) followRobot(goal, garden.robots[0]!);
        if (settings.autoOrbit && !hovered && !input.engaged && !guiFocused && document.activeElement !== canvas) {
          goal.yaw += dt * IDLE_ORBIT_SPEED;
        }
        smoothRig(current, goal, dt, { timeConstant: reducedMotion ? 0.02 : CAMERA_TIME_CONSTANT });
        pipeline.updateCamera(current);

        const aiming = pulse.steps > 0 || cursor.visible || (guiFocused && sculptFocused(gui));
        brush[0] = cursor.x;
        brush[1] = cursor.z;
        brush[2] = settings.radius;
        // Style: off, destination marker (2), or the sculpt mode a pending pulse or the tool sets.
        const marker = settings.tool === "destination" && pulse.steps === 0;
        brush[3] = !aiming ? 0 : marker ? 2 : brushMode() === "lower" ? -1 : 1;
        if (brush[3] === 2) brush[2] = 0.3;
        renderTime += dt * (reducedMotion ? REDUCED_TIME_SCALE : 1);
        pipeline.render(currentFrame, output, { time: renderTime, brush, debug: settings.debug });

        statsAge += dt;
        if (statsAge >= STATS_INTERVAL) {
          const interval = statsAge;
          statsAge = 0;
          readStats(garden, stats);
          if (cursor.x !== lastCursorX || cursor.z !== lastCursorZ) {
            lastCursorX = settings.cursorX = cursor.x;
            lastCursorZ = settings.cursorZ = cursor.z;
          }
          // Rates over the readout interval (measured on the same clamped dt).
          const { counters } = pipeline;
          uploads.instances = counters.instances;
          uploads.terrainBytes = (counters.terrainBytes - terrainTotal) / interval;
          uploads.rigRows = (counters.rigRows - rigTotal) / interval;
          terrainTotal = counters.terrainBytes;
          rigTotal = counters.rigRows;
          controls.stats(stats, simMs, garden, uploads);
        }
      });
    });
  };

  const ready = initialize().catch((error: unknown) => {
    if (disposed && !failed) return;
    fail(error);
  });

  return { ready, dispose };
}

function sculptFocused(gui: GUI): boolean {
  const folder = gui.folders.find((child) => child._title === "Sculpt");
  return Boolean(folder?.domElement.matches(":focus-within"));
}

/** Upload readouts: the last frame's instance count, and per-second terrain bytes and robot part rows. */
export interface UploadRates {
  instances: number;
  terrainBytes: number;
  rigRows: number;
}

export interface GuiActions {
  preset(preset: PresetName): void;
  robots(count: number): void;
  reset(): void;
  pause(paused: boolean): void;
  step(): void;
  pace(pace: number): void;
  cursor(): void;
  sculpt(mode: "raise" | "lower"): void;
  destination(): void;
  clearDestination(): void;
  home(): void;
}

/**
 * lil-gui is also the keyboard and touch path for everything the pointer does: pick a tool, move
 * the cursor, sculpt or send the robots there. `touched` records settings the user changed (reduced
 * motion leaves those alone); `stats` refreshes the read-only counters.
 */
export function configureGui(
  gui: GUI,
  settings: Settings,
  compact: boolean,
  handlers: GuiActions,
): {
  readonly touched: Set<keyof Settings>;
  readonly actions: { step(): void };
  sync(): void;
  stats(stats: ColonyStats, simMs: number, colony: Colony, uploads: UploadRates): void;
} {
  Object.assign(gui.domElement.style, {
    position: "absolute",
    top: "8px",
    right: "8px",
    zIndex: "10",
    maxHeight: "calc(100% - 16px)",
    overflowY: "auto",
  });
  const touched = new Set<keyof Settings>();
  const touch = (key: keyof Settings) => () => touched.add(key);
  const controllers: Controller[] = [];
  const keep = <T extends Controller>(controller: T) => (controllers.push(controller), controller);

  const scene = gui.addFolder("Scene");
  keep(scene.add(settings, "preset", Object.keys(PRESETS)).name("preset")).onChange(handlers.preset);
  keep(scene.add(settings, "robots", 1, MAX_ROBOTS, 1).name("robots")).onFinishChange(handlers.robots);
  keep(scene.add(settings, "paused").name("paused")).onChange(handlers.pause);
  const actions = {
    step: handlers.step,
    reset: handlers.reset,
    raise: () => handlers.sculpt("raise"),
    lower: () => handlers.sculpt("lower"),
    destination: handlers.destination,
    clear: handlers.clearDestination,
    home: handlers.home,
  };
  scene.add(actions, "step").name("step once");
  keep(scene.add(settings, "pace", 0.1, 1, 0.05).name("pace"))
    .onChange((pace: number) => {
      touched.add("pace");
      handlers.pace(pace);
    });
  keep(scene.add(settings, "seed", 1, 9999, 1).name("seed"));
  scene.add(actions, "reset").name("reset to seed");

  const sculpt = gui.addFolder("Sculpt");
  keep(sculpt.add(settings, "tool", [...TOOLS]).name("tool"));
  keep(sculpt.add(settings, "radius", BRUSH_RADIUS.min, BRUSH_RADIUS.max, 0.05).name("brush radius"));
  keep(sculpt.add(settings, "strength", BRUSH_STRENGTH.min, BRUSH_STRENGTH.max, 0.05).name("brush strength"));
  keep(sculpt.add(settings, "cursorX", -HALF + 0.3, HALF - 0.3, 0.05).name("cursor x").decimals(2)).onChange(handlers.cursor);
  keep(sculpt.add(settings, "cursorZ", -HALF + 0.3, HALF - 0.3, 0.05).name("cursor z").decimals(2)).onChange(handlers.cursor);
  sculpt.add(actions, "raise").name("raise at cursor");
  sculpt.add(actions, "lower").name("lower at cursor");
  sculpt.add(actions, "destination").name("walk to cursor");
  sculpt.add(actions, "clear").name("clear destination");

  const view = gui.addFolder("Camera");
  keep(view.add(settings, "follow").name("follow robot 1"));
  keep(view.add(settings, "autoOrbit").name("idle orbit")).onChange(touch("autoOrbit"));
  view.add(actions, "home").name("reset view");

  const debug = gui.addFolder("Debug");
  keep(debug.add(settings, "debug").name("targets and IK"));

  const readout = { swinging: "", speed: "", residual: "", rejected: "", sim: "", dropped: "", instances: "", terrain: "", rig: "" };
  const statsFolder = gui.addFolder("Stats");
  const readouts = [
    statsFolder.add(readout, "swinging").name("feet in swing"),
    statsFolder.add(readout, "speed").name("mean speed"),
    // The planted legs' FABRIK residual against their clamped in-plane goal: how well the solver
    // met the goal it was given, not the distance from the requested world foot to the ground
    // (out-of-reach goals are clamped first, and rejected solves are counted separately).
    statsFolder.add(readout, "residual").name("planted IK residual"),
    statsFolder.add(readout, "rejected").name("rejected solves"),
    statsFolder.add(readout, "sim").name("simulation (CPU)"),
    statsFolder.add(readout, "dropped").name("dropped steps"),
    // Instances in the last colour pass (robot parts, scenery, plinth); terrain vertex bytes and
    // robot part rows sent to the GPU per second. Both uploads are change-tracked: a paused,
    // unsculpted garden uploads nothing.
    statsFolder.add(readout, "instances").name("instances drawn"),
    statsFolder.add(readout, "terrain").name("terrain upload"),
    statsFolder.add(readout, "rig").name("robot parts upload"),
  ];
  for (const controller of readouts) controller.disable();

  view.close();
  debug.close();
  statsFolder.close();
  // Short frames (the gallery's 16:9 frame) start with every folder closed: six headers, no cover.
  if (compact) {
    scene.close();
    sculpt.close();
  }

  return {
    touched,
    actions,
    sync() {
      for (const controller of controllers) controller.updateDisplay();
    },
    stats(stats, simMs, colony, uploads) {
      readout.swinging = `${stats.swinging} of ${stats.robots * 6}`;
      // The scene has no physical scale: distances are world units (a femur is 0.34, the tile 15 across).
      readout.speed = `${stats.meanSpeed.toFixed(2)} units/s`;
      readout.residual = `${stats.worstResidual.toExponential(1)} units`;
      readout.rejected = `${stats.rejected}`;
      readout.sim = `${simMs.toFixed(2)} ms / step`;
      readout.dropped = `${colony.dropped}`;
      readout.instances = `${uploads.instances}`;
      readout.terrain = `${(uploads.terrainBytes / 1024).toFixed(1)} KB/s`;
      readout.rig = `${Math.round(uploads.rigRows)} rows/s`;
      for (const controller of readouts) controller.updateDisplay();
      for (const controller of controllers) {
        // Cursor sliders follow the pointer; other values only change through their own controls.
        if (controller.property === "cursorX" || controller.property === "cursorZ") controller.updateDisplay();
      }
    },
  };
}

function runCleanups(cleanups: readonly (() => void)[]): void {
  const errors: unknown[] = [];
  for (const cleanup of cleanups) {
    try {
      cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw errors[0];
}
