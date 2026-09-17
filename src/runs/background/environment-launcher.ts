import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { createInterface } from "node:readline";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { writePrivateAtomicJson } from "../../shared/atomic-json.ts";
import { acquireSessionLease } from "../shared/session-lease.ts";
import { admitEnvironmentSession, environmentAuthorityDirectory, readEnvironmentBinding, readEnvironmentFile } from "./environment-authority.ts";

const LaunchSchema = Type.Object({ runDirectory: Type.String(), bootstrapPath: Type.String(), runnerProcessInstanceId: Type.String(), args: Type.Array(Type.String()), cwd: Type.String(), deadlineAt: Type.Optional(Type.Number()), resultDestination: Type.String() });
const NamespaceSchema = Type.Object({ "child-pid": Type.Integer({ minimum: 1 }), "pid-namespace": Type.Integer({ minimum: 1 }) });
import { captureEnvironmentProcess as identity, environmentProcessState, type EnvironmentProcessIdentity as HostIdentity } from "./environment-process-identity.ts";

/** The parent sends the launch through stdin so environment values are never archived. */
async function main(): Promise<void> {
	const raw: unknown = JSON.parse(fs.readFileSync(0, "utf8"));
	if (!Check(LaunchSchema, raw)) throw new Error("Invalid environment launcher request.");
	const binding = readEnvironmentBinding(raw.runDirectory);
	if (!binding) throw new Error("Environment launcher requires host authority.");
	admitEnvironmentSession(binding, binding.sessionFile);
	const directory = environmentAuthorityDirectory(raw.runDirectory);
	const owner = identity(process.pid);
	if (!owner) throw new Error("Cannot establish launcher host identity.");
	const lease = acquireSessionLease({ environmentRunDirectory: binding.runDirectory, sessionFile: binding.sessionFile, runId: binding.runId, sourceRunId: binding.runId });
	const bootstrap: unknown = JSON.parse(readEnvironmentFile(raw.bootstrapPath));
	if (!bootstrap || typeof bootstrap !== "object" || Array.isArray(bootstrap)) throw new Error("Invalid environment bootstrap.");
	writePrivateAtomicJson(raw.bootstrapPath, { ...bootstrap, environmentHostPid: process.pid });
	const stdout = fs.openSync(path.join(raw.runDirectory, "runner.stdout.log"), "a");
	const stderr = fs.openSync(path.join(raw.runDirectory, "runner.stderr.log"), "a");
	const monitor = spawn("/usr/bin/bwrap", raw.args, { cwd: raw.cwd, env: { PATH: "/usr/bin:/bin" }, stdio: ["ignore", stdout, stderr, "pipe", "pipe"] });
	fs.closeSync(stdout);
	fs.closeSync(stderr);
	const statusPipe = monitor.stdio[3];
	const barrier = monitor.stdio[4];
	if (!(statusPipe instanceof Readable) || !(barrier instanceof Writable)) {
		monitor.kill("SIGKILL");
		throw new Error("Bubblewrap ownership descriptors are unavailable.");
	}
	let namespace: { identity: HostIdentity; inode: number; descriptor: number } | undefined;
	let authorized = false;
	let reason: "stop" | "interrupt" | "timeout" | undefined;
	let interruptAt: number | undefined;
	let startupError: string | undefined;
	const startedAt = Date.now();
	const stop = () => { monitor.kill("SIGKILL"); };
	process.on("SIGTERM", stop);
	process.on("SIGINT", stop);
	const lines = createInterface({ input: statusPipe });
	lines.on("line", line => {
		try {
			const value: unknown = JSON.parse(line);
			if (!Check(NamespaceSchema, value)) return;
			if (namespace) throw new Error("Bubblewrap repeated namespace identity.");
			const init = identity(value["child-pid"]);
			const status = fs.readFileSync(`/proc/${value["child-pid"]}/status`, "utf8");
			const namespacePids = /^NSpid:\s+(.+)$/m.exec(status)?.[1]?.trim().split(/\s+/);
			const namespaceLink = fs.readlinkSync(`/proc/${value["child-pid"]}/ns/pid`);
			if (!init || namespacePids?.at(-1) !== "1" || namespacePids.length < 2 || namespaceLink !== `pid:[${value["pid-namespace"]}]`) throw new Error("Bubblewrap did not establish an owned PID namespace.");
			namespace = { identity: init, inode: value["pid-namespace"], descriptor: fs.openSync(`/proc/${init.pid}/ns/pid`, "r") };
			const monitorIdentity = monitor.pid ? identity(monitor.pid) : undefined;
			if (!monitorIdentity) throw new Error("Bubblewrap monitor identity is unavailable.");
			lease.updateWriter({ state: "running", pid: process.pid });
			writePrivateAtomicJson(path.join(directory, "owner.json"), { version: 1, owner, monitor: monitorIdentity, namespace: { identity: init, inode: namespace.inode }, runnerProcessInstanceId: raw.runnerProcessInstanceId });
		} catch (error) {
			startupError = error instanceof Error ? error.message : String(error);
			stop();
		}
	});
	const interval = setInterval(() => {
		try {
			if (fs.existsSync(path.join(directory, "stop.json"))) { reason = "stop"; stop(); }
			if (fs.existsSync(path.join(directory, "interrupt.json"))) { reason ??= "interrupt"; interruptAt ??= Date.now(); }
			if (fs.existsSync(path.join(directory, "timeout.json")) || (raw.deadlineAt !== undefined && Date.now() >= raw.deadlineAt)) { reason = "timeout"; stop(); }
			if (interruptAt !== undefined && Date.now() - interruptAt >= 3000) stop();
			if (!authorized && namespace) {
				const proceed = path.join(raw.runDirectory, "runner-startup-proceed.json");
				if (fs.existsSync(proceed)) {
					const value: unknown = JSON.parse(readEnvironmentFile(proceed));
					if (value && typeof value === "object" && "token" in value && value.token === raw.runnerProcessInstanceId) { authorized = true; barrier.end("1"); }
				}
			}
			if (!authorized && Date.now() - startedAt > 20_000) { startupError = "Environment startup barrier expired."; stop(); }
		} catch (error) { startupError = String(error); stop(); }
	}, 25);
	const closed = await new Promise<{ exitCode: number | null; signal: string | null }>(resolve => {
		monitor.on("error", error => { startupError = error.message; });
		monitor.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
	});
	clearInterval(interval);
	lines.close();
	process.off("SIGTERM", stop);
	process.off("SIGINT", stop);
	const deadline = Date.now() + 5000;
	while (namespace && environmentProcessState(namespace.identity) !== "terminated" && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
	const observed = namespace !== undefined && environmentProcessState(namespace.identity) === "terminated";
	if (namespace) fs.closeSync(namespace.descriptor);
	if (observed && lease.release()) {
		const at = Date.now();
		writePrivateAtomicJson(path.join(directory, "process-terminal-candidate.json"), {
			version: 1, runId: binding.runId, runnerProcessInstanceId: raw.runnerProcessInstanceId,
			sessionFile: binding.sessionFile, revivalLeaseToken: lease.owner.token, revivalLeaseReleaseAcknowledged: true,
			expectedWriters: { "0": 1 }, writers: { "0": [{ kind: "pi-writer", processInstanceId: `${raw.runnerProcessInstanceId}:namespace`, attempt: 0, closeObservedAt: at, ...closed, processTree: { state: "observed", mechanism: "linux-pid-namespace", namespaceId: namespace!.inode, verifiedAt: at } }] },
		});
	}
	writePrivateAtomicJson(path.join(directory, "namespace-terminal.json"), { version: 1, observed, at: Date.now(), ...closed, ...(startupError ? { error: startupError } : {}) });
	if (reason || startupError || closed.exitCode !== 0) {
		const statusPath = path.join(raw.runDirectory, "status.json");
		const status: unknown = JSON.parse(readEnvironmentFile(statusPath));
		if (status && typeof status === "object" && !Array.isArray(status)) writePrivateAtomicJson(statusPath, { ...status, pid: process.pid, state: reason === "interrupt" ? "paused" : reason === "stop" ? "stopped" : "failed", completedAt: Date.now(), lastUpdate: Date.now(), ...(startupError ? { error: startupError } : {}) });
	}
	const stagedResult = path.join(raw.runDirectory, "environment-result.json");
	if (observed && fs.existsSync(stagedResult)) {
		const descriptor = fs.openSync(stagedResult, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
		try {
			if (!fs.fstatSync(descriptor).isFile()) throw new Error("Confined result must be a regular file.");
			const result: unknown = JSON.parse(fs.readFileSync(descriptor, "utf8"));
			if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Invalid confined result object.");
			writePrivateAtomicJson(raw.resultDestination, result);
		} finally { fs.closeSync(descriptor); }
	}
	process.exitCode = observed && !startupError ? 0 : 1;
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
