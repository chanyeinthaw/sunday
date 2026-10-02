import { expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Redacted from 'effect/Redacted'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CredentialStore, credentialStoreLayer } from './credential-store.ts'
import { T3Config } from './config.ts'
import { requiredScopes } from './auth-model.ts'

const fixture = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), 'sunday-test-'))),
  (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
)

it.effect('stores owner-only credentials and rejects a changed server', () =>
  Effect.gen(function* () {
    const directory = yield* fixture
    const config = Layer.succeed(T3Config, {
      origin: 'http://localhost:3773',
      stateDirectory: directory,
    })
    yield* Effect.gen(function* () {
      const store = yield* CredentialStore
      expect(Option.isNone(yield* store.load())).toBe(true)
      yield* store.save({
        version: 1,
        origin: 'http://localhost:3773',
        accessToken: Redacted.make('stored-secret'),
        expiresAt: 1800000000000,
        renewAt: 1799990000000,
        scope: requiredScopes.join(' '),
      })
      expect(
        (yield* Effect.promise(() => stat(join(directory, 'credential.json')))).mode & 0o777,
      ).toBe(0o600)
      expect(Redacted.value(Option.getOrThrow(yield* store.load()).accessToken)).toBe(
        'stored-secret',
      )
      const content = yield* Effect.promise(() =>
        readFile(join(directory, 'credential.json'), 'utf8'),
      )
      yield* Effect.promise(() =>
        writeFile(
          join(directory, 'credential.json'),
          content.replace('localhost:3773', 'localhost:3774'),
        ),
      )
      expect(yield* store.load().pipe(Effect.flip)).toMatchObject({ reason: 'wrong-server' })
    }).pipe(Effect.provide(credentialStoreLayer.pipe(Layer.provide(config))))
  }),
)

it.effect(
  'rejects public permissions and corrupt credential files without exposing their contents',
  () =>
    Effect.gen(function* () {
      const directory = yield* fixture
      const path = join(directory, 'credential.json')
      yield* Effect.promise(() => writeFile(path, 'private-malformed-secret', { mode: 0o644 }))
      const config = Layer.succeed(T3Config, {
        origin: 'http://localhost:3773',
        stateDirectory: directory,
      })
      yield* Effect.gen(function* () {
        const store = yield* CredentialStore
        expect(yield* store.load().pipe(Effect.flip)).toMatchObject({
          reason: 'unsafe-permissions',
        })
        yield* Effect.promise(() => chmod(path, 0o600))
        const failure = yield* store.load().pipe(Effect.flip)
        expect(failure).toMatchObject({ reason: 'invalid-data' })
        expect(JSON.stringify(failure)).not.toContain('private-malformed-secret')
      }).pipe(Effect.provide(credentialStoreLayer.pipe(Layer.provide(config))))
    }),
)
