import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import { writePrivateAtomicJson } from "../shared/atomic-json.ts";
import * as path from "node:path";
import { Type, type Static } from "typebox";
import { Check, Errors } from "typebox/value";
import type { AgentConfig } from "./agents.ts";

/** Internal identity for native tasks supplied without a named profile. */
export const DIRECT_TASK_AGENT = "$task";

export const DirectTaskSchema = Type.Object({
	instructions: Type.Optional(Type.String({ description: "Direct task system instructions." })),
	tools: Type.Optional(Type.Array(Type.String({ pattern: "\\S" }), { description: "Direct task tools; [] for none." })),
	extensions: Type.Optional(Type.Array(Type.String({ pattern: "\\S" }), { description: "Direct task extension paths; [] disables ambient loading." })),
	inheritProjectContext: Type.Optional(Type.Boolean()),
	inheritGlobalContext: Type.Optional(Type.Boolean()),
	inheritSkills: Type.Optional(Type.Boolean()),
});

export type DirectTaskOptions = Static<typeof DirectTaskSchema>;
export type DirectTaskInput = Partial<Record<keyof DirectTaskOptions, unknown>>;

export function hasDirectTaskOptions(input: DirectTaskInput): boolean {
	return Object.entries(input).some(([key, value]) => Object.hasOwn(DirectTaskSchema.properties, key) && value !== undefined);
}

export function parseDirectTaskOptions(input: unknown): { ok: true; options: DirectTaskOptions } | { ok: false; error: string } {
	if (!Check(DirectTaskSchema, input)) return { ok: false, error: `Invalid direct task options: ${JSON.stringify(Errors(DirectTaskSchema, input))}` };
	const { instructions, tools, extensions, inheritProjectContext, inheritGlobalContext, inheritSkills } = input;
	return { ok: true, options: { instructions, tools, extensions, inheritProjectContext, inheritGlobalContext, inheritSkills } };
}

export function createDirectTaskAgent(options: DirectTaskOptions, cwd: string): AgentConfig {
	return {
		name: DIRECT_TASK_AGENT,
		description: "Execute the supplied task.",
		systemPrompt: options.instructions ?? "",
		systemPromptMode: "append",
		inheritProjectContext: options.inheritProjectContext ?? true,
		inheritGlobalContext: options.inheritGlobalContext ?? true,
		inheritSkills: options.inheritSkills ?? true,
		defaultContext: "fresh",
		defaultProgress: false,
		...(options.tools !== undefined ? { tools: [...options.tools] } : {}),
		...(options.extensions !== undefined ? { extensions: options.extensions.map(extension => path.resolve(cwd, extension)) } : {}),
		source: "runtime",
		filePath: fileURLToPath(import.meta.url),
	};
}

/** Store the resolved configuration, rather than rediscovering a profile on resume. */
export function directTaskOptionsFromAgent(agent: AgentConfig): DirectTaskOptions {
	return {
		instructions: agent.systemPrompt,
		...(agent.tools !== undefined ? { tools: [...agent.tools] } : {}),
		...(agent.extensions !== undefined ? { extensions: [...agent.extensions] } : {}),
		inheritProjectContext: agent.inheritProjectContext,
		inheritGlobalContext: agent.inheritGlobalContext,
		inheritSkills: agent.inheritSkills,
	};
}

/** Keep prompt text out of the bounded foreground history index. */
export function persistDirectTaskOptions(sessionFile: string, options: DirectTaskOptions): string {
	const file = path.join(path.dirname(sessionFile), "direct-task.json");
	writePrivateAtomicJson(file, options);
	return file;
}

export function readDirectTaskOptions(file: string): ReturnType<typeof parseDirectTaskOptions> {
	try {
		return parseDirectTaskOptions(JSON.parse(fs.readFileSync(file, "utf8")));
	} catch (error) {
		return { ok: false, error: `Cannot restore direct task configuration: ${error instanceof Error ? error.message : String(error)}` };
	}
}
