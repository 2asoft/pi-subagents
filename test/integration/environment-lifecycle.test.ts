import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { TEMP_ROOT_DIR } from "../../src/shared/types.ts";
import { createEnvironmentBinding, environmentAuthorityDirectory } from "../../src/runs/background/environment-authority.ts";
import { bubblewrapArguments } from "../../src/runs/background/bubblewrap-policy.ts";
import { requestAsyncStop, requestAsyncInterrupt, requestAsyncTimeout } from "../../src/runs/background/control-channel.ts";
import { finalizeProcessTerminal, readProcessTerminal } from "../../src/runs/background/process-terminal.ts";
import { recoverEnvironmentTermination } from "../../src/runs/background/environment-termination.ts";
import { readEnvironmentOwner, environmentProcessState } from "../../src/runs/background/environment-process-identity.ts";
import { inspectSessionLease } from "../../src/runs/shared/session-lease.ts";

async function until(predicate: () => boolean) {
	const deadline = Date.now() + 15_000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for environment evidence.");
		await new Promise(resolve => setTimeout(resolve, 20));
	}
}

for (const action of ["complete", "stop", "interrupt", "timeout", "launcher-death", "monitor-death", "fifo-result", "fifo-events", "symlink-events"] as const) {
	it(`observes namespace teardown after ${action}, including orphaned detached descendants`, { timeout: 35_000, skip: process.platform !== "linux" || !fs.existsSync("/usr/bin/bwrap") }, async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "environment-lifecycle-"));
		const runId = randomUUID();
		const runDirectory = path.join(root, runId);
		const sessionRoot = path.join(runDirectory, "session");
		fs.mkdirSync(sessionRoot, { recursive: true });
		const sessionFile = path.join(sessionRoot, "session.jsonl");
		fs.writeFileSync(sessionFile, "");
		const bootstrapPath = path.join(runDirectory, "bootstrap.json");
		fs.writeFileSync(bootstrapPath, JSON.stringify({ task: "admitted" }));
		const instance = randomUUID();
		createEnvironmentBinding({ runDirectory, sessionRoot, sessionFile, environment: { name: "synthetic", digest: "test", files: [] } });
		const authority = environmentAuthorityDirectory(runDirectory);
		const outsideEvents = path.join(root, "outside-events");
		fs.writeFileSync(outsideEvents, "OUTSIDE_EVENT_CANARY");
		const grandchildFile = path.join(runDirectory, "grandchild");
		const readyFile = path.join(runDirectory, "worker-ready");
		const middle = `const fs=require('node:fs');const {spawn}=require('node:child_process');const grand=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});grand.unref();fs.writeFileSync(${JSON.stringify(grandchildFile)},String(grand.pid));process.exit(0)`;
		const worker = `const fs=require('node:fs');const {spawn,spawnSync}=require('node:child_process');const middle=spawn(process.execPath,['-e',${JSON.stringify(middle)}],{detached:true,stdio:'ignore'});middle.on('exit',()=>{const grand=Number(fs.readFileSync(${JSON.stringify(grandchildFile)},'utf8'));const stat=fs.readFileSync('/proc/'+grand+'/stat','utf8');const fields=stat.slice(stat.lastIndexOf(')')+1).trim().split(/\\s+/);if(Number(fields[1])!==1||Number(fields[2])!==grand)throw Error('Expected orphaned detached grandchild');fs.writeFileSync(${JSON.stringify(readyFile)},String(process.pid))});setInterval(()=>{if(fs.existsSync(${JSON.stringify(path.join(runDirectory, "finish"))})){if(${JSON.stringify(action)}==='fifo-result')spawnSync('/usr/bin/mkfifo',[${JSON.stringify(path.join(runDirectory, "environment-result.json"))}]);if(${JSON.stringify(action)}==='fifo-events')spawnSync('/usr/bin/mkfifo',[${JSON.stringify(path.join(runDirectory, "events.jsonl"))}]);if(${JSON.stringify(action)}==='symlink-events')fs.symlinkSync(${JSON.stringify(outsideEvents)},${JSON.stringify(path.join(runDirectory, "events.jsonl"))});process.exit(0)}},20)`;
		const runner = { executable: "/usr/bin/node", args: ["-e", worker], cwd: runDirectory, env: {} };
		const mounts = ["/usr", "/lib", "/lib64"].map(source => ({ kind: "bind" as const, source, destination: source, access: "read" as const }));
		const args = bubblewrapArguments({ mounts, cwd: runDirectory, env: {}, network: "isolated", context: { agentDirectory: "/unused", instructionFiles: [], skillFiles: [], extensionFiles: [] } }, runner, [{ role: "run", path: runDirectory, kind: "directory", access: "read-write" }, { role: "bootstrap", path: bootstrapPath, kind: "file", access: "read" }], []);
		const launcher = fileURLToPath(new URL("../../src/runs/background/environment-launcher.ts", import.meta.url));
		const payload = JSON.stringify({ runDirectory, bootstrapPath, runnerProcessInstanceId: instance, args, cwd: root, resultDestination: path.join(root, "result.json") });
		const log = fs.openSync(path.join(root, "owner.log"), "a");
		let directOwner: ChildProcess | undefined;
		let orchestrator: ChildProcess | undefined;
		if (action === "launcher-death") {
			directOwner = spawn(process.execPath, ["--experimental-strip-types", launcher], { stdio: ["pipe", log, log], env: { PATH: process.env.PATH, PI_SUBAGENTS_TEMP_ROOT: TEMP_ROOT_DIR } });
			directOwner.stdin!.end(payload);
		} else {
			orchestrator = spawn(process.execPath, ["-e", `const fs=require('node:fs');const {spawn}=require('node:child_process');const log=fs.openSync(${JSON.stringify(path.join(root, "owner.log"))},'a');const child=spawn(process.execPath,['--experimental-strip-types',${JSON.stringify(launcher)}],{detached:true,stdio:['pipe',log,log],env:{PATH:process.env.PATH,PI_SUBAGENTS_TEMP_ROOT:${JSON.stringify(TEMP_ROOT_DIR)}}});child.stdin.end(${JSON.stringify(payload)},()=>{child.unref();process.exit(0)});`], { stdio: "ignore" });
		}
		fs.closeSync(log);
		const sentinel = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
		let passed = false;
		try {
			if (orchestrator) { await new Promise<void>(resolve => orchestrator!.once("close", () => resolve())); assert.equal(orchestrator.exitCode, 0); }
			await until(() => readEnvironmentOwner(runDirectory) !== undefined);
			fs.writeFileSync(path.join(runDirectory, "runner-startup-proceed.json"), JSON.stringify({ action: "proceed", token: instance }));
			await until(() => fs.existsSync(readyFile));
			assert.notEqual(fs.readFileSync(readyFile, "utf8"), "1");
			fs.writeFileSync(path.join(runDirectory, "status.json"), JSON.stringify({ state: "running", runId, pid: sentinel.pid }));
			fs.writeFileSync(path.join(runDirectory, "process-terminal-candidate.json"), JSON.stringify({ state: "observed", pid: sentinel.pid }));
			const owner = readEnvironmentOwner(runDirectory)!;
			assert.equal(environmentProcessState({ ...owner.owner, start: `${owner.owner.start}0` }), "terminated", "PID reuse does not preserve an old identity");
			assert.equal(inspectSessionLease(sessionFile).state, "owned");
			switch (action) {
				case "complete": case "fifo-result": case "fifo-events": case "symlink-events": fs.writeFileSync(path.join(runDirectory, "finish"), ""); break;
				case "stop": requestAsyncStop(runDirectory); break;
				case "interrupt": requestAsyncInterrupt(runDirectory); break;
				case "timeout": requestAsyncTimeout(runDirectory); break;
				case "launcher-death": directOwner!.kill("SIGKILL"); break;
				case "monitor-death": assert.equal(environmentProcessState(owner.monitor), "alive"); process.kill(owner.monitor.pid, "SIGKILL"); break;
			}
			await until(() => [owner.owner, owner.monitor, owner.namespace.identity].every(identity => environmentProcessState(identity) === "terminated"));
			assert.equal(sentinel.exitCode, null);
			if (action === "launcher-death") {
				const initial = finalizeProcessTerminal(runDirectory, runId, { processInstanceId: instance, closeObservedAt: Date.now(), exitCode: null, signal: "SIGKILL" });
				assert.equal(initial.state, "unknown", "production close callback precedes recovered evidence");
			}
			assert.equal(recoverEnvironmentTermination(runDirectory), true);
			assert.equal(fs.readFileSync(outsideEvents, "utf8"), "OUTSIDE_EVENT_CANARY");
			assert.equal(inspectSessionLease(sessionFile).state, "free");
			const proof = readProcessTerminal(runDirectory);
			assert.equal(proof?.state, "observed");
			if (proof?.state === "observed") assert.ok(proof.instances.some(record => record.kind === "pi-writer" && record.processTree.state === "observed" && record.processTree.mechanism === "linux-pid-namespace"));
			if (action === "fifo-result") assert.match(fs.readFileSync(path.join(root, "owner.log"), "utf8"), /regular file/);
			passed = true;
		} finally {
			requestAsyncStop(runDirectory);
			sentinel.kill("SIGKILL");
			orchestrator?.kill("SIGKILL");
			directOwner?.kill("SIGKILL");
			if (passed) { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(authority, { recursive: true, force: true }); }
			else console.error(`Preserved failed environment fixture: ${root}`);
		}
	});
}
