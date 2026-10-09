import { expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Redacted from 'effect/Redacted'
import * as Ref from 'effect/Ref'
import * as Stream from 'effect/Stream'
import { runBot } from './bot.ts'
import { Discord, type DiscordContext } from './discord.ts'
import { GitHub } from './github.ts'
import { Preparation, type PreparedTask } from './preparation.ts'
import { Settings } from './settings.ts'
import { T3Auth } from './t3/auth.ts'
import { T3Client } from './t3/client.ts'
import { T3Config } from './t3/config.ts'
import type { ThreadLaunch, ModelSelection, Project } from './t3/protocol.ts'

const context: DiscordContext = {
  channelName: 'support',
  channelDescription: 'Questions about our app',
  threadName: 'Signup bug',
  messages: [
    { author: 'colleague', content: 'Signup fails on mobile', createdAt: '2026-10-01T00:00:00Z' },
  ],
}
const projects: ReadonlyArray<Project> = [
  { id: 'existing-project', title: 'App', workspaceRoot: '/srv/app' },
]
const task: PreparedTask = {
  kind: 'launch',
  target: { kind: 'project', projectId: 'existing-project' },
  title: 'Fix signup',
  prompt: 'Investigate the mobile signup failure described in the conversation.',
}

const fixture = Effect.fn('BotTest.fixture')(function* (
  decisions: ReadonlyArray<PreparedTask>,
  clonePhase = 'done',
  defaultModel: typeof ModelSelection.Type | null = {
    instanceId: 'configured-provider',
    model: 'configured-model',
    options: [{ id: 'reasoningEffort', value: 'medium' }],
  },
) {
  const clones = yield* Ref.make<
    ReadonlyArray<{ projectId: string; destinationPath: string; repository: string }>
  >([])
  const commands = yield* Ref.make<ReadonlyArray<ThreadLaunch>>([])
  const replies = yield* Ref.make<ReadonlyArray<string>>([])
  const calls = yield* Ref.make(0)
  const discord = Layer.succeed(
    Discord,
    Discord.of({
      mentions: Stream.fromIterable(
        decisions.map((_, index) => ({
          id: `10000000000000000${index}`,
          channelId: 'channel',
          guildId: 'guild',
          userId: 'user',
          content: '<@bot> please handle this',
        })),
      ),
      context: () => Effect.succeed(context),
      reply: (_, text) => Ref.update(replies, (current) => [...current, text]),
    }),
  )
  const preparation = Layer.succeed(
    Preparation,
    Preparation.of({
      prepare: Effect.fn('BotTest.prepare')(function* (request, receivedContext, receivedProjects) {
        expect(request).toBe('<@bot> please handle this')
        expect(receivedContext).toEqual(context)
        expect(receivedProjects).toEqual(projects)
        const index = yield* Ref.getAndUpdate(calls, (count) => count + 1)
        const decision = decisions[index]
        if (!decision) return yield* Effect.die('Unexpected preparation call')
        return decision
      }),
    }),
  )
  const t3 = Layer.succeed(
    T3Client,
    T3Client.of({
      projects: () => Effect.succeed(projects),
      defaultModel: () => Effect.succeed(defaultModel),
      launch: (command) =>
        Ref.update(commands, (current) => [...current, command]).pipe(
          Effect.as(`accepted-${command.threadId}`),
        ),
      clone: (request) =>
        Ref.update(clones, (current) => [...current, request]).pipe(
          Effect.as({ projectId: request.projectId, cwd: '/server/returned-checkout' }),
        ),
      clonePhase: () => Effect.succeed(clonePhase),
    }),
  )
  const auth = Layer.succeed(
    T3Auth,
    T3Auth.of({
      pair: () => Effect.void,
      credential: () =>
        Effect.succeed({
          version: 1,
          origin: 'http://localhost:3773',
          accessToken: Redacted.make('fixture'),
          expiresAt: 1800000000000,
          renewAt: 1799990000000,
          scope: 'fixture',
        }),
      ticket: () => Effect.die('Unused fixture operation'),
    }),
  )
  const github = Layer.succeed(
    GitHub,
    GitHub.of({
      repository: () =>
        Effect.succeed({
          full_name: 'owner/missing',
          description: null,
          default_branch: 'main',
          html_url: 'https://github.com/owner/missing',
        }),
    }),
  )
  const settings = Layer.succeed(Settings, {
    contextMessages: 25,
    guilds: [{ id: 'guild', userIds: ['user'] }],
    discordToken: Redacted.make('fixture'),
    cloneRoot: '/srv/repos',
    publicUrl: 'https://code.p.si14.space',
    landingUrl: 'https://sunday.example.com',
    environmentId: 'env',
    runtimeMode: 'approval-required',
  })
  const config = Layer.succeed(T3Config, {
    origin: 'http://localhost:3773',
    stateDirectory: '/tmp/unused',
  })
  return {
    commands,
    clones,
    replies,
    layer: Layer.mergeAll(discord, preparation, t3, auth, github, settings, config),
  }
})

it.effect(
  'starts independent T3 threads and worktrees for two mentions in the same Discord thread',
  () =>
    Effect.gen(function* () {
      const test = yield* fixture([task, task])
      yield* runBot.pipe(Effect.provide(test.layer), Effect.scoped)
      expect(yield* Ref.get(test.clones)).toEqual([])
      const commands = yield* Ref.get(test.commands)
      const turns = commands
      expect(turns).toHaveLength(2)
      expect(yield* Ref.get(test.replies)).toEqual(
        turns.map(
          (turn) =>
            `Started: ${task.title}\n[Open in app](https://sunday.example.com/app/env/accepted-${turn.threadId}) · [Open in web](https://code.p.si14.space/env/accepted-${turn.threadId})`,
        ),
      )
      expect(new Set(turns.map((command) => command.threadId)).size).toBe(2)
      for (const turn of turns) {
        expect(turn.modelSelection).toEqual({
          instanceId: 'configured-provider',
          model: 'configured-model',
          options: [{ id: 'reasoningEffort', value: 'medium' }],
        })
        expect(turn.projectId).toBe('existing-project')
        expect(turn.workspaceStrategy).toEqual({
          type: 'worktree',
          baseRef: 'HEAD',
          branch: `sunday/${turn.threadId}`,
          startFromOrigin: false,
        })
      }
      expect(turns.map((command) => command.initialMessage.text)).toEqual([
        task.prompt,
        task.prompt,
      ])
    }),
)

it.effect('asks for repository information without launching when the LLM rejects the target', () =>
  Effect.gen(function* () {
    const test = yield* fixture([
      { kind: 'reject', reason: 'I cannot identify the repository for this question.' },
    ])
    yield* runBot.pipe(Effect.provide(test.layer), Effect.scoped)
    expect(yield* Ref.get(test.commands)).toEqual([])
    expect(yield* Ref.get(test.replies)).toEqual([
      'I cannot identify the repository for this question.\nMention me again with a repository URL or T3 project name.',
    ])
  }),
)

it.effect('clones a missing repository through T3 and launches in its registered project', () =>
  Effect.gen(function* () {
    const test = yield* fixture([
      { ...task, target: { kind: 'repository', repository: 'owner/missing' } },
    ])
    yield* runBot.pipe(Effect.provide(test.layer), Effect.scoped)
    const clones = yield* Ref.get(test.clones)
    expect(clones).toHaveLength(1)
    expect(clones[0]).toMatchObject({
      destinationPath: '/srv/repos/owner/missing',
      repository: 'owner/missing',
    })
    const commands = yield* Ref.get(test.commands)
    expect(commands).toHaveLength(1)
    expect(commands[0]?.projectId).toBe(clones[0]?.projectId)
    expect(commands[0]?.workspaceStrategy).toEqual({
      type: 'worktree',
      baseRef: 'main',
      branch: `sunday/${commands[0]?.threadId}`,
      startFromOrigin: true,
    })
  }),
)

it.effect('does not start an agent when T3 reports that cloning failed', () =>
  Effect.gen(function* () {
    const test = yield* fixture(
      [{ ...task, target: { kind: 'repository', repository: 'owner/missing' } }],
      'failed',
    )
    yield* runBot.pipe(Effect.provide(test.layer), Effect.scoped)
    expect(yield* Ref.get(test.commands)).toEqual([])
    expect(yield* Ref.get(test.replies)).toEqual(['Repository clone did not finish: failed.'])
  }),
)

it.effect('rejects launch when T3 has no configured default model', () =>
  Effect.gen(function* () {
    const test = yield* fixture([task], 'done', null)
    yield* runBot.pipe(Effect.provide(test.layer), Effect.scoped)
    expect(yield* Ref.get(test.commands)).toEqual([])
    expect(yield* Ref.get(test.replies)).toEqual([
      'No default model is configured in T3. Set a project or environment default in T3, then mention me again.',
    ])
  }),
)
