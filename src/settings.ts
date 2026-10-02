import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import type * as Redacted from 'effect/Redacted'
import { isAbsolute, relative, resolve } from 'node:path'

import { AppConfig, readSecret, type GuildRule } from './app-config.ts'
export interface BotSettings {
  readonly contextMessages: number
  readonly guilds: ReadonlyArray<GuildRule>
  readonly cloneRoot: string
  readonly discordToken: Redacted.Redacted
  readonly providerInstanceId: string
  readonly codingModel: string
  readonly codingReasoningEffort: 'low' | 'medium' | 'high' | 'xhigh'
  readonly environmentId: string
  readonly runtimeMode: 'approval-required' | 'auto-accept-edits' | 'auto' | 'full-access'
}
export class Settings extends Context.Service<Settings, BotSettings>()('sunday/Settings') {}
export const settingsLayer = Layer.effect(
  Settings,
  Effect.gen(function* () {
    const config = yield* AppConfig
    const discordToken = yield* readSecret(config.discord.token)
    return Settings.of({
      contextMessages: config.discord.contextMessages,
      guilds: config.discord.guilds,
      discordToken,
      cloneRoot: config.t3.cloneRoot,
      providerInstanceId: config.t3.providerInstanceId,
      environmentId: config.t3.environmentId,
      runtimeMode: config.t3.runtimeMode,
      codingModel: config.t3.model,
      codingReasoningEffort: config.t3.reasoningEffort,
    })
  }),
)

export const Repository = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/u),
)
export const decodeRepository = Schema.decodeUnknownEffect(Repository)

export function pathWithin(root: string, ...segments: ReadonlyArray<string>): string {
  if (!isAbsolute(root)) throw new Error('Root must be absolute')
  const path = resolve(root, ...segments)
  const inside = relative(root, path)
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside))
    throw new Error('Path must be beneath configured root')
  return path
}
