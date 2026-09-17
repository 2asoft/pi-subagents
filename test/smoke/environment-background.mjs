import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-environment-native-"));
const here = path.dirname(fileURLToPath(import.meta.url));
const executable = process.argv[2] ?? "pi";
for (const directory of ["parent-agent", "child-agent", "worktree"]) fs.mkdirSync(path.join(root, directory));
fs.writeFileSync(path.join(root, "parent-agent", "AGENTS.md"), "PARENT_RE_CONTEXT_CANARY\n");
fs.writeFileSync(path.join(root, "approved.md"), "APPROVED_SDK_CONTEXT\n");
const session = path.join(root, "parent.jsonl");
fs.writeFileSync(session, `${JSON.stringify({ type: "session", version: 3, id: randomUUID(), timestamp: new Date().toISOString(), cwd: root })}\n`);
assert.equal(spawnSync("git", ["-C", path.join(root, "worktree"), "init", "-q"]).status, 0);
console.log(`Evidence: ${root}`);
try {
	for (const phase of ["start", "resume"]) {
		const result = spawnSync(executable, ["--mode", "rpc", "--session", session, "--no-extensions", "--no-skills", "-e", path.join(here, "environment-provider.ts"), "-e", path.join(here, "environment-parent.ts")], {
			cwd: root, timeout: 100_000, maxBuffer: 8 * 1024 * 1024, encoding: "utf8",
			env: { ...process.env, PI_ENVIRONMENT_SMOKE_PHASE: phase, PI_ENVIRONMENT_SMOKE_ROOT: root, PI_CODING_AGENT_DIR: path.join(root, "parent-agent"), PI_SUBAGENTS_TEMP_ROOT: path.join(root, "runtime") },
		});
		const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
		fs.writeFileSync(path.join(root, `${phase}.log`), output);
		assert.equal(result.status, 0, `${phase} failed: ${result.error ?? output}`);
		assert.match(output, /PASS:/);
		console.log(output.split("\n").filter(line => line.startsWith("PASS:")).join("\n"));
	}
} finally {
	const owners = path.join(root, "runtime", "environment-owners");
	if (fs.existsSync(owners)) for (const run of fs.readdirSync(owners)) fs.writeFileSync(path.join(owners, run, "stop.json"), "{}\n");
}
