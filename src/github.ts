/* oxlint-disable effecttsgo/unstable-api-usage */
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Redacted from 'effect/Redacted'
import * as Schema from 'effect/Schema'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'
import * as HttpClientResponse from 'effect/http/HttpClientResponse'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { AppConfig, readSecret } from './app-config.ts'
import { decodeRepository } from './settings.ts'

const runFile = promisify(execFile)
const RepositoryInfo = Schema.Struct({
  full_name: Schema.String,
  description: Schema.NullOr(Schema.String),
  default_branch: Schema.NonEmptyString,
  html_url: Schema.String,
})
export interface RepositoryInfo extends Schema.Schema.Type<typeof RepositoryInfo> {}
const decodeInfo = HttpClientResponse.schemaBodyJson(RepositoryInfo)
export class GitHubError extends Schema.TaggedError<GitHubError>()('GitHubError', {
  operation: Schema.String,
}) {}
interface GitHubMethods {
  readonly repository: (name: string) => Effect.Effect<RepositoryInfo, GitHubError>
}
export class GitHub extends Context.Service<GitHub, GitHubMethods>()('sunday/GitHub') {}
export const githubLayer = Layer.effect(
  GitHub,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const config = yield* AppConfig
    const token = config.github.token
      ? yield* readSecret(config.github.token)
      : yield* Effect.tryPromise({
          try: async (signal) =>
            Redacted.make(
              (await runFile('gh', ['auth', 'token'], { signal, timeout: 10000 })).stdout.trim(),
            ),
          catch: () =>
            new GitHubError({ operation: 'gh auth token; log in with gh or set GH_TOKEN' }),
        })
    const repository = Effect.fn('GitHub.repository')(function* (name: string) {
      const valid = yield* decodeRepository(name).pipe(
        Effect.mapError(() => new GitHubError({ operation: 'repository name' })),
      )
      const response = yield* client
        .execute(
          HttpClientRequest.get(`https://api.github.com/repos/${valid}`).pipe(
            HttpClientRequest.bearerToken(token),
            HttpClientRequest.setHeader('User-Agent', 'sunday'),
            HttpClientRequest.setHeader('X-GitHub-Api-Version', '2022-11-28'),
          ),
        )
        .pipe(
          Effect.timeout('15 seconds'),
          Effect.mapError(() => new GitHubError({ operation: 'request' })),
        )
      if (response.status !== 200)
        return yield* new GitHubError({ operation: `repository HTTP ${response.status}` })
      return yield* decodeInfo(response).pipe(
        Effect.mapError(() => new GitHubError({ operation: 'decode repository' })),
      )
    })
    return GitHub.of({ repository })
  }),
)
