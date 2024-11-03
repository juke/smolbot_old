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
  
  let totalEmojis = 0;
  client.guilds.cache.forEach(guild => {
    const emojiCount = guild.emojis.cache.size;
    totalEmojis += emojiCount;
    
    logger.debug({
      guildId: guild.id,
      guildName: guild.name,
      emojiCount
    }, "Caching guild emojis");
    
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
    // Only process emoji tracking for non-bot messages
    if (!message.author.bot) {
      emojiService.processEmojiText(message.content);
    }
    
    // Always cache the message, regardless of author
    await messageCacheService.cacheMessage(message);
    
    // Exit early if message is from the bot - but only after caching
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
