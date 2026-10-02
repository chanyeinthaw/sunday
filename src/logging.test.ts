import { expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Redacted from 'effect/Redacted'
import * as Schema from 'effect/Schema'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppConfig, Configuration } from './app-config.ts'
import { fileLoggingLayer } from './logging.ts'

const decodeConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(Configuration))
const decodeEntry = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      message: Schema.Json,
      level: Schema.String,
      annotations: Schema.Record(Schema.String, Schema.Json),
    }),
  ),
)

it.effect('appends JSON logs, filters levels, redacts secrets, and flushes on shutdown', () =>
  Effect.gen(function* () {
    const directory = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), 'sunday-logs-'))),
      (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
    )
    const json = yield* Effect.promise(() =>
      readFile(new URL('../sunday.example.json', import.meta.url), 'utf8'),
    )
    const example = yield* decodeConfig(json)
    const file = join(directory, 'logs', 'app.jsonl')
    const config = Layer.succeed(AppConfig, { ...example, logging: { file, level: 'Info' } })
    const logging = fileLoggingLayer.pipe(Layer.provide(config))
    yield* Effect.gen(function* () {
      yield* Effect.logDebug('filtered-debug')
      yield* Effect.logInfo('task.started').pipe(Effect.annotateLogs({ threadId: 'thread-1' }))
      yield* Effect.logInfo('credential', Redacted.make('never-log-this-secret'))
    }).pipe(Effect.provide(logging), Effect.scoped)
    yield* Effect.logInfo('task.finished').pipe(Effect.provide(logging), Effect.scoped)
    const content = yield* Effect.promise(() => readFile(file, 'utf8'))
    const entries = yield* Effect.forEach(content.trim().split('\n'), (line) => decodeEntry(line))
    expect(entries).toHaveLength(3)
    expect(entries[0]).toMatchObject({
      message: 'task.started',
      annotations: { threadId: 'thread-1' },
    })
    expect(entries[2]).toMatchObject({ message: 'task.finished' })
    expect(content).not.toContain('filtered-debug')
    expect(content).not.toContain('never-log-this-secret')
    expect((yield* Effect.promise(() => stat(file))).mode & 0o777).toBe(0o600)
  }),
)
