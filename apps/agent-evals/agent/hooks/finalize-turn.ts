import { createHash } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { defineHook } from "eve/hooks";
import type { SandboxSession } from "eve/sandbox";
import { sceneContract } from "../../evals/lib/scene-contracts.mjs";
import {
  recordSceneTurn,
  snapshotAttemptCompletePath,
  snapshotAttemptTarPath,
  snapshotAttemptVerifyTarPath,
  snapshotTarPath,
} from "../lib/paths.ts";
import { isSceneTask } from "../lib/scene-auth.mjs";
import { observeSceneGuidanceInstall } from "../lib/scene-guidance.ts";
import { requireTaskId } from "../lib/task.ts";
import { verifyN1HeroShader } from "../lib/verify/n1-hero-shader.mjs";
import { verifyNextBuild } from "../lib/verify/next-build.mjs";
import { verifySceneInSandbox } from "../lib/verify/scene.mjs";

const WORKSPACE = "/workspace";
const TAR_IN_SANDBOX = "/tmp/vgpu-agent-evals-workspace.tar";

/**
 * Scene tasks snapshot before verifier-owned writes, run a copied source tree,
 * and publish an immutable turn/event attempt. Existing task branches preserve
 * their verify-then-session-export behavior.
 */
export default defineHook({
  events: {
    "turn.completed": async (event, ctx) => {
      const sessionId = ctx.session.id;
      const taskId = requireTaskId();
      if (isSceneTask(taskId)) {
        const turnId = event.data.turnId;
        const metaId = event.meta.id;
        if (!turnId || !metaId) throw new Error("scene verification requires turnId and event meta.id");

        // Record before any verify step so a failed first hook cannot silently
        // downgrade the next distinct logical turn to stage 1.
        const { stage } = recordSceneTurn(sessionId, turnId);
        const contract = sceneContract(taskId, stage);
        const sandbox = await ctx.getSandbox();
        const sceneGuidance = await observeSceneGuidanceInstall(sandbox);
        const workspaceBytes = await captureWorkspaceTar(sandbox);
        writeTar(snapshotAttemptTarPath(sessionId, turnId, metaId), workspaceBytes);
        writeTar(snapshotTarPath(sessionId), workspaceBytes);

        const verification = await verifySceneInSandbox(sandbox, {
          taskId,
          stage,
          turnId,
          metaId,
          input: contract.input,
          timeoutMs: contract.timeoutMs,
        });
        const evidenceBytes = await sandbox.readBinaryFile({ path: verification.evidenceTarPath });
        const evidenceExported = evidenceBytes !== null;
        if (evidenceBytes) writeAtomic(snapshotAttemptVerifyTarPath(sessionId, turnId, metaId), evidenceBytes);

        let evidenceRemoved = false;
        try {
          const removal = await sandbox.run({ command: `rm -f ${shellQuote(verification.evidenceTarPath)}` });
          evidenceRemoved = removal.exitCode === 0;
        } catch {
          evidenceRemoved = false;
        }
        const cleanupOk = verification.cleanupOk && evidenceRemoved;
        const complete = {
          ...verification.metadata,
          classification: evidenceExported ? verification.classification : "infrastructure-error",
          reason: evidenceExported ? verification.reason : "verification evidence tar was missing",
          cleanupOk,
          removedPath: verification.removedPath,
          evidenceExported,
          sceneGuidance,
          completedAt: new Date().toISOString(),
        };
        // Intentionally the last host write for this attempt.
        writeAtomic(snapshotAttemptCompletePath(sessionId, turnId, metaId), `${JSON.stringify(complete, null, 2)}\n`);
        if (!cleanupOk || !evidenceExported || complete.classification === "infrastructure-error") {
          throw new Error(`scene verification infrastructure error: ${complete.reason ?? "cleanup/export failed"}`);
        }
        return;
      }

      const sandbox = await ctx.getSandbox();
      if (taskId === "n1-hero-shader") {
        await verifyN1HeroShader(sandbox);
      } else if (taskId === "n2-ship-hero" || taskId === "n3-explore-hero") {
        await verifyNextBuild(sandbox);
      }
      await exportWorkspaceTar(sandbox, sessionId);
    },
  },
});

async function captureWorkspaceTar(sandbox: SandboxSession): Promise<Uint8Array> {
  const tar = await sandbox.run({
    command: `tar -cf ${TAR_IN_SANDBOX} --exclude=./node_modules --exclude=./.git --exclude=./.vgpu-tarballs --exclude=./.next -C ${WORKSPACE} .`,
  });
  if (tar.exitCode !== 0) {
    throw new Error(`export-workspace: tar failed (exit ${tar.exitCode}): ${tar.stderr ?? ""}`);
  }
  const bytes = await sandbox.readBinaryFile({ path: TAR_IN_SANDBOX });
  if (!bytes) throw new Error(`export-workspace: ${TAR_IN_SANDBOX} was missing after a successful tar`);
  return bytes;
}

async function exportWorkspaceTar(sandbox: SandboxSession, sessionId: string): Promise<void> {
  writeTar(snapshotTarPath(sessionId), await captureWorkspaceTar(sandbox));
}

function writeTar(destination: string, bytes: Uint8Array): void {
  writeAtomic(destination, bytes);
  writeAtomic(`${destination}.sha256`, `${createHash("sha256").update(bytes).digest("hex")}\n`);
}

function writeAtomic(destination: string, value: Uint8Array | string): void {
  mkdirSync(dirname(destination), { recursive: true });
  const staging = `${destination}.partial`;
  writeFileSync(staging, value);
  renameSync(staging, destination);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
