# sunday

A Discord mention starts a new coding task in T3 Code. The bot sends the mention, up to N previous messages, the channel description, and existing T3 projects to an LLM. The LLM selects the project or GitHub repository and prepares the initial prompt. If it cannot identify a target, the bot asks for repository information. Mention it again to submit a new task.

Each accepted mention creates a separate worktree and T3 thread. Repeated mentions in the same Discord channel or thread always start new tasks. The bot relays completion, errors, approval notifications, and T3 links. Approvals and further conversation happen in T3.

Task state stays in memory. Restarting the bot loses duplicate detection and progress watchers; work already started in T3 continues. Only pairing credentials are stored locally. Linear is deferred until the Discord flow passes end-to-end testing.

## Setup

```sh
pnpm install
cp sunday.example.json sunday.json
cp .env.example .env
```

Edit `sunday.json` for your deployment. Set `SUNDAY_CONFIG` to use a different file. The example contains the authorized local T3 server and the guild/user IDs found in Friday's allowlist; the application has no built-in guild or user IDs.

`discord.guilds` supports multiple guilds. Each guild has its own allowed users, across all accessible channels:

```json
"guilds": [
  { "id": "842724454677348352", "userIds": ["435482941515104257"] },
  { "id": "1021288369327706153", "userIds": ["435482941515104257"] }
]
```

Secrets reference environment variable names, never literal values:

```json
"token": { "env": "DISCORD_BOT_TOKEN" }
```

Set the referenced variables in `.env` during development or in the deployment environment. You may choose different names in the JSON file. The loader rejects literal secrets, unknown configuration keys, and missing referenced secrets. `sunday.json`, `.env`, and JSON log files are ignored by Git.

Enable Message Content Intent in the Discord Developer Portal so history contains message text. The bot needs View Channel, Read Message History, Send Messages, Create Public Threads, and Send Messages in Threads permissions. It creates a Discord thread for a mention in a regular channel and uses the existing thread when mentioned inside one.

Set the LLM API key environment variable from Fleet's `agents/cpa1-api-key` gopass entry. With `github.token` set to `null`, the bot uses its deployment's `gh auth login`. To use a token instead, set `github.token` to `{ "env": "GH_TOKEN" }` and provide that variable. The GitHub config only controls authentication for repository metadata lookup, such as description and default branch. There is no repository allowlist. GitHub access is limited by that login. Git credentials and coding provider configuration must also be available on the T3 server host.

Confirm `t3.providerInstanceId` against the server's configured provider instance. Both models and reasoning effort are specified in JSON; the example uses `gpt-6-luna` with `xhigh`.

T3 manages task worktrees, branch names, and setup scripts through its WebSocket turn-start bootstrap. Configure `t3.cloneRoot` as an absolute directory on the T3 host for missing repositories. The bot supplies `<cloneRoot>/<owner>/<repo>` to T3's clone method and waits for completion before launching the task. T3 performs the clone and registers the project. Existing projects keep their checkout location. The bot does not configure or allocate worktree paths. Clone path validation is lexical; keep the clone root free of symlinks that escape it.

`discord.contextMessages` accepts 0 to 100; the example uses 25. The mention is supplied separately from these previous messages. Threads use their parent channel's description.

## Logging

`logging.file` specifies the absolute path to an append-only JSON Lines log. `logging.level` accepts `Debug`, `Info`, `Warn`, or `Error`. Logs also go to the console. The file's parent directories are created automatically, and new files use mode `0600`.

Task logs cover receipt, LLM preparation/rejection, repository cloning, agent start, approval notifications, completion, and failures. Entries include timestamps, severity, and relevant event, guild, user, channel, project, or T3 thread IDs. Pairing and credential renewal are logged without token values. Prompts, channel history, and agent responses are not logged.

The file logger batches writes every second and flushes remaining entries during graceful shutdown. Use deployment log rotation to manage retention.

## Pairing

Create a T3 pairing credential with `orchestration:read`, `orchestration:operate`, and `access:write`. Standard pairing scopes omit `access:write`, which is required for automatic renewal. Pipe the credential to stdin without passing it as a command-line argument:

```sh
gopass show --noparsing <pairing-entry> | pnpm start pair
pnpm start run
pnpm start --help
```

Commands use Effect CLI, with generated `--help`, `--version`, and shell completions. Help and argument validation do not load configuration or connect to services.

`t3.stateDirectory` must be owned by the current user and have mode `0700`. Credentials use mode `0600`, atomic replacement, and redaction in application errors. The bot binds saved credentials to the server origin in JSON and renews before expiry. It never revokes other clients' sessions. Expired or revoked credentials require manual pairing.

Only one process may use a state directory. A crash can leave `process.lock`; remove it after confirming the old process has stopped. `t3.stateDirectory` must be outside Git.

## Development and release

```sh
pnpm dev
pnpm test
pnpm verify
pnpm build
./dist/sunday run
```

`pnpm verify` runs formatting, lint, typechecking, and focused Effect tests. `pnpm build` produces one Linux x64 baseline executable including the Bun runtime. The executable does not require Bun, Node.js, or node_modules; supply the JSON configuration file and referenced environment variables.

The T3 adapter targets upstream `pingdotgg/t3code` main at `5cc99e1c23980d7995a13c47f969b47cb68ed1be`, checked on 2026-10-02. It uses JSON WebSocket RPC with a fresh ticket per connection. Mutating calls are not automatically replayed after an ambiguous response. Inspect T3 before retrying such a task.

Pull requests run the `Verify and build` check, including `pnpm verify`, compilation, and binary packaging. Configure this check as required in GitHub branch protection to gate merges.

Pushing a `v*` tag reruns the same checks, then creates a GitHub Release with `sunday-linux-x64.tar.gz` and `SHA256SUMS`. The archive contains the standalone Linux x64 executable and preserves its executable permission. Configure the JSON file and secret environment variables separately on the deployment host.

```sh
git tag v0.1.0
git push origin v0.1.0
```
