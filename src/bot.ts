import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Ref from 'effect/Ref'
import * as Schedule from 'effect/Schedule'
import * as Schema from 'effect/Schema'
import * as Semaphore from 'effect/Semaphore'
import * as Stream from 'effect/Stream'
import { Discord, type DiscordMention } from './discord.ts'
import { GitHub, type RepositoryInfo } from './github.ts'
import { Preparation, type PreparedTask } from './preparation.ts'
import { Settings, pathWithin } from './settings.ts'
import { T3Client } from './t3/client.ts'
import { T3Auth } from './t3/auth.ts'
import type { Project } from './t3/protocol.ts'

export class BotError extends Schema.TaggedError<BotError>()('BotError', {
  message: Schema.String,
}) {}

export function matchesRepository(project: Project, repository: string): boolean {
  const remote = project.repositoryIdentity?.locator.remoteUrl
  if (remote) {
    const match =
      /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)\/?$/u.exec(
        remote.replace(/\.git$/u, ''),
      )
    return match?.[1]?.toLowerCase() === repository.toLowerCase()
  }
  return false
}

export const runBot = Effect.gen(function* () {
  const discord = yield* Discord
  const t3 = yield* T3Client
  const auth = yield* T3Auth
  const github = yield* GitHub
  const preparation = yield* Preparation
  const settings = yield* Settings
  const seen = yield* Ref.make<ReadonlyArray<string>>([])
  const launchLock = yield* Semaphore.make(1)
  const modelSelection = {
    instanceId: settings.providerInstanceId,
    model: settings.codingModel,
    options: [{ id: 'reasoningEffort', value: settings.codingReasoningEffort }],
  }
  const threadLink = (threadId: string) =>
    `${settings.publicUrl}/${encodeURIComponent(settings.environmentId)}/${encodeURIComponent(threadId)}`

  const resolveProject = Effect.fn('Bot.resolveProject')(function* (repository: RepositoryInfo) {
    const projects = yield* t3.projects()
    const matching = projects.filter((project) => matchesRepository(project, repository.full_name))
    if (matching.length > 1)
      return yield* new BotError({
        message:
          'Multiple T3 projects match this repository; mention me again with a T3 project name.',
      })
    if (matching[0]) {
      yield* Effect.logDebug('project.reused').pipe(
        Effect.annotateLogs({ projectId: matching[0].id }),
      )
      return matching[0]
    }
    const projectId = crypto.randomUUID()
    yield* Effect.logInfo('repository.clone_started').pipe(
      Effect.annotateLogs({ projectId, repository: repository.full_name }),
    )
    const clone = yield* t3.clone({
      projectId,
      title: repository.full_name,
      createdAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
      destinationPath: pathWithin(settings.cloneRoot, repository.full_name.toLowerCase()),
      provider: 'github',
      repository: repository.full_name,
    })
    const phase = yield* t3.clonePhase(projectId).pipe(
      Effect.repeat({
        schedule: Schedule.spaced('2 seconds'),
        while: (currentPhase) => currentPhase === 'running',
      }),
      Effect.timeout('10 minutes'),
      Effect.mapError(
        () => new BotError({ message: 'Clone status is uncertain; inspect T3 before retrying.' }),
      ),
    )
    if (phase !== 'done')
      return yield* new BotError({ message: `Repository clone did not finish: ${phase}.` })
    yield* Effect.logInfo('repository.clone_finished').pipe(Effect.annotateLogs({ projectId }))
    return { id: clone.projectId, title: repository.full_name, workspaceRoot: clone.cwd }
  })

  const resolveTarget = Effect.fn('Bot.resolveTarget')(function* (
    task: Extract<PreparedTask, { readonly kind: 'launch' }>,
    projects: ReadonlyArray<Project>,
  ) {
    if (task.target.kind === 'project') {
      const projectId = task.target.projectId
      const project = projects.find((item) => item.id === projectId)
      if (!project)
        return yield* new BotError({
          message:
            'The selected T3 project is unknown. Mention me again with a repository URL or project name.',
        })
      return { project, baseBranch: 'HEAD', metadata: '' }
    }
    const repository = yield* github.repository(task.target.repository)
    const project = yield* resolveProject(repository)
    return {
      project,
      baseBranch: repository.default_branch,
      metadata: `\n\nVerified repository metadata:\n${JSON.stringify(repository)}`,
    }
  })

  const handle = Effect.fn('Bot.handle')(function* (message: DiscordMention) {
    const firstDelivery = yield* Ref.modify(seen, (ids) =>
      ids.includes(message.id) ? [false, ids] : [true, [...ids.slice(-999), message.id]],
    )
    if (!firstDelivery) {
      yield* Effect.logDebug('mention.duplicate').pipe(Effect.annotateLogs({ eventId: message.id }))
      return
    }
    yield* Effect.logInfo('task.received').pipe(
      Effect.annotateLogs({
        eventId: message.id,
        guildId: message.guildId,
        channelId: message.channelId,
        userId: message.userId,
      }),
    )
    const context = yield* discord.context(message)
    const projects = yield* t3.projects()
    const task = yield* preparation.prepare(message.content, context, projects)
    if (task.kind === 'reject') {
      yield* Effect.logWarning('task.rejected').pipe(Effect.annotateLogs({ eventId: message.id }))
      yield* discord.reply(
        message,
        `${task.reason}\nMention me again with a repository URL or T3 project name.`,
      )
      return
    }
    yield* Effect.logInfo('task.prepared').pipe(
      Effect.annotateLogs({ eventId: message.id, targetKind: task.target.kind }),
    )
    const channelId = message.channelId
    const threadId = crypto.randomUUID()
    const messageId = crypto.randomUUID()
    yield* launchLock.withPermit(
      Effect.gen(function* () {
        const target = yield* resolveTarget(task, projects)
        const createdAt = new Date(yield* Clock.currentTimeMillis).toISOString()
        yield* t3.dispatch({
          type: 'thread.turn.start',
          commandId: crypto.randomUUID(),
          threadId,
          message: {
            messageId,
            role: 'user',
            text: task.prompt + target.metadata,
            attachments: [],
          },
          modelSelection,
          runtimeMode: settings.runtimeMode,
          interactionMode: 'default',
          bootstrap: {
            createThread: {
              projectId: target.project.id,
              title: task.title,
              modelSelection,
              runtimeMode: settings.runtimeMode,
              interactionMode: 'default',
              branch: null,
              worktreePath: null,
              createdAt,
            },
            prepareWorktree: {
              projectCwd: target.project.workspaceRoot,
              baseBranch: target.baseBranch,
              branch: `sunday/${threadId}`,
              startFromOrigin: task.target.kind === 'repository',
              requireWorktree: true,
            },
            runSetupScript: true,
          },
          createdAt,
        })
      }),
    )
    yield* Effect.logInfo('task.started').pipe(
      Effect.annotateLogs({ eventId: message.id, threadId, channelId }),
    )
    const appLink = `${settings.landingUrl}/app/${encodeURIComponent(settings.environmentId)}/${encodeURIComponent(threadId)}`
    yield* discord.reply(
      message,
      `Started: ${task.title}\n[Open in app](${appLink}) · [Open in web](${threadLink(threadId)})`,
    )
  })

  yield* auth.credential()
  yield* auth.credential().pipe(
    Effect.repeat(Schedule.spaced('1 hour')),
    Effect.tapError((error) => Effect.logError('auth.renewal_failed', error)),
    Effect.forkScoped,
  )
  yield* Effect.logInfo('Discord bot connected')
  yield* discord.mentions.pipe(
    Stream.mapEffect(
      (message) =>
        handle(message).pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              yield* Effect.logError('task.failed', error).pipe(
                Effect.annotateLogs({ eventId: message.id, channelId: message.channelId }),
              )
              yield* discord.reply(
                message,
                error instanceof BotError
                  ? error.message
                  : `Task failed (${error._tag}). Check T3 before retrying.`,
              )
            }),
          ),
        ),
      { concurrency: 4 },
    ),
    Stream.runDrain,
  )
})
