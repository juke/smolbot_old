import { Message as DiscordMessage, GuildEmoji } from "discord.js";
import { logger } from "../config/logger.js";
import { client } from "./discordClient.js";
import { messageQueueService } from "./messageQueueService.js";
import { messageCacheService } from "./messageCacheService.js";
import { emojiService } from "./emojiService.js";
import { MODEL_CONFIG } from "../config/config.js";

/**
 * Handles the 'ready' event when the bot starts up
 */
export async function handleReady(): Promise<void> {
  logger.info({
    username: client.user?.tag,
    guildCount: client.guilds.cache.size
  }, "Bot successfully logged in");
  
  // Only initialize emoji cache at startup
  let totalEmojis = 0;
  client.guilds.cache.forEach(guild => {
    const emojiCount = guild.emojis.cache.size;
    totalEmojis += emojiCount;
    emojiService.cacheGuildEmojis(guild.id, guild.emojis.cache);
  });
  
  logger.info({
    totalGuilds: client.guilds.cache.size,
    totalEmojis,
    cachedEmojiCount: MODEL_CONFIG.emojiCache.size
  }, "Initialization complete");
}

/**
 * Handles incoming messages
 */
export async function handleMessage(message: DiscordMessage): Promise<void> {
  try {
    const guildId = message.guild?.id ?? "DM";
    const channelId = message.channel.id;

    // Ensure channel has cached messages before processing
    await messageCacheService.ensureChannelCache(guildId, channelId);
    
    // Always cache the message first, regardless of author
    await messageCacheService.cacheMessage(message);
    
    // Process emojis for all messages except bot messages
    if (!message.author.bot) {
      // Process emojis with isFromBot=false for user messages - just for tracking usage
      await emojiService.processEmojiText(message.content, false);
    }
    
    // Exit early if message is from the bot - after caching but before any other processing
    if (message.author.id === client.user?.id) {
      return;
    }

    const botId = client.user?.id;
    const mentioned = message.mentions.has(client.user!);
    const isReplyToBot = message.reference?.messageId
      ? (await message.channel.messages.fetch(message.reference.messageId))
          .author.id === botId
      : false;

    if (mentioned || isReplyToBot) {
      // Try to queue the message
      const queued = messageQueueService.queueMessage(message);
      
      if (!queued) {
        const username = message.member?.displayName ?? message.author.username;
        await message.reply({
          content: `Sorry ${username}, there are too many pending messages. Please try again later.`,
          failIfNotExists: false
        });
      }
    }
  } catch (error) {
    logger.error({ 
      messageId: message.id, 
      error 
    }, "Error handling message");
  }
}
