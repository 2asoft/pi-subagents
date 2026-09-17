# Native background execution environment proposal

Status: proposed API, not implemented. NT96663 owns adapter policy and independent acceptance. This extension owns native sessions, spawning, control, recovery and result collection. This increment implements only explicit direct supervisor access.

## Public selection and supported scope

Add `executionEnvironment: string` to direct task and scripted child launch inputs. Example:

```js
await runs.run("implementation", {
  task: suppliedTask,
  executionEnvironment: "nt96663-sdk",
  async: true,
  context: "fresh",
  cwd: preparedWorktree,
  tools: ["read", "bash", "edit", "write", "contact_supervisor"],
  inheritProjectContext: false,
  inheritGlobalContext: false,
  inheritSkills: false,
  skill: false
});
```

This example is future syntax. Initial support: local native background direct leaf tasks, prepared worktrees, identical absolute paths inside and outside. Reject foreground, fork, external CLI, remote machine, named profile, nested delegation, automatic worktree setup, setup hooks and acceptance commands before model execution. No fallback. Parent acceptance can run separately inside the project sandbox. These restrictions do not establish a general host-command permission system.

The environment supplies admitted Pi configuration, extensions, instructions and skills inside the namespace. Explicit task/instructions are caller-authorized content. Never discover or serialize parent context files, skills, conversation, provider registrations or ambient extension configuration into a confined launch. Keep the existing selected model and thinking level; fail if the admitted provider cannot resolve them.

## Trusted adapter definition

Proposed settings entry, configured by the operator outside worker-writable paths:

```json
{
  "executionEnvironments": {
    "nt96663-sdk": {
      "modulePath": "/absolute/trusted/nt96663-environment.mjs",
      "sha256": "<digest-of-module-bytes>",
      "policyFiles": {
        "/absolute/trusted/sandbox-policy-file": "<digest-of-file-bytes>"
      }
    }
  }
}
```

The task selects only the name. It cannot supply adapter code, mounts, shell commands or environment overrides. The adapter is a self-contained ESM module with no imported executable dependencies. List every external policy/script it uses in `policyFiles`; verify those bytes before loading and before each launch or resume. Trusted dependency closure is the adapter author's responsibility. Writable source locations or missing files fail admission. Persist the selected definition and its digest in recovery metadata. Any changed/unavailable definition fails resume; no automatic migration or repinning.

TypeScript contract for the proposed ESM module:

```ts
export const version = 1;

export type Resource = Readonly<{
  role: "bootstrap" | "run" | "session" | "artifacts" |
        "supervisor" | "result" | "runtime";
  path: string;
  kind: "file" | "directory";
  access: "read" | "read-write";
}>;

export type RunnerInvocation = Readonly<{
  executable: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
}>;

export type EnvironmentInput = Readonly<{
  version: 1;
  name: string;
  definitionDigest: string;
  runId: string;
  childIndex: 0;
  launchKind: "start" | "resume";
  runner: RunnerInvocation;
  resources: readonly Resource[];
}>;

export type EnvironmentCommand = Readonly<{
  executable: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  context: Readonly<{
    agentDirectory: string;
    instructionFiles: readonly string[];
    skillFiles: readonly string[];
    extensionFiles: readonly string[];
  }>;
}>;

export function wrapRunner(input: EnvironmentInput): EnvironmentCommand;
```

`wrapRunner` returns argv for an executable such as bubblewrap, including the supplied native runner invocation unchanged. It does not spawn, write run files, resolve skills, choose models, acquire device ownership or perform setup commands. The extension spawns the returned argv directly, owns stdio and the host process handle, and preserves its startup barrier and timeout/control semantics. Objects supplied to the adapter are frozen. `runner.env` contains only explicit runner bootstrap variables; it never copies the parent environment wholesale. The adapter supplies an explicit admitted environment, including its isolated Pi configuration and credentials source. Credential values are not written into the persisted resource manifest or result evidence.

`context` names exact admitted resources using absolute paths. The parent records paths, not their contents; the native runner reads instruction files, selected SKILL.md files and extension files only after namespace entry. It constructs the child from those explicit resources and the admitted agent directory, with ambient resource discovery disabled. The inheritance flags suppress parent resources; explicit adapter resources remain available. Allocate bootstrap paths, obtain the adapter command/context, then write sanitized bootstrap configuration before spawning. No adapter helper needs to rewrite the runner argv or load instructions on the host.

