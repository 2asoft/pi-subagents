import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Type, type Static } from "typebox";
import { Check, Errors } from "typebox/value";

const AbsolutePath = Type.String({ pattern: "^/[^\\u0000]*$", maxLength: 4096 });
const Argument = Type.String({ pattern: "^[^\\u0000]*$" });
const ContextSchema = Type.Object({
	agentDirectory: AbsolutePath,
	instructionFiles: Type.Array(AbsolutePath),
	skillFiles: Type.Array(AbsolutePath),
	extensionFiles: Type.Array(AbsolutePath),
}, { additionalProperties: false });
const MountSchema = Type.Union([
	Type.Object({ kind: Type.Literal("bind"), source: AbsolutePath, destination: AbsolutePath, access: Type.Union([Type.Literal("read"), Type.Literal("read-write")]) }, { additionalProperties: false }),
	Type.Object({ kind: Type.Literal("tmpfs"), destination: AbsolutePath }, { additionalProperties: false }),
	Type.Object({ kind: Type.Literal("directory"), destination: AbsolutePath }, { additionalProperties: false }),
	Type.Object({ kind: Type.Literal("symlink"), target: Argument, destination: AbsolutePath }, { additionalProperties: false }),
]);
export const BubblewrapPolicySchema = Type.Object({
	mounts: Type.Array(MountSchema),
	cwd: AbsolutePath,
	env: Type.Record(Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]*$" }), Argument),
	network: Type.Union([Type.Literal("shared"), Type.Literal("isolated")]),
	context: ContextSchema,
}, { additionalProperties: false });

export interface Resource {
	readonly role: "bootstrap" | "run" | "session" | "artifacts" | "supervisor" | "result" | "runtime";
	readonly path: string;
	readonly kind: "file" | "directory";
	readonly access: "read" | "read-write";
}
export interface RunnerInvocation {
	readonly executable: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly env: Readonly<Record<string, string>>;
}
export interface EnvironmentInput {
	readonly version: 1;
	readonly name: string;
	readonly definitionDigest: string;
	readonly runId: string;
	readonly childIndex: 0;
	readonly launchKind: "start" | "resume";
	readonly runner: RunnerInvocation;
	readonly resources: readonly Resource[];
}
export type BubblewrapPolicy = Static<typeof BubblewrapPolicySchema>;
export type AdmittedEnvironmentContext = Static<typeof ContextSchema>;
export interface EnvironmentIdentity {
	readonly name: string;
	readonly digest: string;
	readonly files: readonly Readonly<{ path: string; sha256: string }>[];
}
export interface RegisterExecutionEnvironmentInput {
	sessionId: string;
	name: string;
	/** Self-contained trusted module, imported by the registering extension. Node builtins are permitted. */
	modulePath: string;
	/** Additional non-module policy files or executables used by the adapter. */
	policyFiles?: readonly string[];
	buildPolicy(input: EnvironmentInput): BubblewrapPolicy;
}
interface RegisteredEnvironment {
	identity: EnvironmentIdentity;
	sourcePaths: readonly string[];
	buildPolicy: RegisterExecutionEnvironmentInput["buildPolicy"];
}
type Registrations = Map<string, Map<string, RegisteredEnvironment>>;
function registry(): Registrations {
	const key = Symbol.for("pi-subagents.execution-environments.v1");
	// Trusted extension loaders can instantiate this module independently.
	const globals = globalThis as Record<symbol, unknown>;
	const existing = globals[key];
	if (existing === undefined) {
		const registrations: Registrations = new Map();
		globals[key] = registrations;
		return registrations;
	}
	if (!(existing instanceof Map)) throw new Error("Invalid execution environment registry.");
	return existing;
}

