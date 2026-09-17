import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { EnvironmentInput, BubblewrapPolicy } from "../../src/api/execution-environments.ts";

export function buildPolicy(input: EnvironmentInput): BubblewrapPolicy {
	const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
	const root = path.dirname(input.runner.cwd);
	const agentDirectory = path.join(root, "child-agent");
	return {
		mounts: [
			...["/usr", "/lib", "/lib64", repository, path.dirname(input.runner.executable)].map(source => ({ kind: "bind" as const, source, destination: source, access: "read" as const })),
			...[input.runner.cwd, agentDirectory].map(source => ({ kind: "bind" as const, source, destination: source, access: "read-write" as const })),
			{ kind: "bind", source: path.join(root, "approved.md"), destination: path.join(root, "approved.md"), access: "read" },
		],
		cwd: input.runner.cwd, env: { HOME: agentDirectory, PI_OFFLINE: "1" }, network: "isolated",
		context: { agentDirectory, instructionFiles: [path.join(root, "approved.md")], skillFiles: [], extensionFiles: [path.join(repository, "test/smoke/environment-provider.ts")] },
	};
}
