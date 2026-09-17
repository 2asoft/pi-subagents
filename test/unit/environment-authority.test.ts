import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { it } from "node:test";
import { readSessionMessagesTail } from "../../src/runs/background/fleet-view.ts";
import { admitEnvironmentSession, createEnvironmentBinding, environmentAuthorityDirectory, readEnvironmentBinding, withEnvironmentSessionDescriptor } from "../../src/runs/background/environment-authority.ts";

it("uses host binding despite worker metadata replacement and rejects session symlinks", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "environment-authority-"));
	const runDirectory = path.join(root, randomUUID());
	const sessionRoot = path.join(runDirectory, "session");
	fs.mkdirSync(sessionRoot, { recursive: true });
	const sessionFile = path.join(sessionRoot, "session.jsonl");
	fs.writeFileSync(sessionFile, "native update\n");
	const outside = path.join(root, "outside.jsonl");
	fs.writeFileSync(outside, "outside canary\n");
	try {
		const binding = createEnvironmentBinding({ runDirectory, sessionRoot, sessionFile, environment: { name: "synthetic", digest: "pinned", files: [] } });
		fs.writeFileSync(path.join(runDirectory, "recovery-descriptor.json"), JSON.stringify({ sessionFile: outside }));
		fs.writeFileSync(path.join(runDirectory, "process-terminal.json"), JSON.stringify({ state: "observed", pid: process.pid }));
		assert.deepEqual(readEnvironmentBinding(runDirectory), binding);
		fs.symlinkSync(".", path.join(runDirectory, "alias"));
		assert.throws(() => readEnvironmentBinding(path.join(runDirectory, "alias")), /aliases/);
		fs.mkdirSync(path.join(runDirectory, "nested"));
		assert.throws(() => readEnvironmentBinding(path.join(runDirectory, "nested")), /nested run/);
		const rejected = readSessionMessagesTail(outside, 10, [root], [outside], root, runDirectory);
		assert.equal(rejected.messages.length, 0);
		assert.match(rejected.warnings.join("\n"), /outside the admitted/);
		fs.mkdirSync(path.join(root, "legacy"));
		fs.symlinkSync(root, path.join(runDirectory, "elsewhere"));
		assert.throws(() => readEnvironmentBinding(path.join(runDirectory, "elsewhere", "legacy")), /aliases/);
		let opened = false;
		assert.throws(() => withEnvironmentSessionDescriptor(binding, outside, () => { opened = true; }), /outside the admitted/);
		assert.equal(opened, false);
		assert.equal(withEnvironmentSessionDescriptor(binding, sessionFile, fd => fs.readFileSync(fd, "utf8")), "native update\n");
		assert.equal(admitEnvironmentSession(binding, sessionFile), sessionFile);
		assert.throws(() => admitEnvironmentSession(binding, outside), /outside the admitted/);
		fs.unlinkSync(sessionFile);
		fs.symlinkSync(outside, sessionFile);
		assert.throws(() => admitEnvironmentSession(binding, sessionFile), /symlink/);
		assert.throws(() => withEnvironmentSessionDescriptor(binding, sessionFile, () => { opened = true; }), /symlink/);
		assert.equal(opened, false);
		fs.unlinkSync(sessionFile);
		fs.writeFileSync(sessionFile, "legitimate resumed update\n");
		assert.equal(admitEnvironmentSession(binding, sessionFile), sessionFile);
		fs.unlinkSync(path.join(environmentAuthorityDirectory(runDirectory), "binding.json"));
		assert.throws(() => readEnvironmentBinding(runDirectory), /ENOENT/);
	} finally {
		fs.rmSync(environmentAuthorityDirectory(runDirectory), { recursive: true, force: true });
		fs.rmSync(root, { recursive: true, force: true });
	}
});
