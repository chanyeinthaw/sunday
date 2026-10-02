import * as Config from 'effect/Config'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

export const AbsolutePath = Schema.String.check(Schema.makeFilter(isAbsolute))
export const ServerOrigin = Schema.String.check(
  Schema.makeFilter((value) => {
    try {
      const url = new URL(value)
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      return (
        (url.protocol === 'https:' || (url.protocol === 'http:' && local)) &&
        url.username === '' &&
        url.password === '' &&
        url.pathname === '/' &&
        url.search === '' &&
        url.hash === ''
      )
    } catch {
      return false
    }
  }),
)
const EnvReference = Schema.Struct({
  env: Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/u)),
})
export interface EnvReference extends Schema.Schema.Type<typeof EnvReference> {}
const Snowflake = Schema.String.check(Schema.isPattern(/^\d{17,20}$/u))
export const GuildRule = Schema.Struct({
  id: Snowflake,
  userIds: Schema.Array(Snowflake).check(Schema.isMinLength(1)),
})
export interface GuildRule extends Schema.Schema.Type<typeof GuildRule> {}

export const Configuration = Schema.Struct({
  discord: Schema.Struct({
    token: EnvReference,
    guilds: Schema.Array(GuildRule).check(Schema.isMinLength(1)),
    contextMessages: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  }),
  t3: Schema.Struct({
    serverUrl: ServerOrigin,
    stateDirectory: AbsolutePath,
    environmentId: Schema.NonEmptyString,
    providerInstanceId: Schema.NonEmptyString,
    cloneRoot: AbsolutePath,
    model: Schema.NonEmptyString,
    reasoningEffort: Schema.Literals(['low', 'medium', 'high', 'xhigh']),
    runtimeMode: Schema.Literals(['approval-required', 'auto-accept-edits', 'auto', 'full-access']),
  }),
  llm: Schema.Struct({
    apiUrl: Schema.NonEmptyString,
    apiKey: EnvReference,
    model: Schema.NonEmptyString,
    reasoningEffort: Schema.Literals(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
  }),
  github: Schema.Struct({ token: Schema.NullOr(EnvReference) }),
  logging: Schema.Struct({
    file: AbsolutePath,
    level: Schema.Literals(['Debug', 'Info', 'Warn', 'Error']),
  }),
})
export interface Configuration extends Schema.Schema.Type<typeof Configuration> {}
export class AppConfig extends Context.Service<AppConfig, Configuration>()('sunday/AppConfig') {}
export class ConfigurationError extends Schema.TaggedError<ConfigurationError>()(
  'ConfigurationError',
  {
    reason: Schema.Literals(['read-file', 'invalid-config', 'missing-secret']),
    location: Schema.String,
  },
) {}
const decodeConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(Configuration))
const Secret = Schema.RedactedFromValue(Schema.NonEmptyString)

export const readSecret = Effect.fn('Configuration.readSecret')(function* (
  reference: EnvReference,
) {
  return yield* Config.schema(Secret, reference.env).pipe(
    Effect.mapError(
      () => new ConfigurationError({ reason: 'missing-secret', location: reference.env }),
    ),
  )
})
export const appConfigLayer = Layer.effect(
  AppConfig,
  Effect.gen(function* () {
    const file = yield* Config.String('SUNDAY_CONFIG').pipe(Config.withDefault('sunday.json'))
    const content = yield* Effect.tryPromise({
      try: () => readFile(file, 'utf8'),
      catch: () => new ConfigurationError({ reason: 'read-file', location: file }),
    })
    const config = yield* decodeConfig(content, { onExcessProperty: 'error' }).pipe(
      Effect.mapError(() => new ConfigurationError({ reason: 'invalid-config', location: file })),
    )
    return AppConfig.of(config)
  }),
)
