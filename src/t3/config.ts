import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { AppConfig } from '../app-config.ts'

export interface Settings {
  readonly origin: string
  readonly stateDirectory: string
}

export class T3Config extends Context.Service<T3Config, Settings>()('sunday/T3Config') {}

export const configLayer = Layer.effect(
  T3Config,
  Effect.gen(function* () {
    const config = yield* AppConfig
    return T3Config.of({
      origin: new URL(config.t3.serverUrl).origin,
      stateDirectory: config.t3.stateDirectory,
    })
  }),
)
