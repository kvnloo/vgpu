import { orbitRig } from "vgpu/scene";
import { describe, expect, it, vi } from "vitest";

import { CURSOR_STEP, installInput, type InputElement, type Tool } from "./input";
import { HALF } from "./terrain";

function setup(initialTool: Tool = "orbit") {
  const listeners = new Map<string, EventListener>();
  const element: InputElement = {
    addEventListener: vi.fn((type: string, listener: EventListener) => {
      listeners.set(type, listener);
    }),
    removeEventListener: vi.fn((type: string, listener: EventListener) => {
      if (listeners.get(type) === listener) listeners.delete(type);
    }),
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
    hasPointerCapture: vi.fn(() => false),
  };
  let tool = initialTool;
  const goal = orbitRig({ target: [0, 0, 0], yaw: 0, pitch: 0.5, distance: 10 });
  const options = {
    tool: () => tool,
    pick: vi.fn((_x: number, _y: number, out: [number, number]) => {
      out[0] = 0.5;
      out[1] = -0.25;
      return true;
    }),
    onDestination: vi.fn(),
    onTool: vi.fn((next: Tool) => {
      tool = next;
    }),
    onPause: vi.fn(),
    onStep: vi.fn(),
  };
  const input = installInput(element, goal, options);
  const fire = (type: string, init: Record<string, unknown> = {}) => {
    const event = { type, preventDefault: vi.fn(), altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, repeat: false, ...init };
    listeners.get(type)?.(event as unknown as Event);
    return event;
  };
  return { listeners, element, goal, options, input, fire, setTool: (next: Tool) => (tool = next) };
}

describe("keyboard equivalents", () => {
  it("number keys pick tools, P pauses and period steps", () => {
    const env = setup();
    for (const [key, tool] of [["2", "raise"], ["3", "lower"], ["4", "destination"], ["1", "orbit"]] as const) {
      expect(env.fire("keydown", { key }).preventDefault).toHaveBeenCalled();
      expect(env.options.onTool).toHaveBeenLastCalledWith(tool);
    }
    env.fire("keydown", { key: "p" });
    env.fire("keydown", { key: "." });
    expect(env.options.onPause).toHaveBeenCalledOnce();
    expect(env.options.onStep).toHaveBeenCalledOnce();
    // Browser shortcuts pass through untouched.
    expect(env.fire("keydown", { key: "2", metaKey: true }).preventDefault).not.toHaveBeenCalled();
    expect(env.fire("keydown", { key: "Tab" }).preventDefault).not.toHaveBeenCalled();
  });

  it("arrows orbit in orbit mode and move a bounded cursor in a tool mode", () => {
    const env = setup();
    const yaw = env.goal.yaw;
    env.fire("keydown", { key: "ArrowLeft" });
    expect(env.goal.yaw).not.toBe(yaw);
    expect(env.input.cursor.x).toBe(0);

    env.setTool("raise");
    env.fire("focus");
    env.fire("keydown", { key: "ArrowRight" });
    // Right is the camera's right: (cos yaw, -sin yaw) on the ground.
    expect(env.input.cursor.x).toBeCloseTo(CURSOR_STEP * Math.cos(env.goal.yaw), 6);
    expect(env.input.cursor.z).toBeCloseTo(-CURSOR_STEP * Math.sin(env.goal.yaw), 6);
    expect(env.input.cursor.visible).toBe(true);
    for (let index = 0; index < 200; index++) env.fire("keydown", { key: "ArrowRight", shiftKey: true });
    expect(Number.isFinite(env.input.cursor.x)).toBe(true);
    expect(env.input.cursor.x).toBeCloseTo(HALF - 0.3, 6);
  });

  it("Enter holds a sculpt until keyup or blur, and sends the robots in destination mode", () => {
    const env = setup("raise");
    env.fire("focus");
    env.fire("keydown", { key: "Enter" });
    expect(env.input.cursor.pressed).toBe(true);
    expect(env.input.engaged).toBe(true);
    env.fire("keyup", { key: "Enter" });
    expect(env.input.cursor.pressed).toBe(false);

    env.fire("keydown", { key: " " });
    env.fire("blur");
    expect(env.input.cursor.pressed).toBe(false);

    env.setTool("destination");
    env.fire("keydown", { key: "Enter" });
    env.fire("keydown", { key: "Enter", repeat: true });
    expect(env.options.onDestination).toHaveBeenCalledOnce();
    expect(env.input.cursor.pressed).toBe(false);
  });
});

