"use client";

import { useEffect, useRef } from "react";

import { createRenderer } from "./renderer";

export function Example() {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = rootRef.current;
    if (!canvas || !container) return;

    const renderer = createRenderer({ canvas, container });
    void renderer.ready;
    return renderer.dispose;
  }, []);

  return (
    <div ref={rootRef} className="relative h-full w-full overflow-hidden bg-black">
      <canvas
        ref={canvasRef}
        role="application"
        tabIndex={0}
        className="block h-full w-full touch-none outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-amber-300"
        aria-label="Six-legged robots walking over a sculptable ceramic garden. Drag to orbit, scroll or pinch to zoom. Keys: 1 orbit, 2 raise, 3 lower, 4 destination; arrows move the cursor; hold Enter or Space to sculpt or press it to send the robots; P pauses and period steps once (while paused, sculpting and walking advance one step per period). The controls panel offers the same tools."
      />
    </div>
  );
}

export default Example;
