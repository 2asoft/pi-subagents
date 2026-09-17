import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { persistDirectTaskOptions, readDirectTaskOptions } from "../../src/agents/direct-task.ts";

test("retains independent direct-task configurations for sibling fork sessions", (t) => {
	// Arrange
	const directory = mkdtempSync(join(tmpdir(), "pi-direct-task-siblings-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const first = persistDirectTaskOptions(join(directory, "first.jsonl"), { instructions: "First rubric", tools: ["read"] });

	// Act
	const second = persistDirectTaskOptions(join(directory, "second.jsonl"), { instructions: "Second rubric", tools: [] });

	// Assert
	assert.notEqual(first, second);
	assert.deepEqual(readDirectTaskOptions(second), { ok: true, options: { instructions: "Second rubric", tools: [], extensions: undefined, inheritProjectContext: undefined, inheritGlobalContext: undefined, inheritSkills: undefined } });
	assert.deepEqual(readDirectTaskOptions(first), { ok: true, options: { instructions: "First rubric", tools: ["read"], extensions: undefined, inheritProjectContext: undefined, inheritGlobalContext: undefined, inheritSkills: undefined } });
});
