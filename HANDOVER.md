# Handover

## Objective

Build a standalone Discord and Linear bot. A mention gathers channel/thread/ticket context and relevant GitHub repository information, uses an LLM to prepare the task, then starts work in T3 Code.

## Current implementation

Updated 2026-10-02 after scope alignment with Chan.

- Discord first. Every mention creates a new T3 task, including repeated mentions in the same Discord thread. Further conversation happens in T3.
- The LLM receives the mention, up to `DISCORD_CONTEXT_MESSAGES` previous messages, the channel description, and existing T3 projects. It selects a target and prepares the initial prompt. Unknown or ambiguous targets receive a rejection asking for repository information.
- Task state is in memory. No persistent task records or restart recovery are required.
- CPA supplies `gpt-6-luna` for preparation; the coding model also defaults to `gpt-6-luna`. Both use `xhigh` reasoning by default. Both remain configurable.
- JSON configuration supports multiple guilds, each with its own allowed users. Secrets reference environment variable names. Append-only JSON file logging covers task milestones and errors. See sunday.example.json.
- Friday's configured allowlist supplied guild `842724454677348352` and user `435482941515104257`. All accessible channels in that guild are allowed for that user. No repository allowlist is required; deployment GitHub authentication limits access.
- Normal T3 pairing requires only orchestration:read and orchestration:operate. Tokens persist across restarts; normal credentials require manual pairing at expiry. Automatic renewal is supported only for credentials already granted access:write.
- T3 pairing, owner-only credential storage, renewal, JSON WebSocket RPC, project discovery, server-managed worktree/thread/setup bootstrap are implemented. Discord replies only acknowledge launch with a T3 link; no Discord threads or approval/completion notifications are created. The bot supplies destinations under configurable t3.cloneRoot to T3 projectClone.start, tracks completion, and uses the returned checkout path. T3 performs cloning and selects worktree paths. There is no worktree root setting.
- Effect CLI provides `pair` and `run`, generated help, version, argument validation, and shell completions. Configuration and service layers load only for accepted command handlers. Configuration is documented in README.md, sunday.example.json, and .env.example.
- Upstream main was checked again and still resolves to `5cc99e1c23980d7995a13c47f969b47cb68ed1be`. The outdated local T3 repository was not used.
- `pnpm verify` and `pnpm build` pass, with 18 focused tests. A live CPA preparation call using `gpt-6-luna` at `xhigh` correctly rejected an ambiguous target. Discord/T3 end-to-end testing awaits the new bot token and a privileged T3 pairing credential.
- GitHub Actions CI verifies, builds, and packages the binary on PRs. Releases on `v*` tag pushes reuse CI and publish the Linux x64 archive plus SHA256 checksums after success. Branch protection must require the CI check when a GitHub remote is configured.
- Linear remains unimplemented until Discord is tested end to end.

The sections below retain the original API findings and bootstrap record. Chan's current scope above overrides older recommendations for persistent job storage and source-platform follow-ups.

## Accepted decisions

- Separate project connecting to an unmodified T3 Code server. No T3 fork and no T3 Connect dependency.
- One package managed by pnpm; no monorepo.
- Bun runtime; one standalone compiled executable for releases.
- Effect v4, TypeScript 7, Effect tsgo, Oxlint, and Oxfmt.
- Use Effect's AI SDK for LLM operations.
- Reuse existing T3 projects or invoke T3 cloning beneath configured t3.cloneRoot. Request isolated worktrees through T3 bootstrap; T3 selects their paths.
- Automatically rotate T3 credentials before expiry using existing pairing APIs.

## Original bootstrap state

