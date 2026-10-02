/* oxlint-disable effecttsgo/unstable-api-usage */
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Redacted from 'effect/Redacted'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import * as Socket from 'effect/socket/Socket'
import * as RpcClient from 'effect/rpc/RpcClient'
import * as RpcSerialization from 'effect/rpc/RpcSerialization'
import { T3Auth } from './auth.ts'
import { T3Config } from './config.ts'
import { AuthError, CredentialError } from './auth-model.ts'
import { Command, Project, ThreadSnapshot, group } from './protocol.ts'

export class T3Error extends Schema.TaggedError<T3Error>()('T3Error', {
  operation: Schema.String,
}) {}
type Failure = T3Error | AuthError | CredentialError
interface CloneRequest {
  readonly projectId: string
  readonly title: string
  readonly createdAt: string
  readonly destinationPath: string
  readonly provider: 'github'
  readonly repository: string
}
interface ClientMethods {
  readonly projects: () => Effect.Effect<ReadonlyArray<Project>, Failure>
  readonly dispatch: (command: Command) => Effect.Effect<number, Failure>
  readonly clone: (
    request: CloneRequest,
  ) => Effect.Effect<{ readonly projectId: string; readonly cwd: string }, Failure>
  readonly clonePhase: (projectId: string) => Effect.Effect<string, Failure>
  readonly thread: (threadId: string) => Effect.Effect<typeof ThreadSnapshot.Type, Failure>
}
export class T3Client extends Context.Service<T3Client, ClientMethods>()('sunday/T3Client') {}

export const clientLayer = Layer.effect(
  T3Client,
  Effect.gen(function* () {
    const auth = yield* T3Auth
    const config = yield* T3Config
    // Each connection obtains a fresh ticket; mutating calls are never replayed on disconnect.
    const connect = Effect.fn('T3Client.connect')(function* () {
      const ticket = yield* auth.ticket()
      const url = new URL('/ws', config.origin)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      url.searchParams.set('wsTicket', Redacted.value(ticket.ticket))
      const socketLayer = Socket.layerWebSocket(url.href).pipe(
        Layer.provide(Socket.layerWebSocketConstructorGlobal),
      )
      const protocolLayer = RpcClient.layerProtocolSocket({ retryTransientErrors: false }).pipe(
        Layer.provide(socketLayer),
        Layer.provide(RpcSerialization.layerJson),
      )
      const protocol = yield* Layer.build(protocolLayer)
      return yield* RpcClient.make(group, { disableTracing: true }).pipe(Effect.provide(protocol))
    })
    const projects = Effect.fn('T3Client.projects')(
      function* () {
        const client = yield* connect()
        const result = yield* client['orchestration.subscribeShell']({}).pipe(
          Stream.filter((item) => item.kind === 'snapshot'),
          Stream.runHead,
          Effect.mapError(() => new T3Error({ operation: 'projects' })),
        )
        if (Option.isNone(result) || result.value.kind !== 'snapshot')
          return yield* new T3Error({ operation: 'projects' })
        return result.value.snapshot.projects
      },
      Effect.scoped,
      Effect.timeout('30 seconds'),
      Effect.mapError(() => new T3Error({ operation: 'projects' })),
    )
    const dispatch = Effect.fn('T3Client.dispatch')(
      function* (command: Command) {
        const client = yield* connect()
        const result = yield* client['orchestration.dispatchCommand'](command).pipe(
          Effect.mapError(() => new T3Error({ operation: 'dispatch' })),
        )
        return result.sequence
      },
      Effect.scoped,
      Effect.timeout('10 minutes'),
      Effect.mapError(() => new T3Error({ operation: 'dispatch' })),
    )
    const clone = Effect.fn('T3Client.clone')(
      function* (request: CloneRequest) {
        const client = yield* connect()
        return yield* client['projectClone.start'](request).pipe(
          Effect.mapError(() => new T3Error({ operation: 'clone' })),
        )
      },
      Effect.scoped,
      Effect.timeout('30 seconds'),
      Effect.mapError(() => new T3Error({ operation: 'clone' })),
    )
    const clonePhase = Effect.fn('T3Client.clonePhase')(
      function* (projectId: string) {
        const client = yield* connect()
        const result = yield* client.subscribeProjectClones({}).pipe(
          Stream.runHead,
          Effect.mapError(() => new T3Error({ operation: 'clonePhase' })),
        )
        if (Option.isNone(result)) return yield* new T3Error({ operation: 'clonePhase' })
        return (
          result.value.find((trackedClone) => trackedClone.projectId === projectId)?.phase ??
          'unknown'
        )
      },
      Effect.scoped,
      Effect.timeout('30 seconds'),
      Effect.mapError(() => new T3Error({ operation: 'clonePhase' })),
    )
    const thread = Effect.fn('T3Client.thread')(
      function* (threadId: string) {
        const client = yield* connect()
        const result = yield* client['orchestration.subscribeThread']({ threadId }).pipe(
          Stream.filter((item) => item.kind === 'snapshot'),
          Stream.runHead,
          Effect.mapError(() => new T3Error({ operation: 'thread' })),
        )
        if (Option.isNone(result) || result.value.kind !== 'snapshot')
          return yield* new T3Error({ operation: 'thread' })
        return result.value.snapshot
      },
      Effect.scoped,
      Effect.timeout('30 seconds'),
      Effect.mapError(() => new T3Error({ operation: 'thread' })),
    )
    return T3Client.of({ projects, dispatch, clone, clonePhase, thread })
  }),
)
