// Minimal contract adapter for upstream 5cc99e1; private T3 packages are not dependencies.
/* oxlint-disable effecttsgo/unstable-api-usage */
import * as Schema from 'effect/Schema'
import * as Rpc from 'effect/rpc/Rpc'
import * as RpcGroup from 'effect/rpc/RpcGroup'

const Id = Schema.NonEmptyString
export const ModelSelection = Schema.Struct({
  instanceId: Id,
  model: Id,
  options: Schema.optionalKey(
    Schema.Array(Schema.Struct({ id: Id, value: Schema.Union([Id, Schema.Boolean]) })),
  ),
})
const RuntimeMode = Schema.Literals([
  'approval-required',
  'auto-accept-edits',
  'auto',
  'full-access',
])
const InteractionMode = Schema.Literals(['default', 'plan'])
const TurnStart = Schema.Struct({
  type: Schema.Literal('thread.turn.start'),
  commandId: Id,
  threadId: Id,
  message: Schema.Struct({
    messageId: Id,
    role: Schema.Literal('user'),
    text: Schema.String,
    attachments: Schema.Array(Schema.Never),
  }),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: InteractionMode,
  bootstrap: Schema.optionalKey(
    Schema.Struct({
      createThread: Schema.Struct({
        projectId: Id,
        title: Id,
        modelSelection: ModelSelection,
        runtimeMode: RuntimeMode,
        interactionMode: InteractionMode,
        branch: Schema.NullOr(Id),
        worktreePath: Schema.NullOr(Id),
        createdAt: Id,
      }),
      prepareWorktree: Schema.Struct({
        projectCwd: Id,
        baseBranch: Id,
        branch: Schema.optionalKey(Id),
        startFromOrigin: Schema.Boolean,
        requireWorktree: Schema.Boolean,
      }),
      runSetupScript: Schema.Boolean,
    }),
  ),
  createdAt: Id,
})
export const Command = TurnStart
export type Command = typeof Command.Type

export const Project = Schema.Struct({
  id: Id,
  title: Id,
  workspaceRoot: Id,
  repositoryIdentity: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ locator: Schema.Struct({ remoteUrl: Id }) })),
  ),
})
export interface Project extends Schema.Schema.Type<typeof Project> {}
export const ShellSnapshot = Schema.Struct({
  snapshotSequence: Schema.Natural,
  projects: Schema.Array(Project),
})
export const ShellItem = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('snapshot'), snapshot: ShellSnapshot }),
  Schema.Struct({ kind: Schema.Literal('synchronized') }),
  Schema.Struct({
    kind: Schema.Literals([
      'project-upserted',
      'project-removed',
      'thread-upserted',
      'thread-removed',
    ]),
  }),
])
export const ThreadSnapshot = Schema.Struct({
  snapshotSequence: Schema.Natural,
  thread: Schema.Struct({
    id: Id,
    latestTurn: Schema.NullOr(
      Schema.Struct({
        state: Schema.Literals(['running', 'completed', 'interrupted', 'error']),
        turnId: Id,
        requestedAt: Id,
      }),
    ),
    session: Schema.NullOr(Schema.Struct({ status: Id, lastError: Schema.NullOr(Schema.String) })),
    messages: Schema.Array(
      Schema.Struct({
        id: Id,
        role: Id,
        text: Schema.String,
        turnId: Schema.NullOr(Id),
        createdAt: Id,
      }),
    ),
    activities: Schema.Array(
      Schema.Struct({ id: Id, tone: Id, summary: Schema.String, turnId: Schema.NullOr(Id) }),
    ),
  }),
})
export const ThreadItem = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('snapshot'), snapshot: ThreadSnapshot }),
  Schema.Struct({ kind: Schema.Literals(['event', 'synchronized']) }),
])
export const group = RpcGroup.make(
  Rpc.make('orchestration.dispatchCommand', {
    payload: Command,
    success: Schema.Struct({ sequence: Schema.Natural }),
    error: Schema.Json,
  }),
  Rpc.make('orchestration.subscribeShell', {
    payload: Schema.Struct({}),
    success: ShellItem,
    error: Schema.Json,
    stream: true,
  }),
  Rpc.make('orchestration.subscribeThread', {
    payload: Schema.Struct({ threadId: Id }),
    success: ThreadItem,
    error: Schema.Json,
    stream: true,
  }),
  Rpc.make('projectClone.start', {
    payload: Schema.Struct({
      projectId: Id,
      title: Id,
      createdAt: Id,
      destinationPath: Id,
      provider: Schema.Literal('github'),
      repository: Id,
    }),
    success: Schema.Struct({ projectId: Id, cwd: Id }),
    error: Schema.Json,
  }),
  Rpc.make('subscribeProjectClones', {
    payload: Schema.Struct({}),
    success: Schema.Array(Schema.Struct({ projectId: Id, phase: Id })),
    error: Schema.Json,
    stream: true,
  }),
)
