import { expect, it } from '@effect/vitest'
import * as ConfigProvider from 'effect/ConfigProvider'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Redacted from 'effect/Redacted'
import * as Schema from 'effect/Schema'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppConfig, Configuration, appConfigLayer, readSecret } from './app-config.ts'
import { isAllowedUser } from './discord.ts'
import { Settings, settingsLayer } from './settings.ts'

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Configuration))
const exampleConfiguration = Effect.gen(function* () {
  const json = yield* Effect.promise(() =>
    readFile(new URL('../sunday.example.json', import.meta.url), 'utf8'),
  )
  return yield* decode(json)
})
const directory = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), 'sunday-config-'))),
  (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
)

it.effect('loads multiple guilds and resolves a secret by its configured environment name', () =>
  Effect.gen(function* () {
    const path = join(yield* directory, 'config.json')
    const example = yield* exampleConfiguration
    const guilds = [
      { id: '842724454677348352', userIds: ['435482941515104257'] },
      { id: '1021288369327706153', userIds: ['123456789012345678'] },
    ]
    yield* Effect.promise(() =>
      writeFile(
        path,
        JSON.stringify({
          ...example,
          discord: { ...example.discord, token: { env: 'CUSTOM_BOT_TOKEN' }, guilds },
        }),
      ),
    )
    const provider = ConfigProvider.layer(
      ConfigProvider.fromUnknown({ SUNDAY_CONFIG: path, CUSTOM_BOT_TOKEN: 'fake-secret' }),
    )
    yield* Effect.gen(function* () {
      const settings = yield* Settings
      expect(settings.landingUrl).toBe(`http://localhost:${example.landing.port}`)
      expect(settings.guilds).toEqual(guilds)
      expect(Redacted.value(settings.discordToken)).toBe('fake-secret')
      expect(isAllowedUser(settings.guilds, '842724454677348352', '435482941515104257')).toBe(true)
      expect(isAllowedUser(settings.guilds, '1021288369327706153', '123456789012345678')).toBe(true)
      expect(isAllowedUser(settings.guilds, '1021288369327706153', '435482941515104257')).toBe(
        false,
      )
      expect(isAllowedUser(settings.guilds, null, '435482941515104257')).toBe(false)
    }).pipe(
      Effect.provide(settingsLayer.pipe(Layer.provide(appConfigLayer), Layer.provide(provider))),
    )
  }),
)

it.effect(
  'rejects literal secrets and unknown config properties without logging their values',
  () =>
    Effect.gen(function* () {
      const path = join(yield* directory, 'config.json')
      const example = yield* exampleConfiguration
      yield* Effect.promise(() =>
        writeFile(
          path,
          JSON.stringify({
            ...example,
            discord: { ...example.discord, token: 'literal-private-token' },
          }),
        ),
      )
      const provider = ConfigProvider.layer(ConfigProvider.fromUnknown({ SUNDAY_CONFIG: path }))
      const failure = yield* Effect.gen(function* () {
        return yield* AppConfig
      }).pipe(Effect.provide(appConfigLayer.pipe(Layer.provide(provider))), Effect.flip)
      expect(failure).toMatchObject({ reason: 'invalid-config' })
      expect(JSON.stringify(failure)).not.toContain('literal-private-token')
      yield* Effect.promise(() => writeFile(path, JSON.stringify({ ...example, typo: true })))
      expect(
        yield* Effect.gen(function* () {
          return yield* AppConfig
        }).pipe(Effect.provide(appConfigLayer.pipe(Layer.provide(provider))), Effect.flip),
      ).toMatchObject({ reason: 'invalid-config' })
    }),
)

it.effect('fails clearly when a referenced secret is absent', () =>
  Effect.gen(function* () {
    const failure = yield* readSecret({ env: 'MISSING_TOKEN' }).pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
      Effect.flip,
    )
    expect(failure).toMatchObject({ reason: 'missing-secret', location: 'MISSING_TOKEN' })
  }),
)

it.effect('uses the configured Sunday origin including its external port', () =>
  Effect.gen(function* () {
    const example = yield* exampleConfiguration
    const config = Layer.succeed(AppConfig, {
      ...example,
      landing: { port: 3784, publicUrl: 'https://sunday.example.com:8443' },
    })
    const provider = ConfigProvider.layer(
      ConfigProvider.fromUnknown({ DISCORD_BOT_TOKEN: 'fixture' }),
    )
    yield* Effect.gen(function* () {
      const settings = yield* Settings
      expect(settings.landingUrl).toBe('https://sunday.example.com:8443')
    }).pipe(Effect.provide(settingsLayer.pipe(Layer.provide(config), Layer.provide(provider))))
  }),
)
