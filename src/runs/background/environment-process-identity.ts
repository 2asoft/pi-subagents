import * as fs from "node:fs";
import * as path from "node:path";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { environmentAuthorityDirectory } from "./environment-authority.ts";

const IdentitySchema = Type.Object({ pid: Type.Integer({ minimum: 1 }), start: Type.String(), boot: Type.String() });
const OwnerSchema = Type.Object({ version: Type.Literal(1), owner: IdentitySchema, monitor: IdentitySchema, namespace: Type.Object({ identity: IdentitySchema, inode: Type.Integer({ minimum: 1 }) }), runnerProcessInstanceId: Type.String() });
export type EnvironmentProcessIdentity = Static<typeof IdentitySchema>;

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
export function readEnvironmentOwner(runDirectory: string): Static<typeof OwnerSchema> | undefined {
	const file = path.join(environmentAuthorityDirectory(runDirectory), "owner.json");
	if (!fs.existsSync(file)) return undefined;
	const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
	if (!Check(OwnerSchema, value)) throw new Error("Invalid authoritative environment process identity.");
	return value;
}
