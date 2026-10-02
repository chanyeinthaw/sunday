// Effect HTTP is pinned to 4.0.0; this adapter owns version compatibility.
/* oxlint-disable effecttsgo/unstable-api-usage */
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import type * as Redacted from 'effect/Redacted'
import * as RedactedValue from 'effect/Redacted'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'
import * as HttpClientResponse from 'effect/http/HttpClientResponse'
import { T3Config } from './config.ts'
import {
  AuthError,
  PairingResponse,
  TicketResponse,
  TokenResponse,
  requiredScopes,
} from './auth-model.ts'

const decodeToken = HttpClientResponse.schemaBodyJson(TokenResponse)
const decodePairing = HttpClientResponse.schemaBodyJson(PairingResponse)
const decodeTicket = HttpClientResponse.schemaBodyJson(TicketResponse)

interface AuthApiMethods {
  readonly exchange: (
    grant: Redacted.Redacted<string>,
  ) => Effect.Effect<typeof TokenResponse.Type, AuthError>
  readonly pairing: (
    token: Redacted.Redacted<string>,
  ) => Effect.Effect<typeof PairingResponse.Type, AuthError>
  readonly ticket: (
    token: Redacted.Redacted<string>,
  ) => Effect.Effect<typeof TicketResponse.Type, AuthError>
}
export class AuthApi extends Context.Service<AuthApi, AuthApiMethods>()('sunday/AuthApi') {}

export const authApiLayer = Layer.effect(
  AuthApi,
  Effect.gen(function* () {
    const config = yield* T3Config
    const client = yield* HttpClient.HttpClient
    const execute = Effect.fn('AuthApi.execute')(function* (
      request: HttpClientRequest.HttpClientRequest,
    ) {
      const response = yield* client.execute(request).pipe(
        Effect.timeout('15 seconds'),
        Effect.mapError(() => new AuthError({ operation: 'request', reason: 'transport' })),
      )
      if (response.status < 200 || response.status >= 300) {
        return yield* new AuthError({
          operation: 'request',
          reason: 'rejected',
          status: response.status,
        })
      }
      return response
    })
    const exchange = Effect.fn('AuthApi.exchange')(function* (grant: Redacted.Redacted<string>) {
      const response = yield* execute(
        HttpClientRequest.post(`${config.origin}/oauth/token`).pipe(
          HttpClientRequest.bodyUrlParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
            subject_token: RedactedValue.value(grant),
            subject_token_type: 'urn:t3:params:oauth:token-type:environment-bootstrap',
            requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
            scope: requiredScopes.join(' '),
            client_label: 'sunday',
            client_device_type: 'bot',
          }),
        ),
      )
      const token = yield* decodeToken(response).pipe(
        Effect.mapError(() => new AuthError({ operation: 'exchange', reason: 'invalid-response' })),
      )
      const scopes = new Set(token.scope.split(' '))
      if (!requiredScopes.every((scope) => scopes.has(scope))) {
        return yield* new AuthError({ operation: 'exchange', reason: 'missing-scopes' })
      }
      return token
    })
    const pairing = Effect.fn('AuthApi.pairing')(function* (token: Redacted.Redacted<string>) {
      const request = yield* HttpClientRequest.post(`${config.origin}/api/auth/pairing-token`).pipe(
        HttpClientRequest.bearerToken(token),
        HttpClientRequest.bodyJson({ label: 'sunday renewal', scopes: requiredScopes }),
        Effect.mapError(() => new AuthError({ operation: 'pairing', reason: 'invalid-response' })),
      )
      const response = yield* execute(request)
      return yield* decodePairing(response).pipe(
        Effect.mapError(() => new AuthError({ operation: 'pairing', reason: 'invalid-response' })),
      )
    })
    const ticket = Effect.fn('AuthApi.ticket')(function* (token: Redacted.Redacted<string>) {
      const response = yield* execute(
        HttpClientRequest.post(`${config.origin}/api/auth/websocket-ticket`).pipe(
          HttpClientRequest.bearerToken(token),
        ),
      )
      return yield* decodeTicket(response).pipe(
        Effect.mapError(() => new AuthError({ operation: 'ticket', reason: 'invalid-response' })),
      )
    })
    return AuthApi.of({ exchange, pairing, ticket })
  }),
)