| Component                | Pinned version or configuration |
| ------------------------ | ------------------------------- |
| effect                   | 4.0.0                           |
| @effect/platform-bun     | 4.0.0                           |
| @effect/tsgo             | 0.47.2                          |
| typescript               | 7.0.2                           |
| oxlint / @oxlint/plugins | 1.86.0                          |
| oxlint-tsgolint          | 7.0.2003                        |
| oxfmt                    | 0.71.0                          |
| @types/bun               | 1.4.2                           |
| pnpm                     | 12.6.0                          |
| Release target           | bun-linux-x64-baseline          |

The current stable Effect v4 release exposes the former unstable AI SDK through `effect/ai`. LanguageModel, Prompt, Tool, and Toolkit are included in the effect dependency. A provider package and credentials should be selected when implementing LLM calls; no provider is configured here.

`src/main.ts` uses BunRuntime and prints a bootstrap message, then exits. No Discord, Linear, GitHub, T3 connection, persistence, credential storage, or LLM behavior is implemented.

`.oxfmtrc.json` and both custom lint plugin directories were copied from `/home/chanyeinthaw/Projects/friday`. `.oxlintrc.json` preserves its rules and recommended Effect preset; only dependency paths were adjusted for this single-package layout. Typechecking covers application source, matching Friday's exclusion of its copied tooling. The postinstall hook patches TypeScript 7 and Oxlint with Effect tsgo. Check and lint scripts reapply patches idempotently.

`pnpm-workspace.yaml` contains pnpm's package release-age exceptions only; there are no workspace packages. Dependencies are pinned and pnpm-lock.yaml is included for reproducible installs.

## Commands

| Command       | Purpose                                               |
| ------------- | ----------------------------------------------------- |
| pnpm install  | Install dependencies and patch compiler/linter        |
| pnpm start    | Run the entry point once                              |
| pnpm dev      | Watch application source with Bun                     |
| pnpm check    | Typecheck with Effect's patched TypeScript 7 compiler |
| pnpm lint     | Run Friday rules and Effect recommended diagnostics   |
| pnpm format   | Apply copied Oxfmt configuration                      |
| pnpm verify   | Format check, lint, and typecheck                     |
| pnpm build    | Compile dist/sunday for Linux x64 baseline            |
| ./dist/sunday | Run standalone executable                             |

## T3 integration findings

Research source: current upstream `pingdotgg/t3code` at commit `5cc99e1c23980d7995a13c47f969b47cb68ed1be`, inspected on 2026-10-01. The local fork was rejected as the research basis. Full payloads, caveats, and pinned source links are in [docs/t3-api-research.md](docs/t3-api-research.md).

| Requirement                            | API                                                                          |
| -------------------------------------- | ---------------------------------------------------------------------------- |
| Inspect projects                       | GET /api/orchestration/shell or orchestration.subscribeShell                 |
| Clone and register                     | WebSocket projectClone.start                                                 |
| Track clone                            | subscribeProjectClones; wait for phase done                                  |
| Register existing checkout             | Dispatch project.create                                                      |
| Create worktree/thread and start agent | WebSocket orchestration.dispatchCommand with thread.turn.start and bootstrap |
| Explicit worktree path                 | vcs.createWorktree, then thread.create and thread.turn.start                 |
| Track conversation                     | orchestration.subscribeThread                                                |
| Track setup                            | subscribeWorktreeSetup                                                       |

Combined thread/worktree/setup bootstrap is implemented in the WebSocket handler. HTTP dispatch accepts the same schema but does not execute those bootstrap side effects. Use WebSocket for the combined workflow and set requireWorktree:true to avoid fallback to the main checkout.

T3's contract and client-runtime packages are private. Build a small adapter for the chosen server revision; do not assume they are published installable SDKs. Its pinned upstream source used prerelease Effect APIs, while this project uses stable Effect v4. Check protocol and contract compatibility before importing or porting source.

Clone progress is in memory; server restart can leave a registered project with an incomplete checkout. Setup failures are best effort, and asynchronous setup can overlap agent startup. Persist integration job state and reconcile ambiguous outcomes before retrying. Dispatch acceptance does not mean agent completion.

