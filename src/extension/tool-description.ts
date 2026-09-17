import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionConfig, ToolDescriptionMode } from "../shared/types.ts";
import { getAgentDir, getProjectConfigDir } from "../shared/utils.ts";

const CUSTOM_TOOL_DESCRIPTION_FILE = "subagent-tool-description.md";
const CUSTOM_TOOL_DESCRIPTION_MAX_BYTES = 50 * 1024;
const AGENT_SELECTION_GUIDANCE = 'Named profiles are optional. To choose one, use {action:"list",capabilities:true}: executable, non-disabled agents only; external-cli requires runner.available === true. Passive PATH/PATHEXT/X_OK is not authentication/version/launch proof; preflight is authoritative.';
const SUBAGENT_FAILURE_RECOVERY_GUIDANCE = "A failed launch or child execution is not a completed report. Record the failure and any partial work, then apply the caller's retry, dropout, and aggregation rules. Report missing tool providers or runtime failures before changing execution mode.";

export const SUBAGENT_SAFETY_GUIDANCE = `SAFETY-CRITICAL SUBAGENT GUIDANCE:
• Direct parent execution is the default. Invoke subagents only when delegation is authorized by the operator's current request or applicable user/project instructions; task size, complexity, risk, tool-call count, or recipe fit do not independently authorize delegation.
• ${AGENT_SELECTION_GUIDANCE}
• ${SUBAGENT_FAILURE_RECOVERY_GUIDANCE}
• Omit action for execution. The caller's skill or task owns worker roles, verification, failure handling, and aggregation. Pass its filled instructions unchanged; do not substitute a profile or generic role summary.
• Async follows asyncByDefault (normally true); async:false waits for completion. Consume results at dependency barriers. Native async completion wakes this session; return control while waiting. bg_wait can collect a required result in the same turn.
• Tools and depth/session limits control nested delegation. Isolate concurrent writers in separate cwd/worktrees. Use fresh-context reviewers when the caller requests independent review.
• Direct tasks preserve task-specified output destinations. Set output only when requesting runtime-managed output. Read actual outputReference/outputPathMapping/artifactPaths when returned; report evidence and residual risks.
• children.list: resume only resumable rows. {action:"resume",id,message} detaches a follow-up/challenge with stored agent/model/tool contract. If none is resumable, label a same-role fallback challenge. Scripts await runs.run(newKey,{resume:runId,task}); continue from latest returned runId. Each distinct resume pass needs a new stable key; same-key reuse requires identical launch parameters.
• Named resources own authority; raw workflowScript/workflowScriptPath cannot use runs.host. Granted commands/relative outputs use workflow cwd, never per-step cwd.
• Inspect asyncId/asyncDir (status.json, events.jsonl, logs) with status/debug.run; control with interrupt/stop/resume/steer. Read {action:"guide",topic:"tool-reference"} for controls/evidence gates.`;

const EXECUTION_GUIDANCE = `Delegate one child with {task,model?,tools?,instructions?,extensions?}. No profile file is required. instructions appends caller text to Pi's native prompt; task is passed unchanged. Direct tasks default to fresh context and inherit operator/project instructions and skill discovery; inheritProjectContext, inheritGlobalContext, and inheritSkills can each be false. Direct tasks add no persona, child-boundary prose, supervisor instructions, refinement overlay, inferred acceptance gate, edit demand, or output destination. Explicit acceptance, outputSchema and output remain available. Tool allowlists do not load extensions; provide extension paths when custom tools need them. MCP children require async:true. Use model suffixes for thinking.
Choose an optional named profile with {agent,task?}. For orchestration choose one of {workflowScript,args?}, {workflowScriptPath,args?} or {workflow,args}. agent/task exclude workflow inputs; task excludes action. action is management/control; validate accepts either script without launching. workflowScriptPath loads from request cwd before sandbox execution.
Scripts: JavaScript statement bodies with explicit return, top-level await, plain helpers/Promise chains; nested async function/arrow/method helpers are rejected. Await runs.run('key',{task,...}) before .output; await runs.all([{key,task,...},...]) for an ordered array, not a key map. Observe every stored run promise with direct await, Promise.race or Promise.all. Await/return runs.steer(key,message,options?) for a prior key, never raw run ids; queued/delivered/missed/failed receipts are not compliance proof.
Before advanced orchestration (runs.lanes, rolling fanout, mission state, handoffs), read {action:"guide",topic:"workflows"} or the pi-subagents skill. Raw-script sandboxes add deeply frozen args; all sandboxes provide runs, emit, console, JavaScript and enabled mission state, with no filesystem/shell/Pi tools/host globals. External CLI agents support native options only when their runner declares them; read guide tool-reference before passing model, structured output, acceptance/agentContract, tool budget, fast, fork context or skills/tools.
Model override: first call {action:"models"}; copy exact provider/id, not agent names. Thinking uses model suffix, not watchdog-only thinking.
Named resources: {workflow:'review',args:{task:'...'}} or {workflow:'run-ci',args:{command:'npm test'}}. Raw scripts also accept bounded plain-data args; raw-script args persist as evidence, so never include secrets. worktree:true requires clean source; baseRef defaults to HEAD at allocation or a supported named ref, never full 40/64-character commit IDs or revision expressions.`;

