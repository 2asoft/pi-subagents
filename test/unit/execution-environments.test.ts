import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { it } from "node:test";
import { registerExecutionEnvironment, resolveExecutionEnvironment, buildEnvironmentPolicy, publishExecutionEnvironmentAPI } from "../../src/shared/execution-environments.ts";

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

it("publishes the shared registrar and withdraws only its own API instance", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "environment-api-"));
	const modulePath = path.join(root, "policy.mjs");
	fs.writeFileSync(modulePath, "export default 1;");
	const key = Symbol.for("pi-subagents.execution-environment-api.v1");
	const withdraw = publishExecutionEnvironmentAPI();
	try {
		const api: unknown = Reflect.get(globalThis, key);
		assert.ok(api && typeof api === "object" && "register" in api && typeof api.register === "function");
		assert.equal(Object.isFrozen(api), true);
		const sessionId = randomUUID();
		const registration: unknown = api.register({ sessionId, name: "consumer", modulePath, buildPolicy() { throw new Error("Not called during registration."); } });
		assert.equal(resolveExecutionEnvironment(sessionId, "consumer", []).identity.name, "consumer");
		assert.ok(registration && typeof registration === "object" && "dispose" in registration && typeof registration.dispose === "function");
		registration.dispose();
		const withdrawReplacement = publishExecutionEnvironmentAPI();
		withdraw();
		const replacement: unknown = Reflect.get(globalThis, key);
		assert.ok(replacement && typeof replacement === "object" && "register" in replacement && typeof replacement.register === "function");
		const renewed: unknown = replacement.register({ sessionId, name: "consumer", modulePath, buildPolicy() { throw new Error("Not called during registration."); } });
		assert.ok(renewed && typeof renewed === "object" && "dispose" in renewed && typeof renewed.dispose === "function");
		renewed.dispose();
		assert.throws(() => resolveExecutionEnvironment(sessionId, "consumer", []), /not registered/);
		withdrawReplacement();
		assert.equal(Reflect.get(globalThis, key), undefined);
	} finally { withdraw(); fs.rmSync(root, { recursive: true, force: true }); }
});

for (const firstToWithdraw of [0, 1]) {
	it(`keeps another loader's API available after publisher ${firstToWithdraw} withdraws`, async () => {
		const copy: typeof import("../../src/shared/execution-environments.ts") = await import(`${new URL("../../src/shared/execution-environments.ts", import.meta.url).href}?publisher-loader`);
		const key = Symbol.for("pi-subagents.execution-environment-api.v1");
		const first = publishExecutionEnvironmentAPI();
		const firstAPI: unknown = Reflect.get(globalThis, key);
		const second = copy.publishExecutionEnvironmentAPI();
		const secondAPI: unknown = Reflect.get(globalThis, key);
		const withdrawals = [first, second];
		try {
			withdrawals[firstToWithdraw]();
			assert.equal(Reflect.get(globalThis, key), firstToWithdraw === 0 ? secondAPI : firstAPI);
			withdrawals[firstToWithdraw]();
			assert.equal(Reflect.get(globalThis, key), firstToWithdraw === 0 ? secondAPI : firstAPI);
			withdrawals[1 - firstToWithdraw]();
			assert.equal(Reflect.get(globalThis, key), undefined);
		} finally { first(); second(); }
	});
}

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
