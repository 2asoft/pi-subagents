import * as fs from "node:fs";
import * as path from "node:path";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { DIRS, TEMP_ROOT_DIR } from "../../shared/types.ts";
import { writePrivateAtomicJson } from "../../shared/atomic-json.ts";
import type { EnvironmentIdentity } from "../../shared/execution-environments.ts";

export const ENVIRONMENT_AUTHORITY_ROOT = path.join(TEMP_ROOT_DIR, "environment-owners");
const BindingSchema = Type.Object({
	version: Type.Literal(1), runId: Type.String(), runDirectory: Type.String(), sessionRoot: Type.String(), sessionFile: Type.String(),
	environment: Type.Object({ name: Type.String(), digest: Type.String(), files: Type.Array(Type.Object({ path: Type.String(), sha256: Type.String() })) }),
}, { additionalProperties: false });
export type EnvironmentBinding = Static<typeof BindingSchema>;

export function environmentAuthorityDirectory(runDirectory: string): string {
	const runId = path.basename(fs.existsSync(runDirectory) ? fs.realpathSync(runDirectory) : path.resolve(runDirectory));
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) throw new Error("Invalid environment run identity.");
	return path.join(ENVIRONMENT_AUTHORITY_ROOT, runId);
}
export function admitEnvironmentRunDirectory(runDirectory: string): void {
	const resolved = path.resolve(runDirectory);
	const canonical = fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
	if (path.dirname(resolved) !== path.resolve(DIRS.async)) {
		for (let ancestor = path.dirname(resolved); path.dirname(ancestor) !== ancestor; ancestor = path.dirname(ancestor)) {
			if (fs.existsSync(path.join(ENVIRONMENT_AUTHORITY_ROOT, path.basename(ancestor)))) throw new Error("Confined run directory aliases and nested run paths are not admitted.");
		}
	}
	if (resolved !== canonical && fs.existsSync(environmentAuthorityDirectory(runDirectory))) throw new Error("Confined run directory aliases are not admitted.");
}
export function readEnvironmentBinding(runDirectory: string): EnvironmentBinding | undefined {
	admitEnvironmentRunDirectory(runDirectory);
	const directory = environmentAuthorityDirectory(runDirectory);
	if (!fs.existsSync(directory)) return undefined;
	const value: unknown = JSON.parse(fs.readFileSync(path.join(directory, "binding.json"), "utf8"));
	if (!Check(BindingSchema, value) || value.runId !== path.basename(fs.realpathSync(runDirectory)) || value.runDirectory !== fs.realpathSync(runDirectory)) {
		throw new Error("Invalid authoritative execution environment binding; refusing fallback.");
	}
	return value;
}
export function createEnvironmentBinding(input: { runDirectory: string; sessionRoot: string; sessionFile: string; environment: EnvironmentIdentity }): EnvironmentBinding {
	const runDirectory = fs.realpathSync(input.runDirectory);
	const sessionRoot = fs.realpathSync(input.sessionRoot);
	const binding = { version: 1 as const, runId: path.basename(runDirectory), runDirectory, sessionRoot, sessionFile: path.resolve(input.sessionFile), environment: { ...input.environment, files: input.environment.files.map(file => ({ ...file })) } };
	const directory = environmentAuthorityDirectory(runDirectory);
	fs.mkdirSync(ENVIRONMENT_AUTHORITY_ROOT, { recursive: true, mode: 0o700 });
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	if (fs.existsSync(path.join(directory, "binding.json"))) throw new Error("Environment run already has an authoritative binding.");
	writePrivateAtomicJson(path.join(directory, "binding.json"), binding);
	return binding;
}

/** Inspect path metadata only. Call before any host session-content access. */
export function admitEnvironmentSession(binding: EnvironmentBinding, candidate: string): string {
	const absolute = path.resolve(candidate);
	const relative = path.relative(binding.sessionRoot, absolute);
	if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Session is outside the admitted environment session root.");
	if (fs.realpathSync(binding.sessionRoot) !== binding.sessionRoot || fs.lstatSync(binding.sessionRoot).isSymbolicLink()) throw new Error("Admitted environment session root changed.");
	let current = binding.sessionRoot;
	const parts = relative.split(path.sep);
	for (const [index, part] of parts.entries()) {
		current = path.join(current, part);
		const stat = fs.lstatSync(current);
		if (stat.isSymbolicLink()) throw new Error("Environment session paths cannot traverse symlinks.");
		if (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory()) throw new Error("Invalid environment session path.");
	}
	if (absolute !== binding.sessionFile) throw new Error("Session differs from the authoritative environment binding.");
	return absolute;
}

/** Read through descriptors so a concurrent rename cannot redirect a host read. */
export function withEnvironmentSessionDescriptor<T>(binding: EnvironmentBinding, candidate: string, read: (descriptor: number) => T): T {
	const admitted = admitEnvironmentSession(binding, candidate);
	const relative = path.relative(binding.sessionRoot, admitted);
	const descriptors: number[] = [];
	try {
		let directory = fs.openSync(binding.sessionRoot, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
		descriptors.push(directory);
		const components = relative.split(path.sep);
		for (const component of components.slice(0, -1)) {
			directory = fs.openSync(`/proc/self/fd/${directory}/${component}`, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
			descriptors.push(directory);
		}
		const descriptor = fs.openSync(`/proc/self/fd/${directory}/${components.at(-1)}`, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
		descriptors.push(descriptor);
		if (!fs.fstatSync(descriptor).isFile()) throw new Error("Environment session must be a regular file.");
		return read(descriptor);
	} finally { for (const descriptor of descriptors.reverse()) fs.closeSync(descriptor); }
}

export function appendRunEvent(runDirectory: string, serializedEvent: string): void {
	const file = path.join(runDirectory, "events.jsonl");
	if (!readEnvironmentBinding(runDirectory)) { fs.appendFileSync(file, serializedEvent, "utf8"); return; }
	const descriptor = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
	try {
		if (!fs.fstatSync(descriptor).isFile()) throw new Error("Environment event file must be regular.");
		fs.appendFileSync(descriptor, serializedEvent, "utf8");
	} finally { fs.closeSync(descriptor); }
}

/** Host reads of worker files must neither follow links nor block on FIFOs. */
export function readEnvironmentFile(file: string): string {
	const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
	try {
		if (!fs.fstatSync(descriptor).isFile()) throw new Error("Environment metadata must be a regular file.");
		return fs.readFileSync(descriptor, "utf8");
	} finally { fs.closeSync(descriptor); }
}
