import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { SubagentRunConfig } from "./subagent-runner.ts";
import { buildEnvironmentPolicy, resolveExecutionEnvironment, type Resource, type RunnerInvocation } from "../../shared/execution-environments.ts";
import { DIRS } from "../../shared/types.ts";
import { getRunFanoutBudgetSnapshot } from "../shared/run-fanout-budget.ts";
import { writePrivateAtomicJson } from "../../shared/atomic-json.ts";
import { resolveSupervisorChannelDir } from "../../intercom/native-supervisor-channel.ts";
import { admitEnvironmentSession, createEnvironmentBinding, environmentAuthorityDirectory, readEnvironmentBinding } from "./environment-authority.ts";
import { bubblewrapArguments } from "./bubblewrap-policy.ts";
import type { RunnerSubagentStep } from "../shared/parallel-utils.ts";

/** Runs before spawning; serializes explicit task data and admitted paths only. */
export function prepareEnvironmentBootstrap(config: SubagentRunConfig) {
	if (!config.executionEnvironment || !config.environmentSessionId || config.steps.length !== 1) throw new Error("Invalid direct environment launch.");
	fs.mkdirSync(environmentAuthorityDirectory(config.asyncDir), { recursive: true, mode: 0o700 });
	if (fs.realpathSync(config.asyncDir) !== path.resolve(config.asyncDir)) throw new Error("Confined run directories must use canonical absolute paths.");
	const step = config.steps[0];
	if (!step || "parallel" in step || "expand" in step || step.agent !== "$task" || step.context !== "fresh") throw new Error("Execution environments require one fresh direct leaf.");
	const source = config.environmentSourceRunId ? readEnvironmentBinding(path.join(DIRS.async, config.environmentSourceRunId)) : undefined;
	if (config.environmentSourceRunId && !source) throw new Error("Confined resume requires its original host binding.");
	const sessionRoot = source?.sessionRoot ?? path.join(config.asyncDir, "session");
	const sessionFile = source?.sessionFile ?? path.join(sessionRoot, "session.jsonl");
	fs.mkdirSync(sessionRoot, { recursive: true, mode: 0o700 });
	if (source) admitEnvironmentSession(source, sessionFile);
	else fs.writeFileSync(sessionFile, "", { mode: 0o600, flag: "wx" });
	const artifactsDir = path.join(config.asyncDir, "artifacts");
	fs.mkdirSync(artifactsDir, { recursive: true, mode: 0o700 });
	const definition = resolveExecutionEnvironment(config.environmentSessionId, config.executionEnvironment, [config.cwd, config.asyncDir, sessionRoot], source?.environment);
	const binding = createEnvironmentBinding({ runDirectory: config.asyncDir, sessionRoot, sessionFile, environment: definition.identity });
	const bootstrapPath = path.join(config.asyncDir, "bootstrap.json");
	const resultDestination = config.resultPath;
	const resultPath = path.join(config.asyncDir, "environment-result.json");
	const supervisor = resolveSupervisorChannelDir(config.id, "$task", 0);
	fs.mkdirSync(supervisor, { recursive: true, mode: 0o700 });
	const resources: Resource[] = [
		{ role: "runtime", path: fileURLToPath(new URL("../../../", import.meta.url)), kind: "directory", access: "read" },
		{ role: "run", path: config.asyncDir, kind: "directory", access: "read-write" },
		{ role: "session", path: sessionRoot, kind: "directory", access: "read-write" },
		{ role: "artifacts", path: artifactsDir, kind: "directory", access: "read-write" },
		{ role: "supervisor", path: supervisor, kind: "directory", access: "read-write" },
		{ role: "bootstrap", path: bootstrapPath, kind: "file", access: "read" },
	];
	const safeStep: RunnerSubagentStep = { ...step, sessionFile, extensions: [], subagentOnlyExtensions: [], requiredExtensions: [], skills: [], modelVerificationRegistry: undefined, modelResponseAliases: undefined, context: "fresh" as const };
	const safeConfig: SubagentRunConfig = {
		...config, steps: [safeStep], resultPath, artifactsDir, sessionDir: sessionRoot,
		share: false, inheritedChildRuntime: undefined, nestedRoute: undefined, nestedSelf: undefined,
		worktreeSetupHook: undefined, worktreeSetupHookTimeoutMs: undefined, worktreeBaseDir: undefined,
		revivalLease: undefined, revivalLeaseToken: undefined,
		leafFanoutBudget: config.runFanoutBudget ? getRunFanoutBudgetSnapshot(config.runFanoutBudget) : undefined,
		runFanoutBudget: undefined, childSessionFactoryModule: undefined,
	};
	const recoveryFile = path.join(config.asyncDir, "recovery-descriptor.json");
	const recovery: unknown = JSON.parse(fs.readFileSync(recoveryFile, "utf8"));
	if (!recovery || typeof recovery !== "object" || Array.isArray(recovery)) throw new Error("Invalid environment recovery input.");
	writePrivateAtomicJson(path.join(environmentAuthorityDirectory(config.asyncDir), "recovery-descriptor.json"), {
		...recovery, executionEnvironment: binding.environment.name, sessionFile, sessionDir: sessionRoot,
		artifactsDir, extensions: [], subagentOnlyExtensions: [], requiredExtensions: [], skills: [], skillPath: [],
		modelResponseAliases: undefined, context: "fresh", inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false,
	});
	return {
		config: safeConfig, bootstrapPath, resultDestination,
		wrap(runner: RunnerInvocation, hostExecutable: string): string[] {
			resources.push({ role: "runtime", path: hostExecutable, kind: "file", access: "read" }, { role: "runtime", path: runner.executable, kind: "file", access: "read" });
			const policy = buildEnvironmentPolicy(definition, { runId: config.id, launchKind: source ? "resume" : "start", runner, resources });
			if (path.resolve(policy.cwd) !== path.resolve(config.cwd)) throw new Error("Environment policy must preserve the prepared cwd.");
			const agentDirectory = path.resolve(policy.context.agentDirectory);
			const storagePaths = [agentDirectory, ...(fs.existsSync(agentDirectory) ? [fs.realpathSync(agentDirectory)] : [])];
			for (const mount of policy.mounts) {
				if (mount.kind !== "bind") continue;
				const relative = path.relative(mount.destination, agentDirectory);
				if (relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) storagePaths.push(path.resolve(fs.realpathSync(mount.source), relative));
			}
			if (storagePaths.some(candidate => [DIRS.async, DIRS.artifacts, config.asyncDir].some(root => candidate === path.resolve(root) || candidate.startsWith(`${path.resolve(root)}${path.sep}`)))) throw new Error("Credential/configuration storage must be outside run evidence.");
			safeStep.extensions = policy.context.extensionFiles;
			const current: unknown = JSON.parse(fs.readFileSync(bootstrapPath, "utf8"));
			if (!current || typeof current !== "object" || Array.isArray(current)) throw new Error("Invalid staged environment bootstrap.");
			writePrivateAtomicJson(bootstrapPath, { ...current, steps: [{ ...safeStep, environmentContext: policy.context }] });
			return bubblewrapArguments(policy, runner, resources, [...definition.identity.files.map(file => file.path), ...definition.sourcePaths]);
		},
	};
}
