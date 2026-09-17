import * as path from "node:path";
import { writePrivateAtomicJson } from "../../shared/atomic-json.ts";
import { acquireSessionLease } from "../shared/session-lease.ts";
import { admitEnvironmentSession, environmentAuthorityDirectory, readEnvironmentBinding } from "./environment-authority.ts";
import { environmentProcessState, readEnvironmentOwner } from "./environment-process-identity.ts";
import { finalizeProcessTerminal, readProcessTerminal } from "./process-terminal.ts";

/** Reconstruct termination only from private identities and current kernel observations. */
export function recoverEnvironmentTermination(runDirectory: string): boolean {
	const binding = readEnvironmentBinding(runDirectory);
	if (!binding) return false;
	if (readProcessTerminal(runDirectory)?.state === "observed") return true;
	const owner = readEnvironmentOwner(runDirectory);
	if (!owner || ![owner.owner, owner.monitor, owner.namespace.identity].every(identity => environmentProcessState(identity) === "terminated")) return false;
	admitEnvironmentSession(binding, binding.sessionFile);
	// Reserve the canonical session while reclaiming an abandoned lease. A
	// concurrent legitimate writer keeps its lease and blocks this recovery.
	const reservation = acquireSessionLease({ sessionFile: binding.sessionFile, runId: `${binding.runId}-recovery`, sourceRunId: binding.runId });
	if (!reservation.release()) return false;
	const at = Date.now();
	const directory = environmentAuthorityDirectory(runDirectory);
	writePrivateAtomicJson(path.join(directory, "namespace-terminal.json"), { version: 1, observed: true, recovered: true, at, exitCode: null, signal: null });
	writePrivateAtomicJson(path.join(directory, "process-terminal-candidate.json"), {
		version: 1, runId: binding.runId, runnerProcessInstanceId: owner.runnerProcessInstanceId,
		sessionFile: binding.sessionFile, revivalLeaseToken: reservation.owner.token, revivalLeaseReleaseAcknowledged: true,
		expectedWriters: { "0": 1 }, writers: { "0": [{ kind: "pi-writer", processInstanceId: `${owner.runnerProcessInstanceId}:namespace`, attempt: 0, closeObservedAt: at, exitCode: null, signal: null,
			processTree: { state: "observed", mechanism: "linux-pid-namespace", namespaceId: owner.namespace.inode, verifiedAt: at } }] },
	});
	return finalizeProcessTerminal(runDirectory, binding.runId, { processInstanceId: owner.runnerProcessInstanceId, closeObservedAt: at, exitCode: null, signal: null }).state === "observed";
}
