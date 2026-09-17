import assert from "node:assert/strict";
import * as sdk from "@earendil-works/pi-coding-agent";
import { buildInProcessChildLaunch } from "../../src/runs/shared/child-launch.ts";
import { createDefaultChildSessionFactory } from "../../src/runs/shared/child-session.ts";

/** Run in an isolated Pi host; verifies native SDK registration without prompting a model. */
export default function register(pi: sdk.ExtensionAPI) {
	pi.on("session_start", async () => {
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => sdk });
		const timer = setTimeout(() => process.exit(2), 20_000);
		let shutdowns = 0;
		try {
			for (const missing of [false, true]) {
				const launch = buildInProcessChildLaunch({
					host: "parent", cwd: process.cwd(), childAgentName: "$task", childIndex: 0,
					parentSessionId: "synthetic-parent", runId: `synthetic-supervisor-${missing}`,
					sessionEnabled: false, tools: ["contact_supervisor", ...(missing ? ["missing_probe_tool"] : [])], extensions: [],
					inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false,
				});
				launch.session.hooks.push({ name: "shutdown-observer", factory(childPi) {
					childPi.on("session_shutdown", () => { shutdowns++; });
				} });
				if (missing) await assert.rejects(() => factory.create(launch.session), /missing_probe_tool/);
				else await (await factory.create(launch.session)).dispose();
			}
			assert.equal(shutdowns, 2);
			await factory.dispose();
			clearTimeout(timer);
			console.log("PASS: native supervisor registration, missing-tool rejection and shutdown; no model prompts submitted.");
			process.exit(0);
		} catch (error) {
			console.error(error);
			await factory.dispose();
			clearTimeout(timer);
			process.exit(1);
		}
	});
}
