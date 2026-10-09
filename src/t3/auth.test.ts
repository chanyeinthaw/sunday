import { describe, expect, it } from '@effect/vitest'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Redacted from 'effect/Redacted'
import * as Ref from 'effect/Ref'
import * as TestClock from 'effect/testing/TestClock'
import { AuthApi } from './auth-api.ts'
import {
  AuthError,
  Credential,
  CredentialError,
  requiredScopes,
  pairingScopes,
} from './auth-model.ts'
import { T3Auth, authLayer } from './auth.ts'
import { T3Config } from './config.ts'
import { CredentialStore } from './credential-store.ts'

const now = 1_800_000_000_000
const initial: Credential = {
  version: 1,
  origin: 'http://localhost:3773',
  accessToken: Redacted.make('old-secret'),
  expiresAt: now + 60000,
  renewAt: now - 1,
  scope: [...requiredScopes, 'access:write'].join(' '),
}
const token = {
  access_token: Redacted.make('new-secret'),
  issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
  token_type: 'Bearer',
  expires_in: 172800,
  scope: [...requiredScopes, 'access:write'].join(' '),
}

const setup = Effect.gen(function* () {
  yield* TestClock.setTime(now)
  const saved = yield* Ref.make<Option.Option<Credential>>(Option.some(initial))
  const rotations = yield* Ref.make(0)
  const renewalRequests = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([])
  const rejectSave = yield* Ref.make(false)
  const api = Layer.succeed(
    AuthApi,
    AuthApi.of({
      exchange: Effect.fn('Test.exchange')((_, scopes) =>
        Effect.succeed({
          ...token,
          scope: scopes?.join(' ') ?? token.scope,
          issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
          token_type: 'Bearer',
        }),
      ),
      pairing: Effect.fn('Test.pairing')(function* (_, scopes) {
        yield* Ref.update(renewalRequests, (requests) => [...requests, scopes ?? []])
        yield* Ref.update(rotations, (count) => count + 1)
        return {
          credential: Redacted.make('grant-secret'),
          expiresAt: DateTime.makeUnsafe(now + 60000),
        }
      }),
      ticket: Effect.fn('Test.ticket')(() =>
        Effect.succeed({
          ticket: Redacted.make('ticket-secret'),
          expiresAt: DateTime.makeUnsafe(now + 60000),
        }),
      ),
    }),
  )
  const store = Layer.succeed(
    CredentialStore,
    CredentialStore.of({
      load: Effect.fn('Test.load')(function* () {
        return yield* Ref.get(saved)
      }),
      save: Effect.fn('Test.save')(function* (credential) {
        if (yield* Ref.get(rejectSave))
          return yield* new CredentialError({ operation: 'save', reason: 'io' })
        yield* Ref.set(saved, Option.some(credential))
      }),
    }),
  )
  const config = Layer.succeed(T3Config, { origin: initial.origin, stateDirectory: '/tmp/unused' })
  return {
    saved,
    rotations,
    renewalRequests,
    rejectSave,
    layer: authLayer.pipe(Layer.provide(api), Layer.provide(store), Layer.provide(config)),
  }
})

describe('T3 credential rotation', () => {
  it.effect('renews concurrent callers once and saves before returning the replacement', () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      yield* Effect.gen(function* () {
        const auth = yield* T3Auth
        const credentials = yield* Effect.all(
          [auth.credential(), auth.credential(), auth.credential()],
          { concurrency: 'unbounded' },
        )
        expect(credentials.map((credential) => Redacted.value(credential.accessToken))).toEqual([
          'new-secret',
          'new-secret',
          'new-secret',
        ])
        expect(yield* Ref.get(fixture.rotations)).toBe(1)
        expect(yield* Ref.get(fixture.renewalRequests)).toEqual([
          [...requiredScopes, 'access:write'],
        ])
        expect(Option.getOrThrow(yield* Ref.get(fixture.saved))).toEqual(credentials[0])
      }).pipe(Effect.provide(fixture.layer))
    }),
  )

  it.effect('does not activate a replacement when saving fails', () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      yield* Ref.set(fixture.rejectSave, true)
      yield* Effect.gen(function* () {
        const auth = yield* T3Auth
        const result = yield* auth.credential().pipe(Effect.flip)
        expect(result).toBeInstanceOf(CredentialError)
        expect(Option.getOrThrow(yield* Ref.get(fixture.saved))).toEqual(initial)
        yield* Ref.set(fixture.rejectSave, false)
        expect(Redacted.value((yield* auth.credential()).accessToken)).toBe('new-secret')
        expect(yield* Ref.get(fixture.rotations)).toBe(2)
      }).pipe(Effect.provide(fixture.layer))
    }),
  )

  it.effect('requires manual pairing after expiry without attempting renewal', () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      yield* TestClock.setTime(initial.expiresAt)
      yield* Effect.gen(function* () {
        const auth = yield* T3Auth
        expect(yield* auth.credential().pipe(Effect.flip)).toEqual(
          new AuthError({ operation: 'renew', reason: 'manual-pairing-required' }),
        )
        expect(yield* Ref.get(fixture.rotations)).toBe(0)
      }).pipe(Effect.provide(fixture.layer))
    }),
  )
})

it.effect('uses a normal paired credential until expiry without requesting access management', () =>
  Effect.gen(function* () {
    const fixture = yield* setup
    const normal: Credential = {
      version: 1,
      origin: initial.origin,
      accessToken: initial.accessToken,
      expiresAt: initial.expiresAt,
      renewAt: initial.renewAt,
      scope: requiredScopes.join(' '),
    }
    yield* Ref.set(fixture.saved, Option.some(normal))
    yield* Effect.gen(function* () {
      const auth = yield* T3Auth
      expect(yield* auth.credential()).toEqual(normal)
      expect(yield* Ref.get(fixture.rotations)).toBe(0)
      yield* TestClock.setTime(normal.expiresAt)
      expect(yield* auth.credential().pipe(Effect.flip)).toMatchObject({
        reason: 'manual-pairing-required',
      })
    }).pipe(Effect.provide(fixture.layer))
  }),
)

it.effect('retains clone permission when renewing a newly paired session', () =>
  Effect.gen(function* () {
    const fixture = yield* setup
    yield* Ref.set(
      fixture.saved,
      Option.some({
        version: initial.version,
        origin: initial.origin,
        accessToken: initial.accessToken,
        expiresAt: initial.expiresAt,
        renewAt: initial.renewAt,
        scope: [...pairingScopes, 'access:write'].join(' '),
      }),
    )
    yield* Effect.gen(function* () {
      const auth = yield* T3Auth
      const renewed = yield* auth.credential()
      expect(renewed.scope).toBe(
        'orchestration:read orchestration:operate source-control:write access:write',
      )
      expect(yield* Ref.get(fixture.renewalRequests)).toEqual([[...pairingScopes, 'access:write']])
    }).pipe(Effect.provide(fixture.layer))
  }),
)