Resource paths are concrete absolute paths, not glob patterns. Directory access permits atomic replacement within that directory. The extension enumerates only this child's required resources; the adapter adds its own project worktree, Git metadata, runtime libraries, configuration, network policy, and coordinator socket directory. The adapter must fail if it cannot admit a required resource. It must mount the coordinator directory rather than only the current socket inode, so socket replacement works.

This is a trusted adapter boundary, not validation of arbitrary bubblewrap arguments. Mount policy and credentials admission receive independent project review.

## Current resource inventory

Notation: `T = TEMP_ROOT_DIR`; `R = T/async-subagent-runs/<runId>` for an ordinary leaf; `S` is the child's explicitly allocated session directory; `A` is its explicitly allocated artifact directory. Exact paths are resolved by the extension and supplied in `resources`. Do not mount T, a complete parent session directory, or a shared artifact directory.

| Resource | Current path and access | Namespace treatment |
| --- | --- | --- |
| Bootstrap config | `T/async-cfg-<suffix>.json`, written privately by `spawnRunner`, read and deleted by runner entry | Stage sanitized config inside R for confined launches; read-only bind if isolated from runner writes. Preserve evidence separately from credentials. Parent context must never enter this config. |
| Runner code | `src/runs/background/subagent-runner.ts` or compiled `.js`; `runner-peer-preload.mjs`; conditional Jiti CLI or `binary-bootstrap.ts/.js` | Read-only exact runtime roots and dependencies. Selected install determines the concrete closure. Initial adapter must reject an unsupported host layout. |
| Pi SDK/provider runtime | Resolved Pi package root, peer aliases, explicit provider/tool extensions, Node or compiled Pi executable | Read-only admitted code/configuration; credentials provided separately. No parent provider snapshot or ambient parent configuration. |
| Run status and output | `R/status.json`, `events.jsonl`, `output-0.log`, `subagent-log-<runId>.md`, `runner.stdout.log`, `runner.stderr.log` | R read-write, dedicated to one child. Parent retains stdout/stderr descriptors. Runner records are evidence, not host PID authority. |
| Startup barrier | `R/runner-startup.json`, `runner-startup-ack.json`, `runner-startup-proceed.json` | Atomic file exchange under R. Initial launch uses proceed barrier; revival uses ready/ack/confirm/proceed. |
| Process terminal evidence | Runner-written `R/process-terminal-candidate.json`, host-written `R/process-terminal.json`, and status terminal fields | Host exit observation remains authoritative. Namespace PID must not become a host signaling target. The candidate alone is not termination proof. |
| Recovery | `R/recovery-descriptor.json`; foreground-to-background recovery can reference `direct-task.json` beside the source session | Only confined-origin sessions admitted initially. Pin adapter identity. Do not expose unrelated foreground history or allow unconfined-origin resume. |
| Control | `R/control/`: `interrupt.json`, `timeout.json`, `stop.json`, stop/steer request directories, revival briefs, `steer-inbox-closed.json`, `steer-recovery/` | R read-write. Parent writes requests; runner consumes and publishes acknowledgments/status. Atomic replacement needs directory visibility. |
| Native supervisor | `T/supervisor-channels/<safeRunId>-<safeAgent>-0/requests/` and `replies/`; current direct agent is `$task`, segments encoded by `safeSegment` | Mount only this channel directory read-write. Native protocol routes by parent session identity; no parent transcript mount. |
| Session | `S/*.jsonl`; current default can derive `S` from `sessionRoot/async-<runId>` or use an explicit session file | Allocate and mount only S read-write. Preserve exact canonical absolute path on resume. Session files can contain task/context/tool evidence and need durable retention. |
| Artifact output | Current flat files in A from `getArtifactPaths`: input, output, JSONL, transcript, metadata; optional `outputs/<runId>/`, `progress/<runId>/`, permission audit | Allocate A per child before launch. Do not bind an existing shared parent artifact root. Direct defaults do not require project output/progress files. |
| Structured output | `R/structured-output/` | Already inside R. Project owns delivered/blocked/needs_input schema and acceptance. |
| Completion result | Normally `T/async-subagent-results/<runId>.json`; workflow-await/revival can use `R/workflow-result.json` | Use per-run result staging under R, with parent publication to its private result index. Do not expose the global results directory. |
| Fanout budget | `T/run-fanout-budgets/<safeRootRunId>-<uuid>/manifest.json`, `claims/`, `admission.lock/owner.json`; descriptor `R/run-fanout-budget.json` | Current runner initialization reads the shared manifest and claims even for leaves. Change confined leaf accounting to use a parent-supplied snapshot before omitting this mount. Admission remains charged by parent; do not authorize descendants or expose shared locks. |
| Tool/usage budgets | Runtime config plus status/result counters; tool budget enforced in child hooks, usage budget checked by orchestration | No independent global budget directory required for a leaf. Preserve accounting across resume. |
| Session lease | `T/session-leases/<sha256-of-canonical-session-path>/owner.json`, with atomic claim/owner updates | Current runner acquires it and checks PID liveness. Must move confined lease ownership/liveness to host or provide an equivalent verified namespace-aware protocol. Do not mount all leases. |
| Worktree and Git objects | Prepared cwd, its `.git` indirection target and required common Git metadata/object storage | Project adapter declares visibility and write policy. Preserve enough Git state for recovery; no automatic setup hooks in this scope. |
| Project coordinator | Project-selected public socket directory | Adapter-owned mount; do not expose private coordinator state. Device ownership is independent of runner exit or cancellation. |