export const DEFAULT_SUBAGENT_TOOL_DESCRIPTION = `${EXECUTION_GUIDANCE}\n\n${SUBAGENT_SAFETY_GUIDANCE}`;

export const SUBAGENT_TOOL_PROMPT_SNIPPET = "For operator-requested delegation, use subagents; compose multi-child work in one workflow call.";
export const SUBAGENT_TOOL_PROMPT_GUIDELINES = [
	"Do not invoke subagents unless the operator requested delegation directly or through applicable instructions.",
];

export const COMPACT_SUBAGENT_TOOL_DESCRIPTION = DEFAULT_SUBAGENT_TOOL_DESCRIPTION;

export const FULL_SUBAGENT_TOOL_DESCRIPTION = `${DEFAULT_SUBAGENT_TOOL_DESCRIPTION}

WORKFLOW DETAILS:
• runs.lanes([{key,stages:[{key,agent,task},{key,resume:'previous',task}]}]) runs first stages together, later stages sequentially per lane. Failures stay lane-local; only explicit structuredOutput.verdict === 'blocked' blocks a successful stage, never reviewer prose.
• Workflow child controls default onto runs.run/runs.all items; child fields override them. worktree:true isolates each child and returns handoff artifacts. usageBudget is shared across the workflow; already-running children are not stopped.
• Missions auto-attach unless mission:false; await state.get(key)/state.set(key,JSONValue) requires a mission. See guide topic missions. Omit acceptance for reviewer/read-only calls; acceptance.review.required requests independent writer review.
• Management discovery: list/get/models/guide; create/update/delete/eject/disable/enable/reset/refine; mission.*, schedule.*, watchdog.*, inspector.*, project.*, lane.status/recordMerge/recordSupersession; worktree.discard and plan-only worktree.cleanup; doctor and grant-spawn-budget. Use guide topics agents, missions, observability, tool-reference, configuration, models, watchdog or extension-api for exact action fields. Schedules take script inputs, not direct children; recipes live in the missions guide.`;

function isToolDescriptionMode(value: unknown): value is ToolDescriptionMode {
	return value === "full" || value === "compact" || value === "custom";
}

function warn(options: ToolDescriptionOptions | undefined, message: string): void {
	(options?.warn ?? console.warn)(`[pi-subagents] ${message}`);
}

export interface ToolDescriptionOptions {
	cwd?: string;
	agentDir?: string;
	warn?: (message: string) => void;
}

export interface SubagentToolPromptMetadata {
	promptSnippet?: string;
	promptGuidelines?: string[];
}

export function buildSubagentToolPromptMetadata(config: Pick<ExtensionConfig, "toolDescriptionMode"> = {}): SubagentToolPromptMetadata {
	if (config.toolDescriptionMode !== undefined) return {};
	return {
		promptSnippet: SUBAGENT_TOOL_PROMPT_SNIPPET,
		promptGuidelines: SUBAGENT_TOOL_PROMPT_GUIDELINES,
	};
}

export function resolveToolDescriptionMode(config: Pick<ExtensionConfig, "toolDescriptionMode">, options?: ToolDescriptionOptions): ToolDescriptionMode {
	const mode = config.toolDescriptionMode;
	if (mode === undefined) return "full";
	if (isToolDescriptionMode(mode)) return mode;
	warn(options, `Ignoring invalid toolDescriptionMode ${JSON.stringify(mode)}; expected "full", "compact", or "custom".`);
	return "full";
}

