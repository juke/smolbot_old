import { Message as DiscordMessage } from "discord.js";
import { CachedMessage, AIMessage, ImageDescription } from "../types.js";
import { logger } from "../config/logger.js";
import { CONFIG } from "../config/config.js";
import { client } from "./discordClient.js";
import { groqService } from "./groqService.js";

/**
 * Service for managing message caching and AI message formatting
 */
export class MessageCacheService {
  private messageCache: Map<string, Map<string, CachedMessage[]>>;

  constructor() {
    this.messageCache = new Map();
  }

  /**
   * Gets or creates a guild's message cache
   */
  private getGuildCache(guildId: string): Map<string, CachedMessage[]> {
    if (!this.messageCache.has(guildId)) {
      this.messageCache.set(guildId, new Map());
    }
    return this.messageCache.get(guildId)!;
  }

  /**
   * Gets messages for a specific channel
   */
  public getChannelMessages(guildId: string, channelId: string): CachedMessage[] {
    const guildCache = this.getGuildCache(guildId);
    if (!guildCache.has(channelId)) {
      guildCache.set(channelId, []);
    }
    return guildCache.get(channelId)!;
  }

  /**
   * Caches a new message with its metadata
   */
  public async cacheMessage(message: DiscordMessage): Promise<CachedMessage> {
    const guildId = message.guild?.id ?? "DM";
    const channelId = message.channel.id;
    const guildCache = this.getGuildCache(guildId);

    if (!guildCache.has(channelId)) {
      guildCache.set(channelId, []);
    }

    // Process image attachments if any
    const imageDescriptions: ImageDescription[] = [];
    for (const attachment of message.attachments.values()) {
      if (attachment.contentType?.startsWith("image/")) {
        const brief = await groqService.briefImageAnalysis(attachment.url);
        imageDescriptions.push({ brief });
      }
    }

    // Process referenced message if any
    let referencedMessage;
    if (message.reference?.messageId) {
      try {
        const referenced = await message.channel.messages.fetch(message.reference.messageId);
        referencedMessage = {
          id: referenced.id,
          content: referenced.content,
          authorDisplayName: referenced.member?.displayName ?? referenced.author.username,
          imageDescriptions: [] as ImageDescription[]
        };

        // Process referenced message images
        for (const attachment of referenced.attachments.values()) {
          if (attachment.contentType?.startsWith("image/")) {
            const brief = await groqService.briefImageAnalysis(attachment.url);
            referencedMessage.imageDescriptions.push({ brief });
          }
        }
      } catch (error) {
        logger.error({ 
          messageId: message.id, 
          referenceId: message.reference.messageId,
          error 
        }, "Failed to fetch referenced message");
      }
    }

    const cachedMessage: CachedMessage = {
      id: message.id,
      authorId: message.author.id,
      authorUsername: message.author.username,
      authorDisplayName: message.member?.displayName ?? message.author.username,
      content: message.content,
      timestamp: new Date(message.createdTimestamp),
      imageDescriptions,
      referencedMessage
    };

    // Add to cache and maintain size limit
    const channelMessages = this.getChannelMessages(guildId, channelId);
    channelMessages.push(cachedMessage);
    if (channelMessages.length > CONFIG.MAX_MESSAGES) {
      const removed = channelMessages.shift();
      logger.debug({
        channelId,
        removedMessageId: removed?.id,
        newCacheSize: channelMessages.length
      }, "Removed oldest message from cache");
    }

    logger.info({
      messageId: message.id,
      guildId,
      channelId,
      authorId: message.author.id,
      hasImages: imageDescriptions.length > 0,
      hasReference: !!referencedMessage,
      cacheSize: channelMessages.length
    }, "Message successfully cached");

    return cachedMessage;
  }

  /**
   * Converts cached messages to AI-friendly format
   */
  public buildAIMessages(messages: CachedMessage[], currentMessageId?: string): AIMessage[] {
    const MAX_MESSAGE_LENGTH = 500; // Characters

    /**
     * Helper to truncate text with ellipsis
     */
    const truncateText = (text: string, maxLength: number): string => {
      if (text.length <= maxLength) return text;
      return `${text.slice(0, maxLength - 3)}...`;
    };

    return messages.map((msg): AIMessage => {
      const contentParts = [
        `${msg.authorDisplayName}: ${truncateText(msg.content, MAX_MESSAGE_LENGTH)}`
      ];
      
      if (msg.imageDescriptions.length > 0) {
        msg.imageDescriptions.forEach((desc: ImageDescription) => {
          if (msg.id === currentMessageId && desc.detailed) {
            contentParts.push(`[Image Description: ${desc.detailed}]`);
          } else {
            contentParts.push(`[Image Description: ${desc.brief}]`);
          }
        });
      }
      
      if (msg.referencedMessage) {
        contentParts.push(
          `[Referenced Message from ${msg.referencedMessage.authorDisplayName}: ${
            truncateText(msg.referencedMessage.content, MAX_MESSAGE_LENGTH)
          }]`
        );
        msg.referencedMessage.imageDescriptions.forEach((desc: ImageDescription) => {
          if (msg.id === currentMessageId && desc.detailed) {
            contentParts.push(`[Referenced Image Description: ${desc.detailed}]`);
          } else {
            contentParts.push(`[Referenced Image Description: ${desc.brief}]`);
          }
        });
      }

      return {
        role: msg.authorId === client.user?.id ? "assistant" : "user",
        content: contentParts.join("\n")
      };
    });
  }
}

export const messageCacheService = new MessageCacheService();