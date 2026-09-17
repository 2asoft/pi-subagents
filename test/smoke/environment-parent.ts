import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerSubagents from "../../index.ts";
import { registerExecutionEnvironment } from "../../src/api/execution-environments.ts";
import { readProcessTerminal } from "../../src/runs/background/process-terminal.ts";
import { readEnvironmentBinding } from "../../src/runs/background/environment-authority.ts";
import { buildPolicy } from "./environment-policy.ts";

async function until(predicate: () => boolean | Promise<boolean>) {
	const deadline = Date.now() + 30_000;
	while (!(await predicate())) {
		if (Date.now() >= deadline) throw new Error("Environment smoke timed out.");
		await new Promise(resolve => setTimeout(resolve, 50));
	}
}
function details(value: unknown): Record<string, unknown> {
	assert.ok(value && typeof value === "object" && !Array.isArray(value));
	return value as Record<string, unknown>;
}

export default function register(pi: ExtensionAPI) {
	const tools = new Map<string, Parameters<ExtensionAPI["registerTool"]>[0]>();
	registerSubagents(new Proxy(pi, { get(target, key) {
		if (key === "registerTool") return (tool: Parameters<ExtensionAPI["registerTool"]>[0]) => { tools.set(tool.name, tool); target.registerTool(tool); };
		return Reflect.get(target, key);
	} }));
	pi.on("session_start", async (_event, ctx) => {
		const root = process.env.PI_ENVIRONMENT_SMOKE_ROOT;
		assert.ok(root);
		const tool = tools.get("subagent");
		const supervisor = tools.get("subagent_supervisor");
		assert.ok(tool && supervisor);
		const timer = setTimeout(() => process.exit(2), 90_000);
		const policyFile = fileURLToPath(new URL("./environment-policy.ts", import.meta.url));
		const providerFile = fileURLToPath(new URL("./environment-provider.ts", import.meta.url));
		const approvedFile = path.join(root, "approved.md");
		const registration = registerExecutionEnvironment({ sessionId: ctx.sessionManager.getSessionId(), name: "synthetic", modulePath: policyFile, policyFiles: [providerFile, approvedFile], buildPolicy });
		try {
			let first: Record<string, unknown>;
			if (process.env.PI_ENVIRONMENT_SMOKE_PHASE === "resume") first = details(JSON.parse(fs.readFileSync(path.join(root, "launch.json"), "utf8")));
			else {
				const launched = await tool.execute("environment-smoke", {
					task: "Ask the parent for the synthetic marker, then report it.", executionEnvironment: "synthetic", cwd: path.join(root, "worktree"),
					async: true, context: "fresh", tools: ["read", "contact_supervisor"],
					inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false, skill: false,
					model: "environment-smoke/local", output: false, acceptance: false,
				}, new AbortController().signal, undefined, ctx);
				assert.notEqual(launched.isError, true, JSON.stringify(launched));
				first = details(launched.details);
				assert.equal(typeof first.asyncDir, "string");
				assert.equal(typeof first.runId, "string");
				fs.writeFileSync(path.join(root, "launch.json"), JSON.stringify(first));
				let requestId: string | undefined;
				await until(async () => {
					const pending = await supervisor.execute("pending", { action: "pending" }, new AbortController().signal, undefined, ctx);
					const rows = details(pending.details).pending;
					if (Array.isArray(rows) && rows.length) { const request = details(rows[0]); if (typeof request.id === "string") requestId = request.id; }
					return requestId !== undefined;
				});
				await supervisor.execute("reply", { action: "reply", replyTo: requestId, message: "amber" }, new AbortController().signal, undefined, ctx);
				await until(() => readProcessTerminal(String(first.asyncDir))?.state === "observed");
				assert.match(fs.readFileSync(path.join(String(first.asyncDir), "output-0.log"), "utf8"), /AMBER_DELIVERED/);
				if (process.env.PI_ENVIRONMENT_SMOKE_PHASE === "start") { console.log("PASS: native confined startup and supervisor reply."); process.exit(0); }
			}
			const runDirectory = String(first.asyncDir);
			const binding = readEnvironmentBinding(runDirectory);
			assert.ok(binding);
			const statusFile = path.join(runDirectory, "status.json");
			const originalStatus = fs.readFileSync(statusFile, "utf8");
			const status = details(JSON.parse(originalStatus));
			const outside = path.join(root, "parent-agent", "AGENTS.md");
			status.sessionFile = outside;
			for (const step of status.steps as Record<string, unknown>[]) step.sessionFile = outside;
			fs.writeFileSync(statusFile, JSON.stringify(status));
			await assert.rejects(() => tool.execute("outside-session", { action: "resume", id: first.runId, message: "MUST_NOT_EXECUTE" }, new AbortController().signal, undefined, ctx), /outside the admitted/);
			fs.writeFileSync(statusFile, originalStatus);
			fs.renameSync(binding.sessionFile, `${binding.sessionFile}.saved`);
			fs.symlinkSync(outside, binding.sessionFile);
			await assert.rejects(() => tool.execute("symlink-session", { action: "resume", id: first.runId, message: "MUST_NOT_EXECUTE" }, new AbortController().signal, undefined, ctx), /symlink/);
			fs.unlinkSync(binding.sessionFile);
			fs.renameSync(`${binding.sessionFile}.saved`, binding.sessionFile);
			const approved = fs.readFileSync(approvedFile, "utf8");
			fs.appendFileSync(approvedFile, "POLICY_DRIFT");
			await assert.rejects(() => tool.execute("definition-drift", { action: "resume", id: first.runId, message: "MUST_NOT_EXECUTE" }, new AbortController().signal, undefined, ctx), /changed/);
			fs.writeFileSync(approvedFile, approved);
			fs.writeFileSync(path.join(runDirectory, "recovery-descriptor.json"), JSON.stringify({ version: 1, sourceRunId: first.runId, model: "forged/model", tools: ["bash"] }));
			const resumed = await tool.execute("environment-resume", { action: "resume", id: first.runId, message: "RESUME_CHECK" }, new AbortController().signal, undefined, ctx);
			assert.notEqual(resumed.isError, true, JSON.stringify(resumed));
			fs.writeFileSync(path.join(root, "resume.json"), JSON.stringify(resumed));
			const second = details(resumed.details);
			assert.equal(typeof second.asyncDir, "string");
			await until(() => readProcessTerminal(String(second.asyncDir))?.state === "observed");
			assert.match(fs.readFileSync(path.join(String(second.asyncDir), "output-0.log"), "utf8"), /RESUME_DELIVERED/);
			const requests = fs.readFileSync(path.join(root, "worktree", "requests.jsonl"), "utf8");
			assert.match(requests, /APPROVED_SDK_CONTEXT/);
			assert.doesNotMatch(requests, /PARENT_RE_CONTEXT_CANARY|MUST_NOT_EXECUTE/);
			for (const run of [first, second]) assert.doesNotMatch(fs.readFileSync(path.join(String(run.asyncDir), "bootstrap.json"), "utf8"), /PARENT_RE_CONTEXT_CANARY/);
			console.log("PASS: native restart/resume, metadata replacement, drift rejection and session/context admission.");
			clearTimeout(timer);
			registration.dispose();
			process.exit(0);
		} catch (error) {
			console.error(error);
			clearTimeout(timer);
			registration.dispose();
			process.exit(1);
		}
	});
}
