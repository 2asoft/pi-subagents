import * as fs from "node:fs";
import * as path from "node:path";
import type { BubblewrapPolicy, Resource, RunnerInvocation } from "../../shared/execution-environments.ts";
import { ENVIRONMENT_AUTHORITY_ROOT } from "./environment-authority.ts";
import { TEMP_ROOT_DIR, RESULTS_DIR } from "../../shared/types.ts";
import { SESSION_LEASES_DIR } from "../shared/session-lease.ts";

function contains(root: string, value: string): boolean {
	const relative = path.relative(root, value);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function canonicalRoot(root: string): string {
	const suffix: string[] = [];
	let current = path.resolve(root);
	while (!fs.existsSync(current)) { suffix.unshift(path.basename(current)); current = path.dirname(current); }
	return path.join(fs.realpathSync(current), ...suffix);
}

/** Compile structured policy only. Namespace, descriptor and command options belong to the extension. */
export function bubblewrapArguments(policy: BubblewrapPolicy, runner: RunnerInvocation, resources: readonly Resource[], definitionFiles: readonly string[]): string[] {
	if (process.platform !== "linux") throw new Error("Execution environments require Linux and bubblewrap.");
	const protectedRoots = [ENVIRONMENT_AUTHORITY_ROOT, SESSION_LEASES_DIR, RESULTS_DIR, path.join(TEMP_ROOT_DIR, "run-fanout-budgets")].map(canonicalRoot);
	const readOnlySources = [...definitionFiles, ...resources.filter(resource => resource.role === "runtime").map(resource => fs.realpathSync(resource.path))];
	const admitWritableSource = (source: string) => {
		if (readOnlySources.some(file => contains(source, file) || contains(file, source))) throw new Error("Execution environment definition or runtime would be worker-writable.");
	};
	const admitSource = (source: string) => {
		if (protectedRoots.some(root => contains(source, root) || contains(root, source))) throw new Error("Host environment authority, leases, results and budgets cannot be mounted into a worker.");
	};
	const args = ["--unshare-all", "--unshare-user", "--unshare-pid", "--new-session", "--die-with-parent", "--json-status-fd", "3", "--block-fd", "4", "--clearenv"];
	if (policy.network === "shared") args.push("--share-net");
	for (const mount of policy.mounts) {
		const destination = path.resolve(mount.destination);
		if (contains("/proc", destination) || contains("/dev", destination) || destination === "/") throw new Error(`Mount destination is reserved by the environment runtime: ${destination}`);
		switch (mount.kind) {
			case "bind": {
				const source = fs.realpathSync(mount.source);
				admitSource(source);
				if (mount.access === "read-write") admitWritableSource(source);
				args.push(mount.access === "read" ? "--ro-bind" : "--bind", source, destination);
				break;
			}
			case "tmpfs": args.push("--tmpfs", destination); break;
			case "directory": args.push("--dir", destination); break;
			case "symlink": args.push("--symlink", mount.target, destination); break;
		}
	}
	// Resource bindings are applied last so policy cannot replace the runtime's
	// admitted files or make read-only bootstrap data writable.
	for (const resource of resources) {
		if (resource.role === "runtime") continue;
		admitSource(fs.realpathSync(resource.path));
		if (resource.access === "read-write") admitWritableSource(fs.realpathSync(resource.path));
		args.push(resource.access === "read" ? "--ro-bind" : "--bind", resource.path, resource.path);
	}
	args.push("--proc", "/proc", "--dev", "/dev", "--chdir", policy.cwd);
	for (const [key, value] of Object.entries({ ...policy.env, ...runner.env, PI_CODING_AGENT_DIR: policy.context.agentDirectory })) args.push("--setenv", key, value);
	args.push("--", runner.executable, ...runner.args);
	return args;
}
