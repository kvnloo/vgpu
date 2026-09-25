import { defineEval } from "eve/evals";
import { runSceneEval } from "./lib/scene-eval.ts";

export default defineEval({
  description: "scene-shader-bindings: integrate a supplied shader, then update its camera binding",
  timeoutMs: 1_200_000,
  test: (t) => runSceneEval(t, "scene-shader-bindings"),
});