Source anchors: `src/runs/background/async-execution.ts` (`spawnRunner`, `executeAsyncSingle`); `src/runs/background/subagent-runner.ts` (main/status and startup handshake); `src/runs/background/control-channel.ts`; `src/intercom/native-supervisor-channel.ts`; `src/runs/shared/session-lease.ts`; `src/runs/shared/run-fanout-budget.ts`; `src/shared/artifacts.ts`; `src/shared/types.ts` (runtime roots and `getAsyncConfigPath`).

## Required changes before adapter implementation can be accepted

1. Parent prompt construction currently resolves skills and builds effective system prompts before spawning (`async-execution.ts`). Confined launches must bypass parent resource discovery and resolve admitted resources only after namespace entry. Inheritance flags alone do not prove this boundary.
2. Runner status, startup and leases currently use `process.pid`. Split host process identity/termination ownership from namespace PID telemetry. The host must observe the process group or equivalent adapter lifetime, including descendants, before claiming termination. Reject wrappers whose lifetime does not represent their workers. Restart recovery must validate a host process start identity rather than reuse an integer PID blindly.
3. Bootstrap config and completion results currently live outside R. Confined staging and parent publication are necessary to avoid exposing global runtime roots. This is a bounded path change, not a replacement storage system.
4. Lease liveness uses `/proc/<pid>/stat` and `kill(pid, 0)`. These cannot be shared unchanged across PID namespaces. Lease ownership must remain authoritative after parent restart and runner death. Report any larger incompatibility before expanding scope.
5. Reject host acceptance/setup execution at admission. Audit all paths that execute project commands, including worktree hooks, verification and cleanup; suppressing only `spawnRunner` host commands is insufficient.
6. `subagent-runner.ts` currently calls `getRunFanoutBudgetSnapshot` during initialization even for a leaf. Supply a leaf accounting snapshot without shared manifest/claim reads before excluding the shared budget directory.
7. Prove fresh launch, request/reply, stop, interrupt, failure, restart and resume with synthetic resources. Test filesystem and parent-context canaries. Confirm no successful fallback on adapter failure or identity change. NT96663 performs independent mount-policy and integration acceptance.

## Later increments

Retention, deadlines and cache policy remain unimplemented. The proposed durable root is `/home/aasoft/.local/state/nt96663-subagents`; do not migrate existing evidence now. `PI_SUBAGENTS_TEMP_ROOT` is read at module initialization, so selecting it requires a fresh parent process. That variable alone does not disable cleanup. Preserve evidence from launch and failures while excluding auth material from archives.

Add explicit unlimited overall and supervisor-question waits separately from tool and caller wait-window deadlines. Attention must not terminate waiting work. Add an explicit no-cache command choice and accurately report existing cache scope. Cancellation never releases physical coordinator ownership.
