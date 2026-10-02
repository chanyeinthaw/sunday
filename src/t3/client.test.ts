/* oxlint-disable effecttsgo/unstable-api-usage */
import { expect, it } from '@effect/vitest'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Redacted from 'effect/Redacted'
import * as Schema from 'effect/Schema'
import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'
import { T3Auth } from './auth.ts'
import { T3Client, clientLayer } from './client.ts'
import { T3Config } from './config.ts'
import type { ModelDefaults } from './protocol.ts'

const isString = Schema.is(Schema.String)
const Frame = Schema.fromJsonString(
  Schema.Struct({
    _tag: Schema.String,
    id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Natural])),
    tag: Schema.optionalKey(Schema.String),
    payload: Schema.optionalKey(Schema.Json),
  }),
)
const decodeFrame = Schema.decodeUnknownSync(Frame)

it.live('uses T3 JSON RPC framing, fresh tickets, and T3-managed task bootstrap', () =>
  Effect.gen(function* () {
    const tickets: Array<string> = []
    const requests: Array<typeof Frame.Type> = []
    const environmentModel = {
      instanceId: 'codex',
      model: 'environment-model',
      options: [{ id: 'reasoningEffort', value: 'high' }],
    }
    const projectModel = {
      instanceId: 'claude',
      model: 'project-model',
      options: [{ id: 'effort', value: 'max' }],
    }
    let settings: typeof ModelDefaults.Type = {
      defaultModelSelection: environmentModel,
      projectSettingsOverrides: { p: { defaultModelSelection: projectModel } },
      projectSettingsFolded: true,
    }
    const server = createServer()
    const sockets = new WebSocketServer({ server })
    yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () =>
          new Promise<void>((resolve, reject) => {
            server.once('error', reject)
            server.listen(0, '127.0.0.1', resolve)
          }),
        catch: (error) => new Error('Fixture server failed', { cause: error }),
      }),
      () =>
        Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              for (const socket of sockets.clients) socket.terminate()
              sockets.close(() => server.close(() => resolve()))
            }),
        ),
    )
    const address = server.address()
    if (!address || isString(address)) throw new Error('Expected a bound fixture port')
    const origin = `http://127.0.0.1:${address.port}`
    sockets.on('connection', (socket, request) => {
      tickets.push(new URL(request.url ?? '/', origin).searchParams.get('wsTicket') ?? '')
      socket.on('message', (data) => {
        const text = Buffer.isBuffer(data)
          ? data.toString('utf8')
          : Array.isArray(data)
            ? Buffer.concat(data).toString('utf8')
            : Buffer.from(data).toString('utf8')
        const frame = decodeFrame(text)
        if (frame._tag === 'Ping') {
          socket.send(JSON.stringify({ _tag: 'Pong' }))
          return
        }
        if (frame._tag !== 'Request') return
        requests.push(frame)
        if (frame.tag === 'orchestration.subscribeShell') {
          socket.send(
            JSON.stringify({
              _tag: 'Chunk',
              requestId: frame.id,
              values: [
                {
                  kind: 'snapshot',
                  snapshot: {
                    snapshotSequence: 1,
                    projects: [{ id: 'p', title: 'repo', workspaceRoot: '/srv/repo' }],
                  },
                },
              ],
            }),
          )
        } else {
          const value =
            frame.tag === 'server.getSettings'
              ? settings
              : frame.tag === 'projectClone.start'
                ? { projectId: 'cloned', cwd: '/server/cloned' }
                : { sequence: 2 }
          socket.send(
            JSON.stringify({ _tag: 'Exit', requestId: frame.id, exit: { _tag: 'Success', value } }),
          )
        }
      })
    })
    let ticketCounter = 0
    const auth = Layer.succeed(
      T3Auth,
      T3Auth.of({
        pair: () => Effect.void,
        credential: () => Effect.die('Unused fixture operation'),
        ticket: Effect.fn('Fixture.ticket')(() =>
          Effect.sync(() => {
            ticketCounter += 1
            return {
              ticket: Redacted.make(`ticket-${ticketCounter}`),
              expiresAt: DateTime.makeUnsafe(Date.now() + 60000),
            }
          }),
        ),
      }),
    )
    const config = Layer.succeed(T3Config, { origin, stateDirectory: '/tmp/unused' })
    yield* Effect.gen(function* () {
      const client = yield* T3Client
      expect(yield* client.projects()).toEqual([
        { id: 'p', title: 'repo', workspaceRoot: '/srv/repo' },
      ])
      const command = {
        type: 'thread.turn.start',
        commandId: 'c',
        threadId: 'task',
        message: { messageId: 'm', role: 'user', text: 'Fix the bug', attachments: [] },
        modelSelection: { instanceId: 'codex', model: 'gpt-6-luna' },
        runtimeMode: 'approval-required',
        interactionMode: 'default',
        createdAt: new Date().toISOString(),
        bootstrap: {
          createThread: {
            projectId: 'p',
            title: 'Fix the bug',
            modelSelection: { instanceId: 'codex', model: 'gpt-6-luna' },
            runtimeMode: 'approval-required',
            interactionMode: 'default',
            branch: null,
            worktreePath: null,
            createdAt: new Date().toISOString(),
          },
          prepareWorktree: {
            projectCwd: '/srv/repo',
            baseBranch: 'main',
            startFromOrigin: true,
            requireWorktree: true,
          },
          runSetupScript: true,
        },
      } satisfies import('./protocol.ts').Command
      expect(yield* client.dispatch(command)).toBe(2)
      const cloneRequest = {
        projectId: 'cloned',
        title: 'owner/repo',
        repository: 'owner/repo',
        provider: 'github',
        destinationPath: '/srv/repos/owner/repo',
        createdAt: new Date().toISOString(),
      } satisfies Parameters<typeof client.clone>[0]
      expect(yield* client.clone(cloneRequest)).toEqual({
        projectId: 'cloned',
        cwd: '/server/cloned',
      })
      expect(tickets).toEqual(['ticket-1', 'ticket-2', 'ticket-3'])
      expect(requests[2]?.tag).toBe('projectClone.start')
      expect(requests[2]?.payload).toEqual(cloneRequest)
      expect(requests[1]?.tag).toBe('orchestration.dispatchCommand')
      expect(requests[1]?.payload).toEqual(command)
      const project = {
        id: 'p',
        title: 'repo',
        workspaceRoot: '/srv/repo',
        defaultModelSelection: projectModel,
      }
      expect(yield* client.defaultModel(project)).toEqual(projectModel)
      settings = { ...settings, projectSettingsOverrides: {} }
      expect(yield* client.defaultModel(project)).toEqual(environmentModel)
      settings = { ...settings, projectSettingsFolded: false }
      expect(yield* client.defaultModel(project)).toEqual(projectModel)
      settings = { ...settings, projectSettingsOverrides: { p: { defaultModelSelection: null } } }
      expect(yield* client.defaultModel(project)).toBeNull()
      settings = { defaultModelSelection: null, projectSettingsFolded: true }
      expect(yield* client.defaultModel(project)).toBeNull()
    }).pipe(Effect.provide(clientLayer.pipe(Layer.provide(auth), Layer.provide(config))))
  }),
)