describe("pointer", () => {
  it("a sculpt press follows the picked terrain point and releases on pointerup", () => {
    const env = setup("raise");
    env.fire("pointerdown", { pointerId: 1, pointerType: "mouse", button: 0, buttons: 1, isPrimary: true, clientX: 10, clientY: 10, timeStamp: 0 });
    expect(env.input.cursor.pressed).toBe(true);
    expect(env.input.cursor.x).toBe(0.5);
    expect(env.input.cursor.z).toBe(-0.25);
    env.fire("pointerup", { pointerId: 1, pointerType: "mouse", button: 0, buttons: 0, isPrimary: true, clientX: 10, clientY: 10, timeStamp: 50 });
    expect(env.input.cursor.pressed).toBe(false);
  });
});

describe("taps, drags and two fingers", () => {
  const finger = (pointerId: number, clientX: number, clientY: number, timeStamp: number, buttons = 1) => ({
    pointerId,
    pointerType: "touch",
    button: 0,
    buttons,
    isPrimary: pointerId === 1,
    clientX,
    clientY,
    timeStamp,
  });

  it("in destination mode a short still press sends the robots and a drag orbits instead", () => {
    const env = setup("destination");
    // A drag past the tap distance becomes an orbit and never sets a destination.
    const yaw = env.goal.yaw;
    env.fire("pointerdown", finger(1, 100, 100, 0));
    env.fire("pointermove", finger(1, 140, 100, 40));
    env.fire("pointerup", finger(1, 140, 100, 80, 0));
    expect(env.goal.yaw).not.toBe(yaw);
    expect(env.options.onDestination).not.toHaveBeenCalled();
    // A few pixels of jitter still count as a tap, at the picked terrain point.
    env.fire("pointerdown", finger(1, 100, 100, 1000));
    env.fire("pointermove", finger(1, 103, 102, 1040));
    env.fire("pointerup", finger(1, 103, 102, 1100, 0));
    expect(env.options.onDestination).toHaveBeenCalledExactlyOnceWith(0.5, -0.25);
    // A cancelled press is never a tap.
    env.fire("pointerdown", finger(1, 100, 100, 2000));
    env.fire("pointercancel", finger(1, 100, 100, 2050, 0));
    expect(env.options.onDestination).toHaveBeenCalledOnce();
  });

  it("a second finger stops a sculpt, pinches to zoom, drags to orbit, and the first finger never resumes sculpting", () => {
    const env = setup("raise");
    env.fire("pointerdown", finger(1, 100, 100, 0));
    expect(env.input.cursor.pressed).toBe(true);
    env.fire("pointerdown", finger(2, 200, 100, 20));
    expect(env.input.cursor.pressed).toBe(false);
    // Spreading the fingers dollies in; moving both together orbits.
    const distance = env.goal.distance;
    env.fire("pointermove", finger(1, 50, 100, 40));
    env.fire("pointermove", finger(2, 250, 100, 40));
    expect(env.goal.distance).toBeLessThan(distance);
    const yaw = env.goal.yaw;
    env.fire("pointermove", finger(1, 90, 100, 60));
    env.fire("pointermove", finger(2, 290, 100, 60));
    expect(env.goal.yaw).not.toBe(yaw);
    // Lifting the second finger leaves an orbiting first finger, not a sculpt.
    env.fire("pointerup", finger(2, 290, 100, 80, 0));
    env.fire("pointermove", finger(1, 120, 120, 100));
    expect(env.input.cursor.pressed).toBe(false);
    env.fire("pointerup", finger(1, 120, 120, 120, 0));
    expect(env.input.cursor.pressed).toBe(false);
    expect(env.input.cursor.visible).toBe(false);
    // The next single press sculpts again.
    env.fire("pointerdown", finger(3, 100, 100, 500));
    expect(env.input.cursor.pressed).toBe(true);
  });

  it("a destination tap that grew a second finger is a camera gesture, not a destination", () => {
    const env = setup("destination");
    env.fire("pointerdown", finger(1, 100, 100, 0));
    env.fire("pointerdown", finger(2, 160, 100, 10));
    env.fire("pointerup", finger(2, 160, 100, 30, 0));
    env.fire("pointerup", finger(1, 100, 100, 50, 0));
    expect(env.options.onDestination).not.toHaveBeenCalled();
  });
});

