import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import { it } from "node:test";
import { acquireSessionLease } from "../../src/runs/shared/session-lease.ts";
import { createEnvironmentBinding, environmentAuthorityDirectory } from "../../src/runs/background/environment-authority.ts";
import { captureEnvironmentProcess } from "../../src/runs/background/environment-process-identity.ts";

it("retains an abandoned environment lease until namespace disappearance is observed", { skip: process.platform !== "linux" }, () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "environment-lease-"));
	const runId = randomUUID();
	const runDirectory = path.join(root, runId);
	const sessionRoot = path.join(runDirectory, "session");
	fs.mkdirSync(sessionRoot, { recursive: true });
	const sessionFile = path.join(sessionRoot, "session.jsonl");
	fs.writeFileSync(sessionFile, "");
	createEnvironmentBinding({ runDirectory, sessionRoot, sessionFile, environment: { name: "synthetic", digest: "test", files: [] } });
	const authority = environmentAuthorityDirectory(runDirectory);
	const live = captureEnvironmentProcess(process.pid)!;
	const gone = { ...live, pid: 2147483647 };
	const record = { version: 1, owner: gone, monitor: gone, namespace: { identity: live, inode: 1 }, runnerProcessInstanceId: randomUUID() };
	fs.writeFileSync(path.join(authority, "owner.json"), JSON.stringify(record));
	const options = { rootDir: path.join(root, "leases"), isProcessAlive: () => false };
	const lease = acquireSessionLease({ sessionFile, runId, sourceRunId: runId, environmentRunDirectory: runDirectory }, { ...options, pid: gone.pid });
	try {
		assert.throws(() => acquireSessionLease({ sessionFile, runId: "contender", sourceRunId: runId }, options), /already owned/);
		record.namespace.identity = { ...live, start: `${live.start}0` };
		fs.writeFileSync(path.join(authority, "owner.json"), JSON.stringify(record));
		const successor = acquireSessionLease({ sessionFile, runId: "successor", sourceRunId: runId }, options);
		assert.equal(successor.release(), true);
	} finally {
		lease.release();
		fs.rmSync(authority, { recursive: true, force: true });
		fs.rmSync(root, { recursive: true, force: true });
	}
});
