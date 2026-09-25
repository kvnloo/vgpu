import { defineEval } from "eve/evals";
import { runSceneEval } from "./lib/scene-eval.ts";

export default defineEval({
  description: "scene-warehouse: render stable IDs, then persist delete/move/recolor edits",
  timeoutMs: 1_200_000,
  test: (t) => runSceneEval(t, "scene-warehouse"),
});
