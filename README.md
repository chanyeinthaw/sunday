# sunday

A Discord mention starts a new coding task in T3 Code. The bot sends the mention, up to N previous messages, the channel description, and existing T3 projects to an LLM. The LLM selects the project or GitHub repository and prepares the initial prompt. If it cannot identify a target, the bot asks for repository information. Mention it again to submit a new task.

Each accepted mention creates a separate worktree and T3 thread. Repeated mentions in the same Discord channel or thread always start new tasks. The bot acknowledges task launch with Markdown links to open the task in the mobile app or web UI as a reply to the invoking message. Further conversation happens in T3.

Task state stays in memory. Restarting the bot loses duplicate detection; work already started in T3 continues. Only pairing credentials are stored locally. Linear is deferred until the Discord flow passes end-to-end testing.

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

Enable Message Content Intent in the Discord Developer Portal so history contains message text. The bot needs View Channel, Read Message History, Send Messages, and Send Messages in Threads permissions. It replies to the invoking message and does not create Discord threads.

Set the LLM API key environment variable from Fleet's `agents/cpa1-api-key` gopass entry. With `github.token` set to `null`, the bot uses its deployment's `gh auth login`. To use a token instead, set `github.token` to `{ "env": "GH_TOKEN" }` and provide that variable. The GitHub config only controls authentication for repository metadata lookup, such as description and default branch. There is no repository allowlist. GitHub access is limited by that login. Git credentials and coding provider configuration must also be available on the T3 server host.

`t3.publicUrl` controls the T3 links sent to Discord; it defaults to `t3.serverUrl`. The example uses `https://code.p.si14.space` for links and `http://localhost:3773` for the API connection. `t3.runtimeMode` is `full-access` in the example.

Sunday's internal context preparation uses `llm.model` and `llm.reasoningEffort`, with `gpt-6-luna` and `xhigh` in the example. Coding uses T3's project default model and options, falling back to its environment default. Configure these in T3; Sunday rejects launch if no default is configured.

T3 manages task worktrees and setup scripts through its `orchestration.launchThread` RPC. Configure `t3.cloneRoot` as an absolute directory on the T3 host for missing repositories. The bot supplies `<cloneRoot>/<owner>/<repo>` to T3's clone method and waits for completion before launching the task. T3 performs the clone and registers the project. Existing projects keep their checkout location. The bot supplies a unique `sunday/<threadId>` branch for each task and does not configure or allocate worktree paths. Clone path validation is lexical; keep the clone root free of symlinks that escape it.

`discord.contextMessages` accepts 0 to 100; the example uses 25. The mention is supplied separately from these previous messages. Threads use their parent channel's description.

## Logging

`logging.file` specifies the absolute path to an append-only JSON Lines log. `logging.level` accepts `Debug`, `Info`, `Warn`, or `Error`. Logs also go to the console. The file's parent directories are created automatically, and new files use mode `0600`.

Task logs cover receipt, LLM preparation/rejection, repository cloning, agent start and failures. Entries include timestamps, severity, and relevant event, guild, user, channel, project, or T3 thread IDs. Pairing and credential renewal are logged without token values. Prompts, channel history, and agent responses are not logged.

The file logger batches writes every second and flushes remaining entries during graceful shutdown. Use deployment log rotation to manage retention.

## Pairing

Use a normal T3 pairing code. Sunday requests `orchestration:read`, `orchestration:operate`, and `source-control:write`. Existing sessions with only the two orchestration permissions can still launch tasks in registered projects. Clone requests need a new pairing grant with `source-control:write`; renewal preserves existing permissions and cannot add it.

Pipe the code to stdin without passing it as a command-line argument:

```sh
gopass show --noparsing <pairing-entry> | pnpm start pair
pnpm start run
pnpm start --help
```

Commands use Effect CLI, with generated `--help`, `--version`, and shell completions. Help and argument validation do not load configuration or connect to services.

`t3.stateDirectory` must be owned by the current user and have mode `0700`. Credentials use mode `0600`, atomic replacement, and redaction in application errors. The bot binds saved credentials to the server origin in JSON and reloads it after restart. Normal pairing requires a fresh code when the token expires; automatic renewal is available only for credentials explicitly granted `access:write`. It never revokes other clients' sessions. Expired or revoked credentials require manual pairing.

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

The T3 adapter targets upstream `pingdotgg/t3code` at `e01f72d108003d48310ae0e24dd6805ae085d889` from nightly `v0.0.46-preview.20261009.2851`, checked on 2026-10-09. It uses JSON WebSocket RPC with `orchestrationProtocol=2` and a fresh ticket per connection. Mutating calls are not automatically replayed after an ambiguous response. Inspect T3 before retrying such a task.

Pull requests run the `Verify and build` check, including `pnpm verify`, compilation, and binary packaging. Configure this check as required in GitHub branch protection to gate merges.

Pushing a `v*` tag reruns the same checks, then creates a GitHub Release with `sunday-linux-x64.tar.gz` and `SHA256SUMS`. The archive contains the standalone Linux x64 executable and preserves its executable permission. Configure the JSON file and secret environment variables separately on the deployment host.

```sh
git tag v0.0.0-nightly.1
git push origin v0.0.0-nightly.1
```

Tags containing a hyphen, such as `v0.0.0-nightly.1`, publish as prereleases and are not marked as the latest stable release.

## App-opening page

Sunday serves `/open/<environmentId>/<threadId>` on `127.0.0.1` at `landing.port`. Set optional `landing.publicUrl` to Sunday’s external HTTPS origin, including a port if needed. When omitted, it defaults to `http://localhost:<landing.port>`. For example: `"landing": { "port": 3784, "publicUrl": "https://sunday.example.com" }`. Discord's **Open in app** link uses `/app/<environmentId>/<threadId>`, which immediately sends a 302 redirect to `t3code://threads/...`. The `/open/...` button page remains available if an in-app browser blocks the redirect; **Open in web** uses `t3.publicUrl`. The mobile app must already have the T3 environment paired. The page is served by the same `run` process as the bot.
