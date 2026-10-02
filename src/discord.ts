import { Client, Events, GatewayIntentBits, Partials, type Message } from 'discord.js'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Queue from 'effect/Queue'
import * as Redacted from 'effect/Redacted'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import type { GuildRule } from './app-config.ts'
import { Settings } from './settings.ts'

export class DiscordError extends Schema.TaggedError<DiscordError>()('DiscordError', {
  operation: Schema.String,
}) {}
export interface DiscordMention {
  readonly id: string
  readonly guildId: string
  readonly userId: string
  readonly channelId: string
  readonly content: string
}
export interface DiscordContext {
  readonly channelName: string | null
  readonly channelDescription: string | null
  readonly threadName: string | null
  readonly messages: ReadonlyArray<{
    readonly author: string
    readonly content: string
    readonly createdAt: string
  }>
}
interface DiscordMethods {
  readonly mentions: Stream.Stream<DiscordMention>
  readonly context: (message: DiscordMention) => Effect.Effect<DiscordContext, DiscordError>
  readonly reply: (message: DiscordMention, text: string) => Effect.Effect<void, DiscordError>
}
export class Discord extends Context.Service<Discord, DiscordMethods>()('sunday/Discord') {}
export function isAllowedUser(
  guilds: ReadonlyArray<GuildRule>,
  guildId: string | null,
  userId: string,
): boolean {
  return guilds.some((guild) => guild.id === guildId && guild.userIds.includes(userId))
}
export function isAllowedMention(
  message: Message,
  guilds: ReadonlyArray<GuildRule>,
  botId: string,
): boolean {
  return (
    !message.author.bot &&
    isAllowedUser(guilds, message.guildId, message.author.id) &&
    message.mentions.users.has(botId)
  )
}
export const discordLayer = Layer.effect(
  Discord,
  Effect.gen(function* () {
    const settings = yield* Settings
    const inbox = yield* Queue.bounded<DiscordMention>(100)
    const client = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new Client({
            intents: [
              GatewayIntentBits.Guilds,
              GatewayIntentBits.GuildMessages,
              GatewayIntentBits.MessageContent,
            ],
            partials: [Partials.Channel],
          }),
      ),
      (connection) => Effect.promise(() => connection.destroy()),
    )
    client.on(Events.MessageCreate, (message) => {
      if (client.user && isAllowedMention(message, settings.guilds, client.user.id)) {
        Queue.offerUnsafe(inbox, {
          id: message.id,
          guildId: message.guildId ?? '',
          userId: message.author.id,
          channelId: message.channelId,
          content: message.content,
        })
      }
    })
    yield* Effect.tryPromise({
      try: () => client.login(Redacted.value(settings.discordToken)),
      catch: () => new DiscordError({ operation: 'login' }),
    })
    const getChannel = Effect.fn('Discord.getChannel')(function* (channelId: string) {
      const channel = yield* Effect.tryPromise({
        try: () => client.channels.fetch(channelId),
        catch: () => new DiscordError({ operation: 'channel' }),
      })
      if (!channel?.isTextBased()) return yield* new DiscordError({ operation: 'text channel' })
      return channel
    })
    const context = Effect.fn('Discord.context')(function* (message: DiscordMention) {
      const channel = yield* getChannel(message.channelId)
      const descriptionChannel = channel.isThread()
        ? (channel.parent ??
          (yield* Effect.tryPromise({
            try: () => client.channels.fetch(channel.parentId ?? ''),
            catch: () => new DiscordError({ operation: 'parent channel' }),
          })))
        : channel
      const history =
        settings.contextMessages === 0
          ? []
          : [
              ...(yield* Effect.tryPromise({
                try: () =>
                  channel.messages.fetch({ limit: settings.contextMessages, before: message.id }),
                catch: () => new DiscordError({ operation: 'history' }),
              })).values(),
            ]
      return {
        channelName:
          descriptionChannel && 'name' in descriptionChannel ? descriptionChannel.name : null,
        channelDescription:
          descriptionChannel && 'topic' in descriptionChannel ? descriptionChannel.topic : null,
        threadName: channel.isThread() ? channel.name : null,
        messages: history
          .toSorted((a, b) => a.createdTimestamp - b.createdTimestamp)
          .slice(-settings.contextMessages)
          .map((item) => ({
            author: item.author.username,
            content: item.content,
            createdAt: item.createdAt.toISOString(),
          })),
      }
    })
    const reply = Effect.fn('Discord.reply')(function* (message: DiscordMention, text: string) {
      const channel = yield* Effect.tryPromise({
        try: () => client.channels.fetch(message.channelId),
        catch: () => new DiscordError({ operation: 'reply' }),
      })
      if (!channel?.isSendable()) return yield* new DiscordError({ operation: 'reply' })
      const chunks = text.match(/[\s\S]{1,1900}/gu) ?? ['']
      // Send in order; parallel sends can reorder a split reply.
      for (const content of chunks.slice(0, 8)) {
        yield* Effect.tryPromise({
          try: async () => {
            await channel.send({
              content,
              reply: { messageReference: message.id, failIfNotExists: false },
              allowedMentions: { parse: [], repliedUser: false },
            })
          },
          catch: () => new DiscordError({ operation: 'reply' }),
        })
      }
    })
    return Discord.of({ mentions: Stream.fromQueue(inbox), context, reply })
  }),
)
