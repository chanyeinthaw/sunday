import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import type * as Redacted from 'effect/Redacted'
import * as Ref from 'effect/Ref'
import * as Semaphore from 'effect/Semaphore'
import { AuthApi } from './auth-api.ts'
import {
  AuthError,
  Credential,
  CredentialError,
  TicketResponse,
  requiredScopes,
  pairingScopes,
} from './auth-model.ts'
import { T3Config } from './config.ts'
import { CredentialStore } from './credential-store.ts'

type Failure = AuthError | CredentialError
interface AuthMethods {
  readonly pair: (grant: Redacted.Redacted<string>) => Effect.Effect<void, Failure>
  readonly credential: () => Effect.Effect<Credential, Failure>
  readonly ticket: () => Effect.Effect<typeof TicketResponse.Type, Failure>
}
export class T3Auth extends Context.Service<T3Auth, AuthMethods>()('sunday/T3Auth') {}

export const authLayer = Layer.effect(
  T3Auth,
  Effect.gen(function* () {
    const api = yield* AuthApi
    const store = yield* CredentialStore
    const config = yield* T3Config
    const current = yield* Ref.make(yield* store.load())
    const mutex = yield* Semaphore.make(1)
    const exchangeAndPersist = Effect.fn('T3Auth.exchangeAndPersist')(function* (
      grant: Redacted.Redacted<string>,
      scopes: ReadonlyArray<string> = pairingScopes,
    ) {
      // Use the time before the request so network latency never extends token validity.
      const startedAt = yield* Clock.currentTimeMillis
      const response = yield* api.exchange(grant, scopes)
      const credential: Credential = {
        version: 1,
        origin: config.origin,
        accessToken: response.access_token,
        expiresAt: startedAt + response.expires_in * 1000,
        renewAt:
          startedAt +
          response.expires_in * 1000 -
          Math.min(24 * 60 * 60 * 1000, response.expires_in * 100),
        scope: response.scope,
      }
      yield* store.save(credential)
      yield* Ref.set(current, Option.some(credential))
      return credential
    })
    const pair = Effect.fn('T3Auth.pair')(
      function* (grant: Redacted.Redacted<string>) {
        const paired = yield* exchangeAndPersist(grant)
        yield* Effect.logInfo('auth.paired').pipe(
          Effect.annotateLogs({
            expiresAt: paired.expiresAt,
            automaticRenewal: paired.scope.split(' ').includes('access:write'),
          }),
        )
      },
      (effect) => mutex.withPermit(effect),
    )
    const credential = Effect.fn('T3Auth.credential')(
      function* () {
        const saved = yield* Ref.get(current)
        const now = yield* Clock.currentTimeMillis
        if (
          Option.isNone(saved) ||
          saved.value.expiresAt <= now ||
          !requiredScopes.every((scope) => saved.value.scope.split(' ').includes(scope))
        ) {
          return yield* new AuthError({ operation: 'renew', reason: 'manual-pairing-required' })
        }
        // Normal pairing can run tasks but cannot create renewal grants.
        if (saved.value.renewAt > now || !saved.value.scope.split(' ').includes('access:write'))
          return saved.value
        // Renewal cannot add permissions that the existing session was never granted.
        const renewalScopes = [
          ...pairingScopes.filter((scope) => saved.value.scope.split(' ').includes(scope)),
          'access:write',
        ]
        const grant = yield* api.pairing(saved.value.accessToken, renewalScopes).pipe(
          Effect.catchIf(
            (error) => error.status === 401 || error.status === 403,
            () =>
              Effect.fail(new AuthError({ operation: 'renew', reason: 'manual-pairing-required' })),
          ),
        )
        if (DateTime.toEpochMillis(grant.expiresAt) <= now) {
          return yield* new AuthError({ operation: 'renew', reason: 'invalid-response' })
        }
        const replacement = yield* exchangeAndPersist(grant.credential, renewalScopes)
        yield* Effect.logInfo('auth.renewed').pipe(
          Effect.annotateLogs({ expiresAt: replacement.expiresAt }),
        )
        return replacement
      },
      (effect) => mutex.withPermit(effect),
    )
    const ticket = Effect.fn('T3Auth.ticket')(function* () {
      const active = yield* credential()
      const response = yield* api.ticket(active.accessToken)
      if (DateTime.toEpochMillis(response.expiresAt) <= (yield* Clock.currentTimeMillis)) {
        return yield* new AuthError({ operation: 'ticket', reason: 'invalid-response' })
      }
      return response
    })
    return T3Auth.of({ pair, credential, ticket })
  }),
)
