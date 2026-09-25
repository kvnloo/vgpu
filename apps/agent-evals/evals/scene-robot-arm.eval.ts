import { defineEval } from "eve/evals";
import { runSceneEval } from "./lib/scene-eval.ts";

export default defineEval({
  description: "scene-robot-arm: build a hierarchy, then edit parents and descendants",
  timeoutMs: 1_200_000,
  test: (t) => runSceneEval(t, "scene-robot-arm"),
});
