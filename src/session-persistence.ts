import type { ContainerOutput } from './container-runner.js';

// Skip persisting session ID on error outputs: the agent-runner echoes the
// incoming (stale) sessionId back as newSessionId when the Claude SDK rejects
// it ("No conversation found"), which would re-pin the orchestrator to a dead
// conversation and trap the group in an infinite retry loop.
export function shouldPersistSession(output: ContainerOutput): boolean {
  if (!output.newSessionId) return false;
  if (output.status === 'error') return false;
  return true;
}
