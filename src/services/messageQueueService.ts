import { Message as DiscordMessage, ChannelType } from "discord.js";
import { MessageQueue, QueuedMessage } from "../types.js";
import { logger } from "./logger.js";
import { CONFIG } from "../config/config.js";
import { client } from "./discordClient.js";
import { messageCacheService } from "./messageCacheService.js";
import { groqService } from "./groqService.js";
import { emojiService } from "./emojiService.js";

/**
 * Service for managing message queues
 */
export class MessageQueueService {
  private messageQueues: Map<string, MessageQueue>;

  constructor() {
    this.messageQueues = new Map();
  }

  /**
   * Gets or creates a message queue for a channel
   */
  private getChannelQueue(channelId: string): MessageQueue {
    if (!this.messageQueues.has(channelId)) {
      this.messageQueues.set(channelId, {
        queue: [],
        isProcessing: false
      });
    }
    return this.messageQueues.get(channelId)!;
  }

  /**
   * Adds a message to the processing queue
   */
  public queueMessage(message: DiscordMessage): boolean {
    const channelQueue = this.getChannelQueue(message.channel.id);
    
    logger.debug({
      channelId: message.channel.id,
      queueLength: channelQueue.queue.length,
      maxSize: CONFIG.QUEUE.maxQueueSize,
      authorId: message.author.id,
      messageId: message.id
    }, "Attempting to queue message");
    
    if (channelQueue.queue.length >= CONFIG.QUEUE.maxQueueSize) {
      logger.warn({
        channelId: message.channel.id,
        queueLength: channelQueue.queue.length,
        messageId: message.id
      }, "Message queue full - rejecting message");
      return false;
    }
    
    const queuedMessage: QueuedMessage = {
      message,
      timestamp: Date.now()
    };
    
    channelQueue.queue.push(queuedMessage);
    
    logger.info({
      channelId: message.channel.id,
      messageId: message.id,
      queuePosition: channelQueue.queue.length,
      isProcessing: channelQueue.isProcessing
    }, "Message successfully queued");
    
    if (!channelQueue.isProcessing) {
      void this.processChannelQueue(message.channel.id);
    }
    
    return true;
  }

  /**
   * Processes messages in a channel's queue
   */
  private async processChannelQueue(channelId: string): Promise<void> {
    const channelQueue = this.getChannelQueue(channelId);
    
    if (channelQueue.isProcessing) {
      logger.warn({ channelId }, "Queue already being processed");
      return;
    }
    
    logger.debug({
      channelId,
      queueLength: channelQueue.queue.length
    }, "Starting queue processing");
    
    channelQueue.isProcessing = true;
    
    try {
      while (channelQueue.queue.length > 0) {
        const queuedMessage = channelQueue.queue[0];
        const startTime = Date.now();
        
        logger.debug({
          channelId,
          messageId: queuedMessage.message.id,
          queueLength: channelQueue.queue.length,
          queueTime: startTime - queuedMessage.timestamp
        }, "Processing queued message");
        
        await this.processQueuedMessage(channelId, queuedMessage, startTime);
        
        channelQueue.queue.shift();
        
        if (channelQueue.queue.length > 0) {
          logger.debug({
            channelId,
            remainingMessages: channelQueue.queue.length,
            delayMs: CONFIG.QUEUE.processingDelay
          }, "Waiting before processing next message");
          await new Promise(resolve => setTimeout(resolve, CONFIG.QUEUE.processingDelay));
        }
      }
    } catch (error) {
      logger.error({ 
        channelId, 
        error 
      }, "Error processing channel queue");
    } finally {
      channelQueue.isProcessing = false;
      logger.debug({
        channelId,
        remainingMessages: channelQueue.queue.length
      }, "Finished processing queue");
    }
  }

  /**
   * Processes a single queued message
   */
  private async processQueuedMessage(
    channelId: string, 
    queuedMessage: QueuedMessage, 
    startTime: number
  ): Promise<void> {
    try {
      const guildId = queuedMessage.message.guild?.id ?? "DM";
      const channelMessages = messageCacheService.getChannelMessages(guildId, channelId);
      const currentUsername = queuedMessage.message.member?.displayName ?? 
        queuedMessage.message.author.username;
      
      const aiMessages = messageCacheService.buildAIMessages(channelMessages, queuedMessage.message.id);
      
      if (queuedMessage.message.channel.type === ChannelType.GuildText) {
        await queuedMessage.message.channel.sendTyping();
      }

      const responseText = await groqService.generateResponse(aiMessages, currentUsername);
      const processedResponse = emojiService.processEmojiText(responseText);
      
      await queuedMessage.message.reply({
        content: processedResponse,
        failIfNotExists: false
      });

      const processingTime = Date.now() - startTime;
      logger.info({
        channelId,
        messageId: queuedMessage.message.id,
        processingTime,
        queueLength: this.getChannelQueue(channelId).queue.length - 1
      }, "Successfully processed queued message");
      
    } catch (error) {
      logger.error({ 
        channelId,
        messageId: queuedMessage.message.id, 
        error,
        processingTime: Date.now() - startTime
      }, "Error processing queued message");
      
      await this.handleProcessingError(queuedMessage, error, startTime);
    }
  }

  /**
   * Handles errors during message processing
   */
  private async handleProcessingError(
    queuedMessage: QueuedMessage, 
    error: unknown, 
    startTime: number
  ): Promise<void> {
    logger.error({ 
      channelId: queuedMessage.message.channel.id,
      messageId: queuedMessage.message.id, 
      error,
      processingTime: Date.now() - startTime
    }, "Error processing queued message");
    
    try {
      const username = queuedMessage.message.member?.displayName ?? 
        queuedMessage.message.author.username;
      await queuedMessage.message.reply({
        content: `Sorry ${username}, I encountered an error while processing your message.`,
        failIfNotExists: false
      });
    } catch (sendError) {
      logger.error({ 
        channelId: queuedMessage.message.channel.id,
        messageId: queuedMessage.message.id,
        sendError 
      }, "Failed to send error message to user");
    }
  }
}

export const messageQueueService = new MessageQueueService();