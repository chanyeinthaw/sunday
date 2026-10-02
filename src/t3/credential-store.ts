import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import { constants } from 'node:fs'
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { T3Config } from './config.ts'
import { Credential, CredentialError, decodeCredential, encodeCredential } from './auth-model.ts'

interface StoreMethods {
  readonly load: () => Effect.Effect<Option.Option<Credential>, CredentialError>
  readonly save: (credential: Credential) => Effect.Effect<void, CredentialError>
}
export class CredentialStore extends Context.Service<CredentialStore, StoreMethods>()(
  'sunday/CredentialStore',
) {}

export const credentialStoreLayer = Layer.effect(
  CredentialStore,
  Effect.gen(function* () {
    const config = yield* T3Config
    const directory = config.stateDirectory
    yield* Effect.tryPromise({
      try: async () => {
        await mkdir(directory, { recursive: true, mode: 0o700 })
        const info = await lstat(directory)
        if (
          !info.isDirectory() ||
          info.isSymbolicLink() ||
          (info.mode & 0o077) !== 0 ||
          info.uid !== process.getuid?.()
        ) {
          throw new CredentialError({ operation: 'directory', reason: 'unsafe-permissions' })
        }
      },
      catch: (error) =>
        error instanceof CredentialError
          ? error
          : new CredentialError({ operation: 'directory', reason: 'io' }),
    })
    // One process owns this state directory; a crash leaves a lock for manual inspection.
    const lockPath = join(directory, 'process.lock')
    yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => open(lockPath, 'wx', 0o600),
        catch: () => new CredentialError({ operation: 'lock', reason: 'already-running' }),
      }),
      (lock) =>
        Effect.promise(async () => {
          await lock.close()
          await rm(lockPath, { force: true })
        }),
    )
    const path = join(directory, 'credential.json')
    const load = Effect.fn('CredentialStore.load')(function* () {
      const json = yield* Effect.tryPromise({
        try: async () => {
          const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(
            async (error: NodeJS.ErrnoException) => {
              if (error.code === 'ENOENT') return undefined
              throw error
            },
          )
          if (!handle) return Option.none<string>()
          try {
            const info = await handle.stat()
            if (
              !info.isFile() ||
              (info.mode & 0o077) !== 0 ||
              info.uid !== process.getuid?.() ||
              info.nlink !== 1
            ) {
              throw new CredentialError({ operation: 'read', reason: 'unsafe-permissions' })
            }
            return Option.some(await handle.readFile('utf8'))
          } finally {
            await handle.close()
          }
        },
        catch: (error) =>
          error instanceof CredentialError
            ? error
            : new CredentialError({ operation: 'read', reason: 'io' }),
      })
      if (Option.isNone(json)) return Option.none<Credential>()
      const credential = yield* decodeCredential(json.value).pipe(
        Effect.mapError(() => new CredentialError({ operation: 'decode', reason: 'invalid-data' })),
      )
      if (credential.origin !== config.origin) {
        return yield* new CredentialError({ operation: 'read', reason: 'wrong-server' })
      }
      return Option.some(credential)
    })
    const save = Effect.fn('CredentialStore.save')(function* (credential: Credential) {
      const json = yield* encodeCredential(credential).pipe(
        Effect.mapError(() => new CredentialError({ operation: 'encode', reason: 'invalid-data' })),
      )
      yield* Effect.tryPromise({
        try: async () => {
          const temporary = join(directory, `credential-${crypto.randomUUID()}.tmp`)
          try {
            const handle = await open(temporary, 'wx', 0o600)
            try {
              await handle.writeFile(json, 'utf8')
              await handle.sync()
            } finally {
              await handle.close()
            }
            await rename(temporary, path)
            const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY)
            try {
              await parent.sync()
            } finally {
              await parent.close()
            }
          } finally {
            await rm(temporary, { force: true })
          }
        },
        catch: () => new CredentialError({ operation: 'save', reason: 'io' }),
      })
    })
    return CredentialStore.of({ load, save })
  }),
)
