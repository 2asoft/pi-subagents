import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function register(pi: ExtensionAPI) {
	const provider = fauxProvider({ provider: "environment-smoke", models: [{ id: "local" }], tokensPerSecond: 100000 });
	const response = (context: { messages: unknown; systemPrompt?: string }) => {
		assert.equal(fs.existsSync(path.join(path.dirname(process.cwd()), "parent-agent", "AGENTS.md")), false);
		assert.equal(fs.existsSync(path.join(process.env.PI_SUBAGENTS_TEMP_ROOT!, "environment-owners")), false);
		assert.equal(fs.existsSync(path.join(process.env.PI_SUBAGENTS_TEMP_ROOT!, "session-leases")), false);
		fs.appendFileSync(path.join(process.cwd(), "requests.jsonl"), `${JSON.stringify(context)}\n`);
		if (JSON.stringify(context.messages).includes("RESUME_CHECK")) return fauxAssistantMessage("RESUME_DELIVERED");
		if (provider.state.callCount === 1) return fauxAssistantMessage(fauxToolCall("contact_supervisor", { reason: "need_decision", message: "Choose the synthetic marker." }), { stopReason: "toolUse" });
		assert.match(JSON.stringify(context.messages), /amber/);
		return fauxAssistantMessage("AMBER_DELIVERED");
	};
	provider.setResponses([response, response, response]);
	pi.registerProvider(provider.provider);
}
