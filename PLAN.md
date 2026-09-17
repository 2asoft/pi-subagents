# Direct delegation for skill workflows

- Status: Verified
- Owner: Operator and current assistant. Subagents may verify behavior and changes; implementation remains with the current assistant.
- Base: upstream 07bd09e0f93a19caee3c39e3cf4069c70ee8dbcd, version 0.68.0.
- Decision: Direct task delegation is the default. Named profiles remain explicit.

## Contract

A call with `task` and no `agent` starts a native Pi child without a persona file. The same form works inside `runs.run` and `runs.all`. The existing launch pipeline owns sessions, lifecycle, concurrency, controls, artifacts, and resume. A runtime definition supplies the reserved internal identity `$task`; it adds no persona instructions and requires no definition file.

The caller supplies exact skill instructions and task evidence. Model/thinking, tools, and extension selection must be explicit and preserved where supplied. Normal operator/project instructions and skill discovery remain available unless explicitly disabled. Fresh versus forked conversation remains a separate existing option.

Direct launches do not infer acceptance gates, demand edits, rewrite output destinations, add supervisor instructions, or impose a child persona. Execution completion and the skill's acceptance verdict remain separate. Explicit structured output, output files, and acceptance gates still work when requested. Runtime availability checks and lifecycle failure detection remain intact.

Direct tasks receive no mandatory child-boundary prose. Callers can supply boundary instructions themselves. Explicitly selected named profiles keep their existing boundary behavior. Existing nested-delegation tool authorization and depth enforcement remain runtime controls.

## Work and verification

1. Inspect dispatch, prompt assembly, and retained-session contracts. Done.
2. Add failing tests at public dispatch and prompt boundaries for direct calls and parallel workflow children. Done; direct calls failed because agent was mandatory, and parallel children did not launch.
3. Implement direct invocation and exact instruction delivery using existing launch paths. Done. Direct and parallel launch tests pass. Live checks confirmed exact reviewer templates, model/thinking selection, tool isolation, steering, stop, interrupt/resume, and MCP discovery through the installed adapter.
   - Discovery: explicit async workflow children previously returned launch receipts. Direct children now await terminal output; a regression test covers this.
   - Discovery: workflow args are capped at 16 KiB. Parallel examples share the filled template once instead of duplicating it.
   - Discovery: an MCP adapter starts without a connected server's tool catalog. The live check connected exa, then discovered exa_web_search_exa.
4. Update tool descriptions, upstream docs, and our source skill invocation bindings. Done. Model recommendations and role templates remain authoritative in the skills.
5. Run focused tests, then repository typecheck, unit/integration suites and package checks. Done after the final implementation edit: 3,299 unit tests and 1,062 integration tests passed; 20 tests skipped. Typecheck, package build, and diff checks passed.
6. Load this checkout in an isolated Pi verification session. Done with Pi 0.85.1, actual reviewer templates, Luna/high and Sol/medium, control delivery, interruption/resume, cancellation, project context, and the MCP adapter.
7. Review changes directly and with Sol. Done. Verification findings were reproduced and repaired; one inaccurate children.list claim was rejected using its implementation. Keep commits local and leave configured installation unchanged.

## Compatibility and risks

Named profiles remain an explicit existing path. Direct behavior changes the default only where no profile was selected. Direct tasks suppress mandatory boundary prose; the tool/depth controls still enforce delegation access. Forked history, automatic overlays, generated output instructions, and retained-session reconstruction require specific checks because they can change the caller's contract.

No upstream synchronization, new orchestration service, remote publication, or broad cleanup. Existing external CLI adapters remain profile-based. Reverting local changes restores the upstream behavior; no installed configuration is changed during development.

## Alternatives

Persistent role profiles duplicate or approximate skill instructions. Manually launching Pi lacks managed lifecycle controls. A separate runner would duplicate the existing session and control machinery. Reuse that machinery and change its invocation and instruction defaults.

## Verification findings