function customDescriptionPaths(options?: ToolDescriptionOptions): string[] {
	const cwd = options?.cwd ?? process.cwd();
	const agentDir = options?.agentDir ?? getAgentDir();
	return [
		path.join(getProjectConfigDir(cwd), CUSTOM_TOOL_DESCRIPTION_FILE),
		path.join(agentDir, CUSTOM_TOOL_DESCRIPTION_FILE),
	];
}

function renderCustomTemplate(template: string, options?: ToolDescriptionOptions): string {
	const cwd = options?.cwd ?? process.cwd();
	const agentDir = options?.agentDir ?? getAgentDir();
	const projectConfigDir = getProjectConfigDir(cwd);
	const variables: Record<string, () => string> = {
		fullDescription: () => FULL_SUBAGENT_TOOL_DESCRIPTION,
		full: () => FULL_SUBAGENT_TOOL_DESCRIPTION,
		compactDescription: () => COMPACT_SUBAGENT_TOOL_DESCRIPTION,
		compact: () => COMPACT_SUBAGENT_TOOL_DESCRIPTION,
		safetyGuidance: () => SUBAGENT_SAFETY_GUIDANCE,
		safety: () => SUBAGENT_SAFETY_GUIDANCE,
		agentDir: () => agentDir,
		projectConfigDir: () => projectConfigDir,
	};
	return template.replace(/\{\{(\w+)\}\}/g, (raw, name: string) => {
		const replacement = variables[name];
		if (replacement) return replacement();
		warn(options, `${CUSTOM_TOOL_DESCRIPTION_FILE}: unknown placeholder ${raw} left unchanged.`);
		return raw;
	});
}

function loadCustomToolDescription(options?: ToolDescriptionOptions): string | undefined {
	for (const filePath of customDescriptionPaths(options)) {
		let stat: fs.Stats;
		try {
			stat = fs.statSync(filePath);
		} catch (error) {
			if (typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
			warn(options, `Failed to inspect custom tool description '${filePath}': ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		if (!stat.isFile()) {
			warn(options, `Ignoring custom tool description '${filePath}' because it is not a file.`);
			continue;
		}
		if (stat.size > CUSTOM_TOOL_DESCRIPTION_MAX_BYTES) {
			warn(options, `Ignoring custom tool description '${filePath}' because it is larger than ${CUSTOM_TOOL_DESCRIPTION_MAX_BYTES} bytes.`);
			continue;
		}
		try {
			const template = fs.readFileSync(filePath, "utf-8").trim();
			if (!template) {
				warn(options, `Ignoring empty custom tool description '${filePath}'.`);
				continue;
			}
			const rendered = renderCustomTemplate(template, options).trim();
			if (!rendered) {
				warn(options, `Ignoring custom tool description '${filePath}' because it rendered empty.`);
				continue;
			}
			return rendered;
		} catch (error) {
			warn(options, `Failed to read custom tool description '${filePath}': ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return undefined;
}

function withMandatorySafetyGuidance(description: string): string {
	const customDescription = description
		.split(SUBAGENT_SAFETY_GUIDANCE)
		.flatMap((part) => part.split(SUBAGENT_FAILURE_RECOVERY_GUIDANCE))
		.map((part) => part.trim())
		.filter(Boolean)
		.join("\n\n");
	return customDescription
		? `${customDescription}\n\n${SUBAGENT_SAFETY_GUIDANCE}`
		: SUBAGENT_SAFETY_GUIDANCE;
}

export function buildSubagentToolDescription(config: Pick<ExtensionConfig, "toolDescriptionMode"> = {}, options?: ToolDescriptionOptions): string {
	if (config.toolDescriptionMode === undefined) return DEFAULT_SUBAGENT_TOOL_DESCRIPTION;
	const mode = resolveToolDescriptionMode(config, options);
	let description: string;
	if (mode === "compact") description = COMPACT_SUBAGENT_TOOL_DESCRIPTION;
	else if (mode === "custom") {
		const custom = loadCustomToolDescription(options);
		if (custom) description = withMandatorySafetyGuidance(custom);
		else {
			warn(options, `${CUSTOM_TOOL_DESCRIPTION_FILE} was not found or valid for toolDescriptionMode "custom"; using full description.`);
			description = FULL_SUBAGENT_TOOL_DESCRIPTION;
		}
	} else description = FULL_SUBAGENT_TOOL_DESCRIPTION;
	return description;
}
