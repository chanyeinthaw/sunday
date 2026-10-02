/* oxlint-disable effecttsgo/unstable-api-usage */
import { expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import { landingResponse } from './landing.ts'

it.effect('serves app and web targets for the requested environment and thread', () =>
  Effect.gen(function* () {
    const response = HttpServerResponse.toWeb(
      landingResponse('GET', '/open/env-1/thread-1', 'https://code.p.si14.space'),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    const html = yield* Effect.promise(() => response.text())
    expect(html).toContain('href="t3code://threads/env-1/thread-1"')
    expect(html).toContain('href="https://code.p.si14.space/env-1/thread-1"')
  }),
)

it('rejects malformed routes and non-GET requests', () => {
  for (const path of [
    '/open/env',
    '/open/env/thread/extra',
    '/open/%22/thread',
    '/open/env/<script>',
    '//evil.example/env/thread',
  ]) {
    expect(landingResponse('GET', path, 'https://code.p.si14.space').status).toBe(404)
  }
  expect(landingResponse('POST', '/open/env/thread', 'https://code.p.si14.space').status).toBe(405)
})

it('redirects immediately to the app without accepting an arbitrary target', () => {
  const response = HttpServerResponse.toWeb(
    landingResponse(
      'GET',
      '/app/env-1/thread-1?url=https://evil.example',
      'https://code.p.si14.space',
    ),
  )
  expect(response.status).toBe(302)
  expect(response.headers.get('location')).toBe('t3code://threads/env-1/thread-1')
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(landingResponse('GET', '/app/%0d%0a/thread', 'https://code.p.si14.space').status).toBe(404)
})