- Direct resume must forward the original follow-up string after checking nonempty trimmed text. An integration regression reproduces trimming.
- Foreground resume must carry the stored fresh/fork context. The missing context predates this fork; keep its repair separately attributed when committing.
- Large direct instructions exceeded the 64 KiB foreground index contract limit and disappeared from restart recovery. Persist direct options privately beside the child session and store their path in the bounded index. A restart regression reproduces the loss and checks retained configuration.
- Live checks cover control delivery and provider payloads. Durable restart coverage now checks retained configuration and missing files.
- A second review identified output loss if the direct configuration write fails. The regression reproduced it. The runtime now returns completed output with a resume warning and refuses resume without the configuration.
- The claim that missing foreground sidecars remain advertised by children.list was rejected. That action enumerates only background workflow children and checks their recovery descriptors.
- Workflow results now carry persistence warnings and mark affected children not resumable. A regression reproduced warning loss and verifies both direct and workflow results.
- Named live nested follow-ups retain their earlier trimming behavior. The review snapshot preceded that correction; direct follow-ups retain exact text.

## Commit boundaries

1. `94f13e9 fix: retain foreground context on resume`: the resolver introduced in upstream 820a5f1 omitted context; the current fallback was last changed by 28473ac. Keep this upstream correction and its named-profile regression separate. Its staged tree passed typecheck and the regression independently.
2. `feat: delegate exact tasks without agent profiles`: direct configuration, execution, prompt behavior, retention, tests, documentation, and this plan. Fold the feature's verification repairs into this commit.
3. Dotfiles: update the three skill invocation bindings. Keep existing templates and model recommendations.

Sol reviewed the code and these boundaries. The final workflow warning repair follows its recommendation and passes regression coverage and the complete suites. The context commit was also checked in isolation.

## Open questions

No implementation blocker remains for the original direct-delegation increment. This document retains the verification summary; temporary probes are removed after verification. Installation, configuration application, and publication require a later operator request.

## Explicit supervisor increment

Scope agreed with NT96663: provision explicitly requested direct `contact_supervisor` without bridge prose, enforce availability before model work, preserve named profiles and tool restrictions. Environment implementation, retention/deadlines, cache policy and project acceptance remain separate increments.

1. Reproduce missing direct routing and ignored restrictions. Done: both host variants and missing-routing/restriction tests failed before the correction.
2. Provision routing from the explicit direct tool request; require direct tools after native registration. Done. Named-profile exceptions remain unchanged.
3. Verify request/reply and retained tool contract on resume. Done: native file protocol tests and foreground-to-background resume integration pass.
4. Verify unavailable-tool failure releases child extensions before model work. Done: cleanup assertion failed before moving admission to the normal bounded shutdown path. Installed Pi SDK smoke verifies real registration, rejection and both shutdown events without model prompts.
5. Document proposed environment API and exact resources. Done in `docs/execution-environment-proposal.md`; no environment implementation. Review identified the leaf's shared budget read and omitted host terminal proof file; both are now explicit.
6. Complete final repository checks and review follow-up, then commit locally. Done: typecheck and package build pass; 3,303 unit and 1,062 integration tests pass, with 20 skipped. Diff checks pass. Review follow-up `bc310a96-21e2-4f4a-bbcd-1c588b6a7018` returned "No findings." Commit remains local; active sessions require reload to use the correction.

The inherited `PI_OFFLINE=1` causes two Windows global-discovery unit failures on both unchanged HEAD and the working tree. `env -u PI_OFFLINE npm run test:unit` passes. No global environment setting was changed.

Installed SDK smoke command, run from an isolated temporary directory with its own agent state:

```sh
repo=/absolute/path/to/pi-subagents
probe=$(mktemp -d)
mkdir -p "$probe/agent"
(cd "$probe" && PI_CODING_AGENT_DIR="$probe/agent" PI_SUBAGENTS_TEMP_ROOT="$probe/runtime" \
  pi --mode rpc --no-session --no-extensions --no-skills -e "$repo/test/smoke/direct-supervisor.ts")
```

Standalone Node imports of this Pi installation failed on missing external dependencies; the smoke instead uses Pi's actual extension loader. It does not submit model prompts or modify active configuration. Native registration and cleanup passed through that loader.
