import * as fs from "node:fs";
import * as path from "node:path";
import { environmentAuthorityDirectory } from "./environment-authority.ts";

export interface EnvironmentProcessIdentity {
	pid: number;
	start: string;
	boot: string;
}
interface EnvironmentOwner {
	version: 1;
	owner: EnvironmentProcessIdentity;
	monitor: EnvironmentProcessIdentity;
	namespace: { identity: EnvironmentProcessIdentity; inode: number };
	runnerProcessInstanceId: string;
}

function parseProcessIdentity(value: unknown): EnvironmentProcessIdentity {
	if (!value || typeof value !== "object" || Array.isArray(value)
		|| !("pid" in value) || typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid < 1
		|| !("start" in value) || typeof value.start !== "string"
		|| !("boot" in value) || typeof value.boot !== "string") {
		throw new Error("Invalid authoritative environment process identity.");
	}
	return { pid: value.pid, start: value.start, boot: value.boot };
}

export function captureEnvironmentProcess(pid: number): EnvironmentProcessIdentity | undefined {
	try {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		const fields = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
		const start = fields[19];
		if (!start || fields[0] === "Z" || fields[0] === "X") return undefined;
		return { pid, start, boot: fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() };
	} catch { return undefined; }
}
export function environmentProcessState(expected: EnvironmentProcessIdentity): "alive" | "terminated" | "unknown" {
	let stat: string;
	try { stat = fs.readFileSync(`/proc/${expected.pid}/stat`, "utf8"); }
	catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ESRCH" ? "terminated" : "unknown"; }
	const fields = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
	if (!fields[19]) return "unknown";
	if (fields[0] === "Z" || fields[0] === "X") return "terminated";
	try {
		const boot = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
		return fields[19] === expected.start && boot === expected.boot ? "alive" : "terminated";
	} catch { return "unknown"; }
}
export function environmentProcessAlive(expected: EnvironmentProcessIdentity): boolean {
	return environmentProcessState(expected) === "alive";
}
export function readEnvironmentOwner(runDirectory: string): EnvironmentOwner | undefined {
	const file = path.join(environmentAuthorityDirectory(runDirectory), "owner.json");
	if (!fs.existsSync(file)) return undefined;
	const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
	if (!value || typeof value !== "object" || Array.isArray(value)
		|| !("version" in value) || value.version !== 1 || !("owner" in value) || !("monitor" in value)
		|| !("namespace" in value) || !("runnerProcessInstanceId" in value) || typeof value.runnerProcessInstanceId !== "string") {
		throw new Error("Invalid authoritative environment process identity.");
	}
	const namespace = value.namespace;
	if (!namespace || typeof namespace !== "object" || Array.isArray(namespace)
		|| !("identity" in namespace) || !("inode" in namespace) || typeof namespace.inode !== "number"
		|| !Number.isSafeInteger(namespace.inode) || namespace.inode < 1) {
		throw new Error("Invalid authoritative environment process identity.");
	}
	return { version: 1, owner: parseProcessIdentity(value.owner), monitor: parseProcessIdentity(value.monitor),
		namespace: { identity: parseProcessIdentity(namespace.identity), inode: namespace.inode }, runnerProcessInstanceId: value.runnerProcessInstanceId };
}
