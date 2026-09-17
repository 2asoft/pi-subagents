# Linux execution environments

Direct background tasks can select a trusted, registered bubblewrap policy. The extension owns native execution and process lifetime. The project owns the filesystem mounts, admitted context, environment variables and network choice.

## Invocation

```js
{
  task: "Perform the admitted task.",
  executionEnvironment: "project",
  cwd: "/absolute/prepared/worktree",
  async: true,
  context: "fresh",
  tools: ["read", "bash", "contact_supervisor"],
  inheritProjectContext: false,
  inheritGlobalContext: false,
  inheritSkills: false,
  skill: false,
  output: false,
  acceptance: false
}
```

Model and thinking selection use the ordinary direct-task fields. Resume restores the selection retained by the host. The admitted child configuration must provide that model and any required provider extension.

This increment supports one native direct leaf on Linux, with canonical absolute run paths and a cwd prepared by the caller. It uses `/usr/bin/bwrap` and `/usr/bin/node`; source checkouts require Node's TypeScript stripping support. Verification used bubblewrap 0.12.0 and Node 26.8.2.

Foreground execution, forked context, named profiles, nested delegation, remote machines, managed worktree creation, host acceptance/gates, managed output destinations, and caller-selected skills/extensions are rejected. The adapter supplies admitted skill and extension paths. Tool patterns that admit `subagent` or `subagent_supervisor` are rejected; `contact_supervisor` is supported. Unsupported requests and failed startup never fall back to ordinary host execution or an external CLI runner.

## Trusted registration

A project extension without a package dependency looks up the public registration API during `session_start`. Enable pi-subagents in Pi's package settings or load its entrypoint explicitly. No project package-manager setup or installed-package path is needed in the consumer:

```ts
import { buildPolicy } from "/trusted/project/environment-policy.ts";

let disposeRegistration: (() => void) | undefined;
pi.on("session_shutdown", () => {
  disposeRegistration?.();
  disposeRegistration = undefined;
});
pi.on("session_start", (_event, ctx) => {
  disposeRegistration?.();
  disposeRegistration = undefined;
  const api: unknown = Reflect.get(
    globalThis, Symbol.for("pi-subagents.execution-environment-api.v1")
  );
  if (!api || typeof api !== "object"
      || !("version" in api) || api.version !== 1
      || !("register" in api) || typeof api.register !== "function") {
    throw new Error("Enable pi-subagents before registering an execution environment.");
  }
  const registration: unknown = api.register({
    sessionId: ctx.sessionManager.getSessionId(),
    name: "project",
    modulePath: "/trusted/project/environment-policy.ts",
    policyFiles: ["/trusted/project/environment-policy.json"],
    buildPolicy,
  });
  if (!registration || typeof registration !== "object"
      || !("dispose" in registration)
      || typeof registration.dispose !== "function") {
    throw new Error("Invalid execution environment registration handle.");
  }
  const release = registration.dispose;
  disposeRegistration = () => { release.call(registration); };
});
```

The frozen version-1 service exposes `register`, the same registrar as the package API. Each parent runtime publishes it during extension initialization. It remains available until the last publisher shuts down, including across loader instances. Lookup during `session_start` works in either extension load order; repeat the lookup after reload. Pi can log a session-start exception without a nonzero CLI exit, so automation must check successful registration rather than exit status alone.

The bare import `pi-subagents/execution-environments` remains available where normal package resolution can find pi-subagents. Enabling a Pi package does not make that import resolvable from an unrelated project directory.

Registration returns `{ dispose(): void }`. Names are unique within a parent session. Separate extension-loader instances share the registry. A restarted parent must register the definition again. Dispose the consumer's registration on shutdown, as above: withdrawing the service does not remove registrations. This prevents duplicate-name errors and stale callbacks when reloading the same session.

Define `buildPolicy` in the declared self-contained module. Node builtins are permitted. Declare additional policy inputs in `policyFiles`. Registration pins canonical targets and SHA256 bytes; resolution rechecks the original supplied paths, so symlink retargeting also counts as drift. Retained runs cannot repin a changed definition.

The registering extension is trusted to associate the callback with the declared module and inputs. Project review covers that association and the mount policy. The registry does not load another module graph or copy the parent's configuration into the worker.

## Adapter contract

```ts
interface EnvironmentInput {
  readonly version: 1;
  readonly name: string;
  readonly definitionDigest: string;
  readonly runId: string;
  readonly childIndex: 0;
  readonly launchKind: "start" | "resume";
  readonly runner: {
    readonly executable: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
  };
  readonly resources: readonly Resource[];
}

interface Resource {
  readonly role: "bootstrap" | "run" | "session" | "artifacts"
    | "supervisor" | "result" | "runtime";
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly access: "read" | "read-write";
}

type Mount =
  | { kind: "bind"; source: string; destination: string;
      access: "read" | "read-write" }
  | { kind: "tmpfs"; destination: string }
  | { kind: "directory"; destination: string }
  | { kind: "symlink"; target: string; destination: string };

interface BubblewrapPolicy {
  mounts: Mount[];
  cwd: string;
  env: Record<string, string>;
  network: "shared" | "isolated";
  context: {
    agentDirectory: string;
    instructionFiles: string[];
    skillFiles: string[];
    extensionFiles: string[];
  };
}

function buildPolicy(input: EnvironmentInput): BubblewrapPolicy;
```

Input records and arrays are frozen. Output must match the closed schema and is cloned before use. Paths are absolute, except a symlink target may be relative. Policy cwd must equal the prepared cwd.

