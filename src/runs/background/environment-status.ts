import type { AsyncStatus } from "../../shared/types.ts";
import { readEnvironmentBinding } from "./environment-authority.ts";
import { environmentProcessAlive, readEnvironmentOwner } from "./environment-process-identity.ts";
import { readProcessTerminal } from "./process-terminal.ts";

/** Worker telemetry cannot select host PIDs, runner kinds or termination proof. */
export function environmentStatus(runDirectory: string, status: AsyncStatus): AsyncStatus {
	let binding;
	try { binding = readEnvironmentBinding(runDirectory); }
	catch (error) {
		return { ...status, pid: undefined, processTerminal: undefined, state: "failed", error: error instanceof Error ? error.message : String(error) };
	}
	if (!binding) return status;
	const owner = readEnvironmentOwner(runDirectory);
	const alive = owner && environmentProcessAlive(owner.owner);
	const { pid: _workerPid, ...telemetry } = status;
	return {
		...telemetry, mode: "single", sessionRoot: binding.sessionRoot, runId: binding.runId,
		processTerminal: readProcessTerminal(runDirectory),
		steps: status.steps?.map(step => ({ ...step, agent: "$task", runner: undefined, externalJob: undefined, processTerminal: undefined })),
		...(alive ? { pid: owner.owner.pid, state: "running" as const } : {}),
	};
}
