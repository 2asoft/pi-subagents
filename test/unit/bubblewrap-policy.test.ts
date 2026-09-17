import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { it } from "node:test";
import { bubblewrapArguments } from "../../src/runs/background/bubblewrap-policy.ts";
import { ENVIRONMENT_AUTHORITY_ROOT } from "../../src/runs/background/environment-authority.ts";
import { SESSION_LEASES_DIR } from "../../src/runs/shared/session-lease.ts";
import type { BubblewrapPolicy } from "../../src/api/execution-environments.ts";

const policy: BubblewrapPolicy = { mounts: [], cwd: "/tmp", env: {}, network: "isolated", context: { agentDirectory: "/agent", instructionFiles: [], skillFiles: [], extensionFiles: [] } };
const runner = { executable: "/usr/bin/true", args: [], cwd: "/tmp", env: {} };

it("rejects authority and lease bindings through policy and resource lists", { skip: process.platform !== "linux" }, () => {
	for (const source of [ENVIRONMENT_AUTHORITY_ROOT, SESSION_LEASES_DIR]) {
		fs.mkdirSync(source, { recursive: true });
		assert.throws(() => bubblewrapArguments({ ...policy, mounts: [{ kind: "bind", source, destination: "/exposed", access: "read-write" }] }, runner, [], []), /cannot be mounted/);
		assert.throws(() => bubblewrapArguments(policy, runner, [{ role: "session", path: source, kind: "directory", access: "read-write" }], []), /cannot be mounted/);
	}
});

it("canonicalizes a symlinked temporary root before excluding authority", { skip: process.platform !== "linux" }, () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "environment-root-link-"));
	try {
		const real = path.join(root, "real");
		const alias = path.join(root, "alias");
		fs.mkdirSync(path.join(real, "environment-owners"), { recursive: true });
		fs.symlinkSync(real, alias);
		const module = new URL("../../src/runs/background/bubblewrap-policy.ts", import.meta.url).href;
		const script = `import {bubblewrapArguments} from ${JSON.stringify(module)};try { bubblewrapArguments({...${JSON.stringify(policy)},mounts:[{kind:'bind',source:${JSON.stringify(path.join(real, "environment-owners"))},destination:'/exposed',access:'read-write'}]},${JSON.stringify(runner)},[],[]);process.exitCode=1 }catch(error){ console.log(error.message) }`;
		const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { env: { ...process.env, PI_SUBAGENTS_TEMP_ROOT: alias }, encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /cannot be mounted/);
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it("distinguishes inaccessible process evidence from termination", { skip: process.platform !== "linux" }, () => {
	const module = new URL("../../src/runs/background/environment-process-identity.ts", import.meta.url).href;
	const script = `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import {captureEnvironmentProcess,environmentProcessState} from ${JSON.stringify(module)};const identity=captureEnvironmentProcess(process.pid);const read=fs.readFileSync;fs.readFileSync=function(file,...args){if(file==='/proc/'+process.pid+'/stat')throw Object.assign(new Error('denied'),{code:'EACCES'});return read.call(this,file,...args)};syncBuiltinESMExports();console.log(environmentProcessState(identity));`;
	const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout.trim(), "unknown");
});