describe("cursor visibility", () => {
  const touch = { pointerId: 7, pointerType: "touch", button: 0, buttons: 1, isPrimary: true, clientX: 10, clientY: 10 };

  it("a touch sculpt that focuses the canvas leaves no cursor once the finger lifts", () => {
    const env = setup("raise");
    env.fire("pointerdown", { ...touch, timeStamp: 0 });
    // The tap focuses the (tabIndex 0) canvas after the press.
    env.fire("focus");
    expect(env.input.cursor.visible).toBe(true);
    env.fire("pointerup", { ...touch, buttons: 0, timeStamp: 900 });
    expect(env.input.cursor.visible).toBe(false);
    expect(env.input.keyboard).toBe(false);
    // A key press on the still-focused canvas brings the keyboard cursor back.
    env.fire("keydown", { key: "ArrowUp" });
    expect(env.input.cursor.visible).toBe(true);
    expect(env.input.keyboard).toBe(true);
  });

  it("keyboard focus shows the cursor in a tool mode; a press hands it back to the pointer", () => {
    const env = setup("lower");
    env.fire("focus");
    expect(env.input.cursor.visible).toBe(true);
    env.fire("pointerdown", { ...touch, timeStamp: 0 });
    env.fire("pointerup", { ...touch, buttons: 0, timeStamp: 900 });
    expect(env.input.cursor.visible).toBe(false);
  });

  it("only a short press counts as a destination tap", () => {
    const env = setup("destination");
    env.fire("pointerdown", { ...touch, timeStamp: 0 });
    env.fire("pointerup", { ...touch, buttons: 0, timeStamp: 1500 });
    expect(env.options.onDestination).not.toHaveBeenCalled();
    env.fire("pointerdown", { ...touch, timeStamp: 2000 });
    env.fire("pointerup", { ...touch, buttons: 0, timeStamp: 2150 });
    expect(env.options.onDestination).toHaveBeenCalledOnce();
  });
});

describe("lifecycle", () => {
  it("dispose removes every listener once", () => {
    const env = setup();
    expect(env.listeners.size).toBe(12);
    env.input.dispose();
    env.input.dispose();
    expect(env.listeners.size).toBe(0);
    expect(env.element.removeEventListener).toHaveBeenCalledTimes(12);
  });

  it("a failing install removes what it added", () => {
    const added = new Set<string>();
    let calls = 0;
    const element: InputElement = {
      addEventListener: (type) => {
        if (++calls === 5) throw new Error("add failed");
        added.add(type);
      },
      removeEventListener: (type) => {
        added.delete(type);
      },
    };
    expect(() =>
      installInput(element, orbitRig({ target: [0, 0, 0] }), {
        tool: () => "orbit",
        pick: () => false,
        onDestination: () => {},
        onTool: () => {},
        onPause: () => {},
        onStep: () => {},
      }),
    ).toThrow("add failed");
    expect(added.size).toBe(0);
  });
});