function digestFile(file: string): string {
	if (!fs.statSync(file).isFile()) throw new Error(`Execution environment definition is not a file: ${file}`);
	return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
function identityOf(name: string, paths: readonly string[]): EnvironmentIdentity {
	const files = [...new Set(paths.map(file => fs.realpathSync(file)))].sort().map(file => Object.freeze({ path: file, sha256: digestFile(file) }));
	return Object.freeze({ name, digest: createHash("sha256").update(JSON.stringify({ name, files })).digest("hex"), files: Object.freeze(files) });
}
function contains(directory: string, file: string): boolean {
	const relative = path.relative(directory, file);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/** Trusted extensions register definitions for their parent session, without another module loader. */
export function registerExecutionEnvironment(input: RegisterExecutionEnvironmentInput): { dispose(): void } {
	if (!input.sessionId?.trim() || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.name) || typeof input.buildPolicy !== "function") {
		throw new Error("Execution environment registration requires a session identity, safe name and buildPolicy function.");
	}
	const paths = [input.modulePath, ...(input.policyFiles ?? [])];
	if (paths.some(file => !path.isAbsolute(file))) throw new Error("Execution environment definition paths must be absolute.");
	const identity = identityOf(input.name, paths);
	const registrations = registry();
	const definitions = registrations.get(input.sessionId) ?? new Map<string, RegisteredEnvironment>();
	if (definitions.has(input.name)) throw new Error(`Execution environment '${input.name}' is already registered for this session.`);
	const registered = Object.freeze({ identity, sourcePaths: Object.freeze(paths.map(file => path.resolve(file))), buildPolicy: input.buildPolicy });
	definitions.set(input.name, registered);
	registrations.set(input.sessionId, definitions);
	return { dispose() {
		if (definitions.get(input.name) === registered) definitions.delete(input.name);
		if (definitions.size === 0 && registrations.get(input.sessionId) === definitions) registrations.delete(input.sessionId);
	} };
}

export function resolveExecutionEnvironment(sessionId: string, name: string, writableDirectories: readonly string[], retained?: EnvironmentIdentity): RegisteredEnvironment {
	const registered = registry().get(sessionId)?.get(name);
	if (!registered) throw new Error(`Execution environment '${name}' is not registered for this parent session.`);
	const identity = identityOf(name, registered.sourcePaths);
	if (identity.digest !== registered.identity.digest || (retained && retained.digest !== identity.digest)) {
		throw new Error(`Execution environment '${name}' changed; retained launches cannot repin their definition.`);
	}
	for (const file of identity.files) {
		if (writableDirectories.some(directory => contains(fs.realpathSync(directory), file.path) || registered.sourcePaths.some(source => contains(fs.realpathSync(directory), source)))) {
			throw new Error(`Execution environment definition is in a known worker-writable directory: ${file.path}`);
		}
	}
	return registered;
}

/** Publish the registration API for project extensions without package resolution. */
export function publishExecutionEnvironmentAPI(): () => void {
	const key = Symbol.for("pi-subagents.execution-environment-api.v1");
	const publishersKey = Symbol.for("pi-subagents.execution-environment-api-publishers.v1");
	const existing: unknown = Reflect.get(globalThis, publishersKey);
	if (existing !== undefined && !(existing instanceof Set)) throw new Error("Invalid execution environment API publishers.");
	const api = Object.freeze({ version: 1 as const, register: registerExecutionEnvironment });
	const publishers: Set<typeof api> = existing ?? new Set();
	Object.defineProperty(globalThis, publishersKey, { value: publishers, configurable: true });
	publishers.add(api);
	Object.defineProperty(globalThis, key, { value: api, configurable: true });
	return () => {
		if (!publishers.delete(api)) return;
		if (Reflect.get(globalThis, key) === api) {
			const remaining = [...publishers].at(-1);
			if (remaining) Object.defineProperty(globalThis, key, { value: remaining, configurable: true });
			else Reflect.deleteProperty(globalThis, key);
		}
		if (publishers.size === 0) Reflect.deleteProperty(globalThis, publishersKey);
	};
}

export function buildEnvironmentPolicy(definition: RegisteredEnvironment, input: Omit<EnvironmentInput, "version" | "name" | "definitionDigest" | "childIndex">): BubblewrapPolicy {
	const frozen: EnvironmentInput = Object.freeze({
		...input, version: 1, name: definition.identity.name, definitionDigest: definition.identity.digest, childIndex: 0,
		runner: Object.freeze({ ...input.runner, args: Object.freeze([...input.runner.args]), env: Object.freeze({ ...input.runner.env }) }),
		resources: Object.freeze(input.resources.map(resource => Object.freeze({ ...resource }))),
	});
	const policy: unknown = definition.buildPolicy(frozen);
	if (!Check(BubblewrapPolicySchema, policy)) throw new Error(`Invalid bubblewrap policy: ${JSON.stringify(Errors(BubblewrapPolicySchema, policy))}`);
	return structuredClone(policy);
}
