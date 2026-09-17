import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { it } from "node:test";
import { registerExecutionEnvironment, resolveExecutionEnvironment, buildEnvironmentPolicy } from "../../src/shared/execution-environments.ts";

it("shares trusted registrations across loader instances and pins definition bytes", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "environment-registry-"));
	const modulePath = path.join(root, "adapter.mjs");
	fs.writeFileSync(modulePath, "export const version = 1;\n");
	const sessionId = randomUUID();
	const registration = registerExecutionEnvironment({ sessionId, name: "synthetic", modulePath, buildPolicy(input) {
		assert.equal(Object.isFrozen(input.runner.env), true);
		assert.equal(Object.isFrozen(input.resources), true);
		return { mounts: [], network: "isolated", cwd: root, env: {}, context: { agentDirectory: root, instructionFiles: [], skillFiles: [], extensionFiles: [] } };
	} });
	try {
		const copy: typeof import("../../src/shared/execution-environments.ts") = await import(`${new URL("../../src/shared/execution-environments.ts", import.meta.url).href}?separate-loader`);
		const definition = copy.resolveExecutionEnvironment(sessionId, "synthetic", []);
		assert.throws(() => resolveExecutionEnvironment(randomUUID(), "synthetic", []), /not registered/);
		assert.throws(() => resolveExecutionEnvironment(sessionId, "synthetic", [root]), /worker-writable/);
		const wrapped = buildEnvironmentPolicy(definition, { runId: randomUUID(), launchKind: "start", runner: { executable: "/usr/bin/node", args: [], cwd: root, env: {} }, resources: [] });
		assert.equal(wrapped.network, "isolated");
		fs.appendFileSync(modulePath, "// changed policy\n");
		assert.throws(() => copy.resolveExecutionEnvironment(sessionId, "synthetic", [], definition.identity), /changed/);
	} finally {
		registration.dispose();
		fs.rmSync(root, { recursive: true, force: true });
	}
	assert.throws(() => resolveExecutionEnvironment(sessionId, "synthetic", []), /not registered/);
});

it("rejects a retargeted definition symlink", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "environment-symlink-"));
	const first = path.join(root, "first.mjs");
	const second = path.join(root, "second.mjs");
	const alias = path.join(root, "policy.mjs");
	fs.writeFileSync(first, "export default 1;");
	fs.writeFileSync(second, "export default 1;");
	fs.symlinkSync(first, alias);
	const sessionId = randomUUID();
	const registration = registerExecutionEnvironment({ sessionId, name: "symlink", modulePath: alias, buildPolicy() { throw new Error("Policy must not execute during resolution."); } });
	try {
		const initial = resolveExecutionEnvironment(sessionId, "symlink", []);
		fs.unlinkSync(alias);
		fs.symlinkSync(second, alias);
		assert.throws(() => resolveExecutionEnvironment(sessionId, "symlink", [], initial.identity), /changed/);
	} finally { registration.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
});
