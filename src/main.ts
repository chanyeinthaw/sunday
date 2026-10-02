/* oxlint-disable effecttsgo/unstable-api-usage */
import * as BunRuntime from '@effect/platform-bun/BunRuntime'
import * as BunServices from '@effect/platform-bun/BunServices'
import * as Console from 'effect/Console'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Redacted from 'effect/Redacted'
import * as Stdio from 'effect/Stdio'
import * as Stream from 'effect/Stream'
import * as Command from 'effect/cli/Command'
import * as CliError from 'effect/cli/CliError'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import packageJson from '../package.json'
import { appConfigLayer } from './app-config.ts'
import { fileLoggingLayer } from './logging.ts'
import { runBot } from './bot.ts'
import { discordLayer } from './discord.ts'
import { githubLayer } from './github.ts'
import { languageModelLayer, preparationLayer } from './preparation.ts'
import { settingsLayer } from './settings.ts'
import { authApiLayer } from './t3/auth-api.ts'
import { authLayer, T3Auth } from './t3/auth.ts'
import { clientLayer } from './t3/client.ts'
import { configLayer } from './t3/config.ts'
import { credentialStoreLayer } from './t3/credential-store.ts'

const authDependencies = Layer.mergeAll(authApiLayer, credentialStoreLayer).pipe(
  Layer.provide(configLayer),
  Layer.provide(FetchHttpClient.layer),
)
const auth = authLayer.pipe(Layer.provide(authDependencies), Layer.provide(configLayer))
const client = clientLayer.pipe(Layer.provide(auth), Layer.provide(configLayer))
const bot = Layer.mergeAll(
  client,
  auth,
  discordLayer.pipe(Layer.provide(settingsLayer)),
  githubLayer.pipe(Layer.provide(FetchHttpClient.layer)),
  preparationLayer.pipe(Layer.provide(languageModelLayer), Layer.provide(FetchHttpClient.layer)),
  settingsLayer,
  configLayer,
)

// Load configuration and logging only after the CLI accepts a command.
const configured = <A, E, R>(name: string, action: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    yield* Effect.logInfo('command.started').pipe(Effect.annotateLogs({ command: name }))
    const result = yield* action.pipe(
      Effect.tapError((error) => Effect.logError('command.failed', error)),
    )
    yield* Effect.logInfo('command.finished').pipe(Effect.annotateLogs({ command: name }))
    return result
  }).pipe(Effect.provide(fileLoggingLayer.pipe(Layer.provideMerge(appConfigLayer))), Effect.scoped)

const pair = Command.make('pair', {}, () =>
  configured(
    'pair',
    Effect.gen(function* () {
      const service = yield* T3Auth
      const stdio = yield* Stdio.Stdio
      const grant = (yield* stdio.stdin.pipe(Stream.decodeText, Stream.mkString)).trim()
      if (!grant)
        return yield* new CliError.UserError({
          cause: 'Missing pairing credential',
          userMessage: 'Pipe a T3 pairing code to stdin.',
        })
      yield* service.pair(Redacted.make(grant))
      yield* Console.log('T3 pairing saved.')
    }).pipe(Effect.provide(auth)),
  ),
).pipe(Command.withDescription('Exchange a T3 pairing code from stdin.'))

const run = Command.make('run', {}, () => configured('run', runBot.pipe(Effect.provide(bot)))).pipe(
  Command.withDescription('Run the Discord bot.'),
)

const cli = Command.make('sunday').pipe(
  Command.withDescription(
    'Start coding tasks in T3 from Discord mentions. Set SUNDAY_CONFIG to a JSON config path; the default is ./sunday.json.',
  ),
  Command.withSubcommands([pair, run]),
)

BunRuntime.runMain(
  Command.run(cli, { version: packageJson.version }).pipe(Effect.provide(BunServices.layer)),
)
