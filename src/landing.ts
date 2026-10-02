/* oxlint-disable effecttsgo/unstable-api-usage */
import * as BunHttpServer from '@effect/platform-bun/BunHttpServer'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as HttpServer from 'effect/http/HttpServer'
import * as HttpServerRequest from 'effect/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import { AppConfig } from './app-config.ts'

const RouteId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/u))
const isRouteId = Schema.is(RouteId)

export function landingResponse(method: string, url: string, webOrigin: string) {
  if (method !== 'GET') return HttpServerResponse.text('Method not allowed', { status: 405 })
  const path = url.split('?')[0]?.split('/') ?? []
  const environmentId = path[2]
  const threadId = path[3]
  if (
    path.length !== 4 ||
    (path[1] !== 'open' && path[1] !== 'app') ||
    !isRouteId(environmentId) ||
    !isRouteId(threadId)
  )
    return HttpServerResponse.text('Not found', { status: 404 })
  const appLink = `t3code://threads/${environmentId}/${threadId}`
  if (path[1] === 'app')
    return HttpServerResponse.redirect(appLink, { headers: { 'cache-control': 'no-store' } })
  const webLink = `${webOrigin}/${environmentId}/${threadId}`
  return HttpServerResponse.html(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Open T3 Code</title><style>
:root{color-scheme:light dark;font-family:system-ui,sans-serif}body{margin:0;min-height:100svh;display:grid;place-items:center;background:light-dark(#f5f5f5,#151515)}main{width:min(320px,calc(100% - 48px));text-align:center}h1{font-size:24px;margin:0 0 24px}a{display:block;padding:16px;margin:12px 0;border-radius:12px;text-decoration:none;font-weight:600;background:light-dark(#e5e5e5,#303030);color:inherit}.primary{background:#2563eb;color:white}a:focus-visible{outline:3px solid #60a5fa;outline-offset:3px}
</style></head><body><main><h1>T3 Code</h1><a class="primary" href="${appLink}">Open in app</a><a href="${webLink}">Open in web</a></main></body></html>`)
}

export const landingLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* AppConfig
    const app = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      return landingResponse(
        request.method,
        request.url,
        new URL(config.t3.publicUrl ?? config.t3.serverUrl).origin,
      )
    })
    return Layer.effectDiscard(
      Effect.gen(function* () {
        yield* HttpServer.serveEffect(app)
        yield* Effect.logInfo('landing.started').pipe(
          Effect.annotateLogs({ port: config.landing.port }),
        )
      }),
    ).pipe(
      Layer.provide(
        BunHttpServer.layerServer({ hostname: '127.0.0.1', port: config.landing.port }),
      ),
    )
  }),
)
