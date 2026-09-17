import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-environment-consumer-"));
const agent = path.join(root, "agent");
const consumer = path.join(root, "registration.ts");
fs.mkdirSync(agent);
fs.writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ packages: [repository] }));
fs.writeFileSync(consumer, `import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function register(pi: ExtensionAPI) {
  let dispose: (() => void) | undefined;
  pi.on("session_shutdown", () => {
    if (dispose) { dispose(); console.log(JSON.stringify({ probe: "external-environment-registration", disposed: true })); }
  });
  pi.on("session_start", (_event, ctx) => {
    const api: unknown = Reflect.get(globalThis, Symbol.for("pi-subagents.execution-environment-api.v1"));
    if (!api || typeof api !== "object" || !("version" in api) || api.version !== 1 || !("register" in api) || typeof api.register !== "function") throw new Error("Execution environment registration API unavailable; enable pi-subagents.");
    const definition = { sessionId: ctx.sessionManager.getSessionId(), name: "external-consumer", modulePath: fileURLToPath(import.meta.url), buildPolicy() { throw new Error("Registration must not launch work."); } };
    const registration: unknown = api.register(definition);
    assert.ok(registration && typeof registration === "object" && "dispose" in registration && typeof registration.dispose === "function");
    assert.throws(() => api.register(definition), /already registered/);
    const release = registration.dispose;
    dispose = () => { release.call(registration); };
    console.log(JSON.stringify({ probe: "external-environment-registration", registered: true }));
    ctx.shutdown();
  });
}
`);
console.log(`Evidence: ${root}`);
for (const [name, extensions, available] of [
	["configured-package", ["-e", consumer], true],
	["consumer-first", ["--no-extensions", "-e", consumer, "-e", path.join(repository, "index.ts")], true],
	["package-first", ["--no-extensions", "-e", path.join(repository, "index.ts"), "-e", consumer], true],
	["unavailable", ["--no-extensions", "-e", consumer], false],
]) {
	const result = spawnSync(process.argv[2] ?? "pi", ["--offline", "--mode", "json", "--no-session", "--no-skills", ...extensions], { cwd: root, encoding: "utf8", timeout: 30_000, env: { ...process.env, PI_CODING_AGENT_DIR: agent, PI_SUBAGENTS_TEMP_ROOT: path.join(root, "runtime") } });
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
	fs.writeFileSync(path.join(root, `${name}.log`), output);
	assert.equal(result.status, 0, `${name}: ${result.error ?? output}`);
	assert.match(output, available ? /"registered":true/ : /registration API unavailable/);
	if (available) assert.match(output, /"disposed":true/);
	else assert.doesNotMatch(output, /"registered":true/);
	console.log(`PASS: ${name}`);
}
