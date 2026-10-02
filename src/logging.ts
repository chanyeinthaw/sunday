import * as BunFileSystem from '@effect/platform-bun/BunFileSystem'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Logger from 'effect/Logger'
import * as References from 'effect/References'
import { dirname } from 'node:path'
import { AppConfig } from './app-config.ts'

export const fileLoggingLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* AppConfig
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(dirname(config.logging.file), { recursive: true, mode: 0o700 })
    return Layer.mergeAll(
      Logger.layer(
        [
          Logger.toFile(Logger.formatJson, config.logging.file, {
            flag: 'a',
            mode: 0o600,
            batchWindow: '1 second',
          }),
        ],
        { mergeWithExisting: true },
      ),
      Layer.succeed(References.MinimumLogLevel, config.logging.level),
    )
  }),
).pipe(Layer.provide(BunFileSystem.layer))
