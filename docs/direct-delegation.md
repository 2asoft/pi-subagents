# Direct task delegation

This fork accepts tasks without an agent profile. Skills and callers supply the role, instructions, evidence, verification requirements, and output format. The existing runner manages execution, sessions, steering, cancellation, and results.

## One task

```js
{
  task: "<exact filled skill template and evidence>",
  model: "provider/model:medium",
  tools: ["read", "grep", "find", "ls"],
  context: "fresh",
  async: false
}
```

Omit `agent` for direct execution. Select a named profile explicitly with `agent` when its configured behavior is wanted. Direct options cannot be combined with a named profile. The reserved runtime identity `$task` appears in results; callers do not select it by name.

| Field | Direct task behavior |
|---|---|
| `task` | Required, nonempty text. Initial tasks, forked tasks, and resume follow-ups retain the supplied text without task labels or role preambles. |
| `instructions` | Optional text appended to Pi's native system prompt. |
| `model` | Existing model selection. A suffix such as `:high` selects thinking; the standalone `thinking` field is for watchdog configuration. |
| `tools` | Optional array of registered tool names. Omit for native defaults; `[]` disables tools. |
| `extensions` | Optional extension file paths, absolute or relative to the request cwd. `[]` disables ambient extension loading. Required runtime hooks still load. |
| `inheritProjectContext` | Defaults to `true`. Controls inherited project instructions. |
| `inheritGlobalContext` | Defaults to `true`. Controls inherited global instructions. |
| `inheritSkills` | Defaults to `true`. Controls skill discovery in the child. |
| `context` | Defaults to `fresh`, independently of named-profile defaults. Explicit `fork` keeps the existing persisted-parent requirements. |
| `output` | Defaults to `false`. The runtime does not add an output destination; task instructions can specify one. Explicit output settings remain supported. |
| `acceptance`, `agentContract`, `outputSchema`, `gate` | Explicit contracts remain supported. Direct tasks use `{ version: 1 }` when no `agentContract` was supplied, so execution success does not imply acceptance of the work. |

Direct tasks add no persona, mandatory child-boundary prose, supervisor bridge instructions, memory/refinement overlay, inferred acceptance gate, or requirement to make edits. Named profiles retain their selected configuration and prompt behavior. Tool authorization, capability ceilings, nesting limits, timeouts, and process failure detection still apply.

Applicable operator instructions held only in the parent conversation must be included in the task or `instructions`. Fresh context does not copy that conversation.

## Parallel work and dependencies

```js
{
  args: {
    task: "<exact filled reviewer template>",
    models: ["provider/model-a:medium", "provider/model-b:high"]
  },
  workflowScript: `
    const reviews = await runs.all(args.models.map((model, index) => ({
      key: "review-" + index,
      task: args.task,
      model,
      tools: ["read", "grep", "find", "ls"],
      context: "fresh"
    })));
    return reviews;
  `,
  async: true,
  mission: false
}
```

Each direct `runs.run` or `runs.all` child resolves after terminal execution, including children with `async: true`. Inspect each result's state and output before aggregation. A review reporting defects can execute successfully; interpret its verdict using the skill's contract.

Workflow `args` have a 16 KiB limit. Store a shared template once and reuse it across children. For larger orchestration input, prepare a `workflowScriptPath` with filled task strings and evidence paths. The sandbox cannot read files. Keep task instructions in the skill; scripts express dispatch, dependencies, and collection.

`mission: false` selects ephemeral workflow orchestration. Omit it when the existing mission tracking is wanted. Existing concurrency and cumulative spawn limits apply; they are not global limits across all Pi sessions.

## Tools and providers

A tool allowlist does not load its extension. Supply the actual extension paths needed by the child. MCP tasks require background execution, so use `async: true` on that child. A newly loaded MCP adapter may need an explicit server connection before it can search the server's tools.

Foreground tasks use SDK sessions in the parent process. Background tasks use the detached runner. Both routes preserve direct task instructions and tool selection.

### Explicit supervisor access

Request `contact_supervisor` in a direct child's `tools` to provision the native upward channel, including with `extensions: []`. No intercom bridge or supervisor prose is added. Provider extensions remain a separate requirement. Example public call:

```js
{ task: "Review the evidence; ask the parent if a decision is needed.",
  tools: ["read", "contact_supervisor"], async: true }
```

The child uses `contact_supervisor` with `reason: "need_decision"` and `message`. The parent reads `subagent_supervisor({ action: "pending" })` and replies with `{ action: "reply", replyTo: requestId, message }`. Ordinary steering does not answer a blocking question.

Missing routing, tool restrictions that remove the requested supervisor, or unavailable required direct tools fail before model execution. Availability is checked after native tool registration. Named profiles retain their existing bridge/tool behavior. Resume retains the explicit tool request and provisions routing for the resumed run.

For confined native background tasks, see [Linux execution environments](execution-environments.md). Unlimited waits remain a separate proposal.

## Controls and resume

Use the existing `status`, `steer`, `interrupt`, `stop`, and `resume` actions with the returned run ID. `interrupt` preserves resumable work; `stop` cancels it. Inspect terminal state and returned evidence rather than treating a control receipt as proof of compliance.

Inside a workflow, continue a retained child with a distinct key:

```js
const first = await runs.run("review", { task: args.review, tools: ["read"] });
return await runs.run("challenge", { resume: first.runId, task: args.challenge });
```

Resume retains the original instructions, tools, extensions, inheritance settings, and fresh/fork context. Direct options cannot be changed on resume. Start another task when a different execution configuration is needed. A retained direct task missing its configuration fails instead of resuming with broader access. Foreground direct options are stored privately in `direct-task.json` beside the child session. The bounded foreground history index stores their path, so a large instruction set does not disappear from restart recovery. If the configuration cannot be written, the result preserves completed output and includes `resumeWarning`; the child cannot resume. Workflow results also carry `resumeWarning` and report `resumability.state` as `not-resumable`.

Retain foreground run IDs for direct resume. `children.list` enumerates retained background workflow children, not foreground history.

## Verification

`test/integration/direct-delegation.test.ts` covers public direct dispatch, independent workflow tools, awaited background output, and foreground-to-background resume. Restart coverage checks large instruction sets, exact follow-up text, retained tools/extensions/inheritance/context, refusal to resume after configuration loss, and preservation of completed output when configuration persistence fails. Public-boundary and prompt-runtime tests cover malformed inputs, profile conflicts, and suppression of mandatory child prose. Run `npm run typecheck`, `npm run test:all`, and `npm run build:pkg`.

Live verification must also inspect the provider payload and exercise the installed Pi runtime, selected models, tool providers, steering, interruption, cancellation, and resume. Fixture tests establish assembly and lifecycle behavior; live model output establishes only the behavior observed in that trial.

Verification on 2026-09-17 used Pi 0.85.1. Provider payloads retained the filled reviewer template, selected tool allowlist, and Luna/high or Sol/medium model settings. Parallel dispatch, delivered steering, stop, interrupt/resume, project context, and MCP discovery through the installed adapter completed. The MCP child connected exa and discovered `exa_web_search_exa`. The final automated checks passed 3,299 unit tests and 1,062 integration tests, with 20 skipped, plus typecheck and package build.
