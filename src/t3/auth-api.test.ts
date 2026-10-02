/* oxlint-disable effecttsgo/unstable-api-usage */
import { expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Redacted from 'effect/Redacted'
import * as Schema from 'effect/Schema'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import { createServer } from 'node:http'
import { AuthApi, authApiLayer } from './auth-api.ts'
import { T3Config } from './config.ts'
import { requiredScopes } from './auth-model.ts'

const isString = Schema.is(Schema.String)

it.live('uses OAuth form encoding, explicit renewal scopes, and redacted secrets', () =>
  Effect.gen(function* () {
    const received: Array<{
      readonly path: string
      readonly authorization: string
      readonly body: string
      readonly contentType: string
    }> = []
    let invalidScopes = false
    const server = createServer((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => {
        body += chunk
      })
      request.on('end', () => {
        received.push({
          path: request.url ?? '',
          authorization: request.headers.authorization ?? '',
          body,
          contentType: request.headers['content-type'] ?? '',
        })
        response.setHeader('content-type', 'application/json')
        const payload =
          request.url === '/oauth/token'
            ? {
                access_token: 'bearer-secret',
                issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
                token_type: 'Bearer',
                expires_in: 2592000,
                scope: invalidScopes ? 'orchestration:read' : requiredScopes.join(' '),
              }
            : request.url === '/api/auth/pairing-token'
              ? {
                  credential: 'renewal-secret',
                  expiresAt: new Date(Date.now() + 60000).toISOString(),
                }
              : { ticket: 'socket-secret', expiresAt: new Date(Date.now() + 60000).toISOString() }
        response.end(JSON.stringify(payload))
      })
    })
    yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () =>
          new Promise<void>((resolve, reject) => {
            server.once('error', reject)
            server.listen(0, '127.0.0.1', resolve)
          }),
        catch: () => new Error('Fixture server failed'),
      }),
      () =>
        Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              server.closeAllConnections()
              server.close(() => resolve())
            }),
        ),
    )
    const address = server.address()
    if (!address || isString(address)) throw new Error('Expected a fixture port')
    const config = Layer.succeed(T3Config, {
      origin: `http://127.0.0.1:${address.port}`,
      stateDirectory: '/tmp/unused',
    })
    yield* Effect.gen(function* () {
      const api = yield* AuthApi
      const token = yield* api.exchange(Redacted.make('initial+&secret'))
      expect(JSON.stringify(token)).not.toContain('bearer-secret')
      expect(new URLSearchParams(received[0]?.body).get('subject_token')).toBe('initial+&secret')
      expect(received[0]?.contentType).toContain('application/x-www-form-urlencoded')
      yield* api.pairing(token.access_token)
      yield* api.ticket(token.access_token)
      expect(received[1]?.authorization).toBe('Bearer bearer-secret')
      expect(JSON.parse(received[1]?.body ?? '{}')).toEqual({
        label: 'sunday renewal',
        scopes: requiredScopes,
      })
      expect(received[2]?.path).toBe('/api/auth/websocket-ticket')
      invalidScopes = true
      expect(yield* api.exchange(Redacted.make('other-secret')).pipe(Effect.flip)).toMatchObject({
        reason: 'missing-scopes',
      })
    }).pipe(
      Effect.provide(
        authApiLayer.pipe(Layer.provide(config), Layer.provide(FetchHttpClient.layer)),
      ),
    )
  }),
)
