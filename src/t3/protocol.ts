// Minimal contract adapter for T3 nightly e01f72d1; private T3 packages are not dependencies.
/* oxlint-disable effecttsgo/unstable-api-usage */
import * as Schema from 'effect/Schema'
import * as Rpc from 'effect/rpc/Rpc'
import * as RpcGroup from 'effect/rpc/RpcGroup'

export const orchestrationProtocolVersion = '2'

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
export const ThreadLaunch = Schema.Struct({
  commandId: Id,
  threadId: Id,
  projectId: Id,
  title: Id,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: InteractionMode,
  workspaceStrategy: Schema.Struct({
    type: Schema.Literal('worktree'),
    baseRef: Id,
    branch: Id,
    startFromOrigin: Schema.Boolean,
  }),
  initialMessage: Schema.Struct({
    messageId: Id,
    text: Schema.String,
    attachments: Schema.Array(Schema.Never),
  }),
})
export type ThreadLaunch = typeof ThreadLaunch.Type

export const Project = Schema.Struct({
  id: Id,
  title: Id,
  workspaceRoot: Id,
  defaultModelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
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
      'project.updated',
      'project.removed',
      'thread.updated',
      'thread.removed',
    ]),
  }),
])
export const ModelDefaults = Schema.Struct({
  defaultModelSelection: Schema.NullOr(ModelSelection),
  projectSettingsOverrides: Schema.optionalKey(
    Schema.Record(
      Id,
      Schema.Struct({
        defaultModelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
      }),
    ),
  ),
  projectSettingsFolded: Schema.optionalKey(Schema.Boolean),
})
export const group = RpcGroup.make(
  Rpc.make('server.getSettings', {
    payload: Schema.Struct({}),
    success: ModelDefaults,
    error: Schema.Json,
  }),
  Rpc.make('orchestration.launchThread', {
    payload: ThreadLaunch,
    success: Schema.Struct({ threadId: Id, resumed: Schema.Boolean }),
    error: Schema.Json,
  }),
  Rpc.make('orchestration.subscribeShell', {
    payload: Schema.Struct({}),
    success: ShellItem,
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