Mounts execute in order. The extension appends its resource bindings at matching absolute paths, then creates `/proc` and `/dev`. Runtime resources identify code/executables that must remain inaccessible or read-only; the adapter supplies their namespace mounts. The extension does not automatically mount runtime resources. The staged result resides under the run binding and needs no separate file mount.

The compiler reserves `/`, `/proc`, `/dev`, namespace/lifetime options, descriptor numbers and the exact runner command. There is no executable/argv return, `--args` input, arbitrary command tail, or indirect option source. Canonical source checks exclude host authority, session leases, published results and shared fanout budgets. Known definition and runtime sources cannot be mounted writable.

The adapter must admit runtime dependencies, prepared Git worktree metadata, approved configuration/provider resources, and any required socket directory. Credential/configuration storage belongs outside run evidence; known archive-backed agent directories are rejected. No credentials are copied into bootstrap or recovery files.

## Resources and authority

Let `T` be `PI_SUBAGENTS_TEMP_ROOT`, or the ordinary per-user temporary root. For run ID `id`:

| Path | Access from the worker |
| --- | --- |
| `R = T/async-subagent-runs/id` | Read-write run data and control inbox |
| `R/bootstrap.json` | Read-only sanitized bootstrap; retained with the run |
| `R/session/session.jsonl` | Initial native session |
| `R/artifacts` | Dedicated artifacts directory |
| `R/environment-result.json` | Staged result, covered by the run binding |
| `T/supervisor-channels/<safeRunId>-<safeAgent>-0` | Dedicated request/reply channel |
| Extension runtime root and selected executable files | Declared as read-only runtime resources |
| `H = T/environment-owners/id` | Unmounted host authority |
| `T/session-leases/<canonical-session-path-sha256>/owner.json` | Unmounted canonical session lease |
| `T/async-subagent-results/...` | Unmounted published results |
| `T/run-fanout-budgets/...` | Unmounted accounting; the leaf receives a snapshot |

`$task` is sanitized when constructing the supervisor directory. The exact channel path is supplied in `resources`. Resume binds the original session directory rather than copying the session into a new run.

`H` contains `binding.json`, `recovery-descriptor.json`, `owner.json`, `namespace-terminal.json`, `process-terminal-candidate.json`, `process-terminal.json`, and host control requests. Failed admission can leave an authority directory without a completed binding; recovery rejects that state. Worker recovery, PID fields, runner labels and terminal candidates cannot replace these records.

The bootstrap contains explicit task data and admitted paths. Parent research instructions, conversation, ambient skills, provider registries and shared budget storage are excluded. Instruction and skill contents are read inside the namespace; admitted extensions load there. The configured agent directory supplies approved SDK resources. The normal temporary-config unlink is skipped for confined bootstrap files.

Host resume and transcript inspection use the original session binding. Outside-root and symlink session paths are rejected before content reads. Transcript reads hold directory/file descriptors to prevent concurrent renames from redirecting reads. Run-directory aliases and nested paths cannot select an ordinary recovery path. The launcher rejects symlinks and non-regular files when reading bootstrap, startup control, status and result files. Host terminal event appends use checked descriptors.

## Lifetime and recovery

A detached extension launcher owns bubblewrap. Bubblewrap's parent-death relationship points to that launcher, so orchestrator exit does not terminate an admitted worker. The extension sets the PID/user namespaces, new session, parent-death behavior, private JSON status descriptor 3 and startup barrier descriptor 4.

Before authorizing execution, the host records launcher and monitor identities and verifies namespace PID 1 using bubblewrap's private status pipe, process start time, boot ID and namespace inode. The parent waits for this ownership acknowledgement before releasing the barrier or reporting startup success.

Namespace PIDs remain telemetry. Controls target the owned monitor through its process handle. Stop and timeout terminate the namespace; interrupt first allows the native runner to stop, with a bounded grace period. Namespace-init disappearance proves teardown of its descendants, including orphaned detached processes. The launcher verifies that disappearance before releasing the session lease or producing observed namespace evidence.

After parent or launcher loss, recovery uses private identities and current kernel observations. It requires the launcher, monitor and namespace init to have terminated. An inaccessible process record remains unknown. Abandoned environment leases cannot be reclaimed solely because the launcher disappeared. Recovery reserves the canonical session while reclaiming its abandoned lease, then finalizes host proof. A concurrent legitimate writer blocks that recovery.

Missing namespace identity or inaccessible evidence prevents observed termination and automatic lease reclamation. Process termination never releases device/coordinator ownership or proves hardware safety.

## Verification and operations

`test/integration/environment-lifecycle.test.ts` exercises real namespaces with orphaned detached descendants through completion, stop, interrupt, timeout, launcher death, monitor death, a FIFO result, a FIFO event file and a symlink at the event file. Launcher death coverage first records the production callback's unknown proof, then verifies recovery can upgrade it. It checks a forged worker PID against a separate sentinel process.

`node test/smoke/environment-consumer.mjs /path/to/pi` creates a consumer outside the package and verifies configured-package discovery, both explicit load orders and missing-service rejection without model work.

Run `node --experimental-strip-types test/smoke/environment-background.mjs /path/to/pi` for the native SDK smoke. It uses a synthetic provider, two parent Pi processes, supervisor request/reply, retained resume, writable recovery replacement, definition drift, session-path rejection and context/filesystem canaries. Evidence remains in the printed temporary directory.

Reload the parent extension and trusted registration extension after deploying this increment. Existing children retain their loaded runtime. This change does not configure retention, unlimited deadlines or acceptance caching; those remain separate increments.
