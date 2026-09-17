import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { DIRS, type SubagentState } from "../../src/shared/types.ts";
import { resolveCurrentSessionId } from "../../src/shared/session-identity.ts";
import { restoreForegroundRunHistory } from "../../src/runs/foreground/foreground-history.ts";
import { readAsyncRecoveryDescriptor } from "../../src/runs/background/async-resume.ts";
import { describe, it } from "node:test";
import { createSubagentExecutor, installSingleExecutionHooks, makeExecutor, mockPi, readCall, readCallArgs, readAllCallArgs, tempDir } from "../support/single-execution-fixture.ts";
import { createEventBus, makeMinimalCtx } from "../support/helpers.ts";

describe("direct skill delegation", () => {
	installSingleExecutionHooks();

	it("launches a task without a profile and preserves its instructions and tools", async () => {
		mockPi.onCall({ output: "ISSUES: the implementation does not satisfy the supplied contract." });
		const task = "Review this implementation.\nReturn findings only. Do not edit files.\n";
		const instructions = "Apply the supplied rubric verbatim. Return PASS, ISSUES, or BLOCKED with evidence.";
		const executor = makeExecutor([], {}, false);
		const result = await executor.executePublic("direct-review", {
			task, instructions, tools: ["read", "grep"], extensions: [], async: false, model: "mock/model:high",
		}, new AbortController().signal, undefined, makeMinimalCtx(tempDir));
		assert.notEqual(result.isError, true, JSON.stringify(result));
		const call = readCall();
		assert.deepEqual(call.launch?.tools, ["read", "grep"]);
		assert.equal(readCallArgs().at(-1), task);
		assert.equal(call.launch?.model, "mock/model:high");
		const prompt = call.systemPrompts?.map(part => part.text ?? "").join("\n") ?? "";
		assert.ok(prompt.includes(instructions));
		assert.doesNotMatch(prompt, /Acceptance Contract|Intercom orchestration channel|Runtime output path override|You are a child subagent/);
		assert.equal(result.details?.results[0]?.execution?.success, true);
		assert.equal(result.details?.results[0]?.acceptance?.status, "not-required");
	});

	it("runs an explicitly requested acceptance gate", async () => {
		mockPi.onCall({ output: "Completed the assigned verification." });
		const executor = makeExecutor([], {}, false);
		const result = await executor.executePublic("direct-gate", {
			task: "Verify the supplied evidence.", tools: [], extensions: [], async: false,
			acceptance: { level: "verified", verify: [{ id: "requested-gate", command: "exit 1" }] },
		}, new AbortController().signal, undefined, makeMinimalCtx(tempDir));
		assert.equal(result.details?.results[0]?.acceptance?.status, "rejected", JSON.stringify(result));
		assert.equal(result.details?.results[0]?.acceptance?.verifyRuns?.[0]?.status, "failed");
	});

	it("launches independent workflow tasks without profiles", async () => {
		mockPi.onCall({ output: "PASS" });
		const executor = makeExecutor([], {}, false);
		const result = await executor.executePublic("direct-parallel", {
			async: false, mission: false,
			workflowScript: `return runs.all([
				{ key: "a", task: "Review A", tools: ["read"], extensions: [] },
				{ key: "b", task: "Review B", tools: ["read", "grep"], extensions: [] }
			]);`,
		}, new AbortController().signal, undefined, makeMinimalCtx(tempDir));
		assert.notEqual(result.isError, true, JSON.stringify(result));
		const calls = readAllCallArgs();
		assert.equal(calls.length, 2, JSON.stringify(result));
		assert.deepEqual(new Map(calls.map(args => [args.at(-1), args[args.indexOf("--tools") + 1]])), new Map([["Review A", "read"], ["Review B", "read,grep"]]));
	});

	it("awaits a direct background workflow child through terminal output", { timeout: 30_000 }, async () => {
		mockPi.onCall({ output: "DIRECT_BACKGROUND_COMPLETE" });
		const executor = makeExecutor([], {}, false);
		const result = await executor.executePublic("direct-background", {
			async: false, mission: false,
			workflowScript: `return (await runs.run("background", { task: "Run the verification", async: true, tools: [], extensions: [] })).output;`,
		}, new AbortController().signal, undefined, makeMinimalCtx(tempDir));
		assert.notEqual(result.isError, true, JSON.stringify(result));
		assert.match(result.content.map(part => part.text).join("\n"), /DIRECT_BACKGROUND_COMPLETE/);
		assert.equal(readAllCallArgs().length, 1);
	});

	for (const workflow of [false, true]) it(`returns completed output and accurate resumability after persistence failure, workflow=${workflow}`, { timeout: 10_000 }, async (t) => {
		const release = path.join(tempDir, "release-child");
		mockPi.onCall({ output: "COMPLETED REVIEW", waitForPath: release });
		const executor = makeExecutor([], {}, false);
		const ctx = makeMinimalCtx(tempDir);
		const params = workflow
			? { async: false, mission: false, workflowScript: 'return await runs.run("review", { task: "Review the evidence.", tools: [], async: false });' }
			: { task: "Review the evidence.", tools: [], async: false };
		const pending = executor.executePublic("persistence-failure", params, t.signal, undefined, ctx);
		while (!mockPi.sessions[0]) await setTimeout(5, undefined, { signal: t.signal });
		const storage = mockPi.sessions[0].launch.storage;
		assert.equal(storage.kind, "file");
		fs.mkdirSync(path.join(path.dirname(storage.sessionFile), "direct-task.json"));
		fs.writeFileSync(release, "");
		const result = await pending;
		assert.notEqual(result.isError, true, JSON.stringify(result));
		assert.equal(result.details.results[0]?.finalOutput, "COMPLETED REVIEW");
		let runId = result.details.runId;
		if (workflow) {
			const child = result.details.workflow?.value;
			assert.ok(child && typeof child === "object" && !Array.isArray(child));
			assert.equal(child.ok, true);
			assert.equal(child.output, "COMPLETED REVIEW");
			assert.match(child.resumeWarning, /Cannot retain direct task configuration/);
			assert.deepEqual(child.resumability, { state: "not-resumable", reason: child.resumeWarning });
			runId = child.runId;
		} else {
			assert.match(result.details.resumeWarning, /Cannot retain direct task configuration/);
		}
		assert.match(result.content.map(part => part.text).join("\n"), /COMPLETED REVIEW[\s\S]*Cannot retain direct task configuration/);
		const resumed = await executor.executePublic("failed-retention", {
			action: "resume", id: runId, message: "Continue.",
		}, new AbortController().signal, undefined, ctx);
		assert.equal(resumed.isError, true);
		assert.equal(readAllCallArgs().length, 1);
	});

	it("restores large direct instructions and the execution configuration after restarting the parent", { timeout: 30_000 }, async () => {
		mockPi.onCall({ output: "VERIFIED" });
		const instructions = "Exact retained instructions.\n" + "Evidence must accompany every finding.\n".repeat(2000);
		const extension = path.join(tempDir, "probe.ts");
		fs.writeFileSync(extension, "export default function () {}\n");
		const ctx = makeMinimalCtx(tempDir);
		const first = await makeExecutor([], {}, false).executePublic("before-restart", {
			task: "Verify the initial evidence.", instructions, tools: ["read"], extensions: [extension],
			context: "fresh", inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false, async: false,
		}, new AbortController().signal, undefined, ctx);
		assert.notEqual(first.isError, true, JSON.stringify(first));
		const restored: SubagentState = {
			baseCwd: tempDir, currentSessionId: resolveCurrentSessionId(ctx.sessionManager),
			asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null,
		};
		restoreForegroundRunHistory(restored);
		assert.ok(first.details?.runId);
		assert.ok(restored.foregroundRuns?.has(first.details.runId), "completed direct task must remain restorable after restart");
		assert.ok(createSubagentExecutor);
		const executor = createSubagentExecutor({
			pi: { events: createEventBus(), getSessionName: () => undefined }, state: restored,
			config: {}, asyncByDefault: false, tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => path.join(tempDir, ".pi", "subagents", "sessions"),
			expandTilde: value => value, discoverAgents: () => ({ agents: [] }), allowMutatingManagementActions: true,
		});
		const followup = "  Review the additional evidence.\n";
		const result = await executor.executePublic("after-restart", {
			async: false, mission: false,
			workflowScript: `return await runs.run("followup", { resume: ${JSON.stringify(first.details?.runId)}, task: ${JSON.stringify(followup)} });`,
		}, new AbortController().signal, undefined, ctx);
		assert.notEqual(result.isError, true, JSON.stringify(result));
		assert.equal(readAllCallArgs().length, 2, JSON.stringify(result));
		assert.equal(readCallArgs().at(-1), followup);
		const call = readCall();
		assert.ok(call.runtime?.runId);
		const descriptor = readAsyncRecoveryDescriptor(path.join(DIRS.async, call.runtime.runId));
		assert.ok(descriptor);
		assert.equal(descriptor.context, "fresh");
		assert.ok(descriptor.systemPrompt.includes(instructions));
		assert.deepEqual(descriptor.tools, ["read"]);
		assert.deepEqual(descriptor.extensions, [extension]);
		assert.equal(descriptor.inheritProjectContext, false);
		assert.equal(descriptor.inheritGlobalContext, false);
		assert.equal(descriptor.inheritSkills, false);
		const configPath = restored.foregroundRuns?.get(first.details.runId)?.children[0]?.resumeContract?.directTaskPath;
		assert.ok(configPath);
		fs.unlinkSync(configPath);
		const missing = await executor.executePublic("missing-config", {
			action: "resume", id: first.details.runId, message: "Try another review.",
		}, new AbortController().signal, undefined, ctx);
		assert.equal(missing.isError, true);
		assert.match(missing.content.map(part => part.text).join("\n"), /Cannot restore direct task configuration/);
		assert.equal(readAllCallArgs().length, 2, "missing configuration must not launch a child with default access");
	});

	it("resumes a direct foreground task through the background runner with its original tool contract", { timeout: 30_000 }, async () => {
		mockPi.onCall({ output: "PASS" });
		const executor = makeExecutor([], {}, false);
		const result = await executor.executePublic("direct-resume", {
			async: false, mission: false,
			workflowScript: `const first = await runs.run("first", {
				task: "Review the initial evidence.", instructions: "EXACT_REVIEW_CONTRACT", tools: ["read", "contact_supervisor"], extensions: [],
				inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false
			});
			const second = await runs.run("followup", { resume: first.runId, task: "  Review the additional evidence.  " });
			return { first, second };`,
		}, new AbortController().signal, undefined, makeMinimalCtx(tempDir));
		assert.notEqual(result.isError, true, JSON.stringify(result));
		const calls = readAllCallArgs(true);
		assert.equal(calls.length, 2, JSON.stringify(result));
		assert.deepEqual(new Set(calls.map(args => args.at(-1))), new Set(["Review the initial evidence.", "  Review the additional evidence.  "]));
		for (const args of calls) assert.equal(args[args.indexOf("--tools") + 1], "read,contact_supervisor");
	});
});