Paths refer to the T3 server host. Current implementation leaves path allocation to T3. T3 scopes are environment-wide, not repository sandboxes. Repository Git credentials and provider CLIs belong on that host.

## Pairing and automatic rotation

1. Obtain an initial pairing grant with orchestration:read, orchestration:operate, and access:write. Ordinary pairing does not include access:write; initial setup must grant it explicitly.
2. Exchange it at POST /oauth/token using form-urlencoded OAuth token-exchange fields. Store the returned bearer token securely with its expiry.
3. Call POST /api/auth/websocket-ticket using the bearer token and connect to /ws?wsTicket=... . Tickets last five minutes; bearer sessions default to 30 days.
4. Before expiry, call POST /api/auth/pairing-token with a label and those same explicit scopes, then exchange the returned credential at /oauth/token.
5. Persist the replacement credential before replacing active connections. Retire old sessions without revoking the new one or other clients.
6. If expiry or revocation prevents renewal, report that manual pairing is required. An open socket can outlive session expiry; this is not credential renewal.

access:write grants connection management, not merely renewal. Do not rely on a long-lived open socket as the recovery mechanism. Do not print tokens or store them in Git.

Source: [pairing handler](https://github.com/pingdotgg/t3code/blob/5cc99e1c23980d7995a13c47f969b47cb68ed1be/apps/server/src/auth/http.ts#L401).

## External integrations

Linear supports OAuth app users with actor=app and app:mentionable. AgentSessionEvent created covers mentions/delegation; prompted supplies follow-up prompts. promptContext supplies issue and comment context. Acknowledge webhooks within five seconds and emit an activity plus update the external URL within ten seconds. Sources: [agent setup](https://linear.app/developers/agents), [agent interaction](https://linear.app/developers/agent-interaction).

Discord first-party documentation was blocked with HTTP 403 during research. Verify current mention events, channel/thread history permissions, and message-content requirements before implementation.

## Original implementation plan

1. Implement T3 pairing, secure credential persistence, pre-expiry rotation, and reconnection.
2. Implement project discovery and one existing-project worktree/thread launch through WebSocket; verify against an explicitly authorized isolated server.
3. Persist external conversation IDs, event IDs, repository selection, project/thread/message/command IDs, expiry, and job milestones. Handle duplicate delivery and server restart.
4. Add repository allowlists/root validation and the clone-backed project flow.
5. Implement Discord mentions and context gathering, then Linear agent sessions and follow-ups.
6. Add LLM task preparation using Effect AI, with a configurable provider and schema-decoded output.
7. Relay progress, approval requests, completion, errors, and thread links back to the originating conversation.
8. Add focused tests for auth rotation, duplicate delivery, repository routing, and interrupted job recovery.

## Original unresolved choices

- Bot name, repository hosting, and release distribution.
- Direct T3 server URL, server revision, and initial privileged pairing method.
- Configured clone root and worktree location on the T3 host.
- Allowed Discord users/channels and Linear workspaces/teams.
- Repository routing rules and GitHub authentication.
- LLM provider/model and T3 coding provider/model.
- Credential storage, persistent job storage, and deployment host.

## Original bootstrap validation

- `pnpm verify` passed formatting, lint, and TypeScript 7 checks.
- `pnpm build` produced a 78 MiB Linux x64 baseline executable.
- The executable ran from `/tmp` with an empty environment and only `/usr/bin:/bin` in PATH; output was `sunday bootstrap ready`.
- `pnpm start` ran successfully.
- Effect AI imports LanguageModel, Prompt, Tool, and Toolkit resolved under Bun.
- A temporary chained-assertion probe was rejected by the copied custom lint rules and then removed.
- All 23 lint plugin files and the Oxfmt configuration match Friday byte for byte.
- Git was initialized on main. No remote or commits were created.
- No live T3 server, database, service, or credentials were accessed during bootstrapping.
