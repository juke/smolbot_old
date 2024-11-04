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
   * Converts user mentions to display names in a message
   * @param content - The message content to process
   * @param message - The Discord message object for guild context
   * @returns The processed message content with mentions converted to display names
   */
  private async processUserMentions(content: string, message: DiscordMessage): Promise<string> {
    const mentionPattern = /<@!?(\d+)>/g;
    const mentions = [...content.matchAll(mentionPattern)];

    if (!mentions.length) return content;

    let processedContent = content;
    for (const mention of mentions) {
      try {
        const userId = mention[1];
        let displayName: string;

        if (message.guild) {
          const member = await message.guild.members.fetch(userId);
          displayName = member.displayName;
        } else {
          const user = await client.users.fetch(userId);
          displayName = user.username;
        }

        processedContent = processedContent.replace(
          mention[0],
          displayName
        );
      } catch (error) {
        logger.warn({ 
          error,
          userId: mention[1],
          messageId: message.id 
        }, "Failed to resolve user mention");
      }
    }

    return processedContent;
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

    // Process user mentions in the message content
    const processedContent = await this.processUserMentions(message.content, message);

    const cachedMessage: CachedMessage = {
      id: message.id,
      authorId: message.author.id,
      authorUsername: message.author.username,
      authorDisplayName: message.member?.displayName ?? message.author.username,
      content: processedContent,
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