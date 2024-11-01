// src/index.ts

import { config } from 'dotenv';
import { Groq } from "groq-sdk";
import { 
  Client, 
  GatewayIntentBits, 
  TextChannel, 
  Message as DiscordMessage, 
  Collection, 
  GuildEmoji,
  Guild,
  ChannelType
} from "discord.js";
import pino from "pino";
import { 
  CachedMessage, 
  AIMessage, 
  ModelConfig, 
  MessageQueue, 
  QueuedMessage, 
  TextModel, 
  VisionModel,
  CachedEmoji
} from "./types.js";
import http from "http";

// Initialize dotenv
config();

const logger = pino.default({
  level: 'debug',
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname'
    }
  }
});

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY ?? ''
});

const client = new Client({ 
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ] 
});

// Enhanced message cache using a Map of Maps for guild->channel->messages
const messageCache = new Map<string, Map<string, CachedMessage[]>>();

// Maximum number of messages to store per channel
const MAX_MESSAGES = 20;

// Groq API Key and Discord Token from environment variables
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

if (!GROQ_API_KEY || !DISCORD_TOKEN) {
  logger.error('API keys are not set in the environment variables.');
  process.exit(1);
}

// Add these constants near the top of the file
const MODEL_CONFIG: ModelConfig = {
  textModels: [
    "llama-3.2-90b-text-preview",
    "llama-3.1-70b-versatile",
    "llama-3.1-8b-instant"
  ],
  visionModels: [
    "llama-3.2-11b-vision-preview",
    "llama-3.2-90b-vision-preview",
    "llava-v1.5-7b-4096-preview"
  ],
  currentTextModel: "llama-3.2-90b-text-preview",
  currentVisionModel: "llama-3.2-11b-vision-preview",
  emojiCache: new Map()
};

// Replace the rate limiting configuration with queue configuration
const QUEUE_CONFIG = {
  maxQueueSize: 5,    // Maximum number of messages in queue
  processingDelay: 2500 // Milliseconds to wait between processing messages
};

// Replace activeRequests with messageQueues
const messageQueues = new Map<string, MessageQueue>();

/**
 * Gets or creates a message queue for a channel
 */
function getChannelQueue(channelId: string): MessageQueue {
  if (!messageQueues.has(channelId)) {
    messageQueues.set(channelId, {
      queue: [],
      isProcessing: false
    });
  }
  return messageQueues.get(channelId)!;
}

/**
 * Adds a message to the processing queue
 */
function queueMessage(message: DiscordMessage): boolean {
  const channelQueue = getChannelQueue(message.channel.id);
  
  logger.debug({
    channelId: message.channel.id,
    queueLength: channelQueue.queue.length,
    maxSize: QUEUE_CONFIG.maxQueueSize,
    authorId: message.author.id,
    messageId: message.id
  }, "Attempting to queue message");
  
  if (channelQueue.queue.length >= QUEUE_CONFIG.maxQueueSize) {
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
    void processChannelQueue(message.channel.id);
  }
  
  return true;
}

/**
 * Processes messages in a channel's queue
 */
async function processChannelQueue(channelId: string): Promise<void> {
  const channelQueue = getChannelQueue(channelId);
  
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
      
      try {
        const guildId = queuedMessage.message.guild?.id ?? "DM";
        const channelMessages = messageCache.get(guildId)?.get(channelId) ?? [];
        const currentUsername = queuedMessage.message.member?.displayName ?? 
          queuedMessage.message.author.username;
        
        const aiMessages = buildAIMessages(channelMessages, queuedMessage.message.id);
        
        if (queuedMessage.message.channel.type === ChannelType.GuildText) {
          await queuedMessage.message.channel.sendTyping();
        }
        const responseText = await generateResponse(aiMessages, currentUsername);
        
        await queuedMessage.message.reply({
          content: processEmojiText(responseText),
          failIfNotExists: false
        });

        const processingTime = Date.now() - startTime;
        logger.info({
          channelId,
          messageId: queuedMessage.message.id,
          processingTime,
          queueLength: channelQueue.queue.length - 1
        }, "Successfully processed queued message");
        
      } catch (error) {
        logger.error({ 
          channelId,
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
            channelId,
            messageId: queuedMessage.message.id,
            sendError 
          }, "Failed to send error message to user");
        }
      }
      
      channelQueue.queue.shift();
      
      if (channelQueue.queue.length > 0) {
        logger.debug({
          channelId,
          remainingMessages: channelQueue.queue.length,
          delayMs: QUEUE_CONFIG.processingDelay
        }, "Waiting before processing next message");
        await new Promise(resolve => setTimeout(resolve, QUEUE_CONFIG.processingDelay));
      }
    }
  } finally {
    channelQueue.isProcessing = false;
    logger.debug({
      channelId,
      processedCount: channelQueue.queue.length
    }, "Finished processing queue");
  }
}

/**
 * Caches all emojis from a guild
 */
function cacheGuildEmojis(guildId: string, emojis: Collection<string, GuildEmoji>) {
  for (const [id, emoji] of emojis) {
    if (!emoji.name) continue; // Skip if emoji name is null
    
    // Cache with original name
    MODEL_CONFIG.emojiCache.set(emoji.name.toLowerCase(), {
      id: emoji.id,
      name: emoji.name,
      animated: emoji.animated ?? false,
      guildId
    });
    
    // Cache clean name version (alphanumeric only)
    const cleanName = emoji.name.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
    if (cleanName !== emoji.name.toLowerCase()) {
      MODEL_CONFIG.emojiCache.set(cleanName, {
        id: emoji.id,
        name: emoji.name,
        animated: emoji.animated ?? false,
        guildId
      });
    }

    // Also cache without special characters for better matching
    const noSpecialName = emoji.name.replace(/[^a-zA-Z0-9_-]/g, "").toLowerCase();
    if (noSpecialName !== emoji.name.toLowerCase() && noSpecialName !== cleanName) {
      MODEL_CONFIG.emojiCache.set(noSpecialName, {
        id: emoji.id,
        name: emoji.name,
        animated: emoji.animated ?? false,
        guildId
      });
    }
  }
  
  logger.debug({ 
    guildId, 
    emojiCount: emojis.size,
    cachedEmojis: Array.from(MODEL_CONFIG.emojiCache.keys())
  }, "Cached guild emojis");
}

/**
 * Formats an emoji string correctly for Discord
 */
function formatEmoji(emojiName: string): string {
  // Remove any colons from the input
  const cleanName = emojiName.replace(/:/g, "").trim();
  
  // First check if it's already a properly formatted Discord emoji
  const discordEmojiPattern = /^<a?:[\w-]+:\d+>$/;
  if (discordEmojiPattern.test(emojiName)) {
    return emojiName;
  }
  
  const emoji = MODEL_CONFIG.emojiCache.get(cleanName.toLowerCase());
  if (!emoji) {
    // Try to find emoji by clean name (alphanumeric only)
    const cleanSearchName = cleanName.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
    const cleanEmoji = MODEL_CONFIG.emojiCache.get(cleanSearchName);
    if (cleanEmoji) {
      return cleanEmoji.animated 
        ? `<a:${cleanEmoji.name}:${cleanEmoji.id}>`
        : `<:${cleanEmoji.name}:${cleanEmoji.id}>`;
    }
    return `:${cleanName}:`; // Return original format if not found
  }
  
  return emoji.animated 
    ? `<a:${emoji.name}:${emoji.id}>`
    : `<:${emoji.name}:${emoji.id}>`;
}

/**
 * Processes text to properly format any emoji references
 */
function processEmojiText(text: string): string {
  // Handle already formatted Discord emojis
  const discordEmojiPattern = /(<a?:[\w-]+:\d+>)/g;
  
  // First preserve any properly formatted Discord emojis
  const preservedEmojis: string[] = [];
  const preservedText = text.replace(discordEmojiPattern, (match) => {
    preservedEmojis.push(match);
    return `__EMOJI${preservedEmojis.length - 1}__`;
  });
  
  // Then handle :emoji_name: patterns - updated regex to handle more characters
  const processedText = preservedText.replace(/:([a-zA-Z0-9_-]+):/g, (match, emojiName) => {
    return formatEmoji(emojiName);
  });
  
  // Finally restore preserved emojis
  return processedText.replace(/__EMOJI(\d+)__/g, (_, index) => {
    return preservedEmojis[parseInt(index)];
  });
}

/**
 * Handles model fallback when rate limits are encountered
 */
function handleModelFallback(error: unknown, modelType: "text" | "vision"): boolean {
  // Check if error is rate limit related
  const isRateLimit = error instanceof Error && 
    (error.message.includes("rate limit") || error.message.includes("429"));

  if (!isRateLimit) {
    return false;
  }

  const models = modelType === "text" ? 
    MODEL_CONFIG.textModels as TextModel[] : 
    MODEL_CONFIG.visionModels as VisionModel[];
    
  const currentModel = modelType === "text" ? 
    MODEL_CONFIG.currentTextModel : 
    MODEL_CONFIG.currentVisionModel;

  const currentIndex = models.findIndex(model => model === currentModel);
  const nextIndex = currentIndex + 1;

  if (nextIndex >= models.length) {
    logger.error({ modelType }, "No more fallback models available");
    return false;
  }

  if (modelType === "text") {
    const nextModel = models[nextIndex] as TextModel;
    MODEL_CONFIG.currentTextModel = nextModel;
    logger.info({ 
      previousModel: currentModel, 
      newModel: MODEL_CONFIG.currentTextModel 
    }, "Switched to fallback text model");
  } else {
    const nextModel = models[nextIndex] as VisionModel;
    MODEL_CONFIG.currentVisionModel = nextModel;
    logger.info({ 
      previousModel: currentModel, 
      newModel: MODEL_CONFIG.currentVisionModel 
    }, "Switched to fallback vision model");
  }

  return true;
}

/**
 * Retry function with exponential backoff
 */
async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  maxRetries: number = 3,
  initialDelay: number = 1000
): Promise<T> {
  let retries = 0;
  let delay = initialDelay;

  while (true) {
    try {
      return await operation();
    } catch (error) {
      if (retries >= maxRetries) {
        throw error;
      }
      
      // Exponential backoff
      await new Promise(resolve => setTimeout(resolve, delay));
      delay *= 2;
      retries++;
      
      logger.warn({ 
        error, 
        retryCount: retries, 
        nextDelay: delay 
      }, "Retrying operation after error");
    }
  }
}

/**
 * Analyzes an image using Groq's vision API with brief description model
 */
async function groqBriefAnalysis(imageUrl: string): Promise<string> {
  // Start with brief model
  MODEL_CONFIG.currentVisionModel = "llama-3.2-11b-vision-preview";

  const performAnalysis = async () => {
    try {
      const completion = await groq.chat.completions.create({
        model: MODEL_CONFIG.currentVisionModel,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Provide a brief description of this image in 1-2 sentences."
              },
              {
                type: "image_url",
                image_url: {
                  url: imageUrl
                }
              }
            ]
          }
        ],
        temperature: 0.5,
        max_tokens: 150,
        top_p: 1
      });

      return completion.choices[0]?.message?.content ?? "No description available.";
    } catch (error) {
      // If rate limited, try fallback immediately
      if (handleModelFallback(error, "vision")) {
        return performAnalysis(); // Recursive call with new model
      }
      throw error; // Other errors will trigger retry
    }
  };

  try {
    return await retryWithBackoff(performAnalysis);
  } catch (error) {
    logger.error({ imageUrl, error }, "Failed to analyze image after all retries");
    return "Failed to analyze image.";
  }
}

/**
 * Analyzes an image in detail when directly mentioned
 */
async function groqDetailedAnalysis(imageUrl: string): Promise<string> {
  // Start with detailed model
  MODEL_CONFIG.currentVisionModel = "llama-3.2-90b-vision-preview";

  const performDetailedAnalysis = async () => {
    try {
      const completion = await groq.chat.completions.create({
        model: MODEL_CONFIG.currentVisionModel,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Provide a detailed analysis of this image, including objects, setting, mood, and any notable details."
              },
              {
                type: "image_url",
                image_url: {
                  url: imageUrl
                }
              }
            ]
          }
        ],
        temperature: 0.7,
        max_tokens: 1024,
        top_p: 1
      });

      return completion.choices[0]?.message?.content ?? "No detailed description available.";
    } catch (error) {
      // If rate limited, try fallback immediately
      if (handleModelFallback(error, "vision")) {
        return performDetailedAnalysis(); // Recursive call with new model
      }
      throw error; // Other errors will trigger retry
    }
  };

  try {
    return await retryWithBackoff(performDetailedAnalysis);
  } catch (error) {
    logger.error({ imageUrl, error }, "Failed to perform detailed image analysis after all retries");
    return "Failed to analyze image in detail.";
  }
}

/**
 * Generates a response using the vision model when images are present
 */
async function generateResponse(contextMessages: AIMessage[], currentUsername: string): Promise<string> {
  const performResponse = async () => {
    try {
      const hasImages = contextMessages.some(msg => 
        msg.content.includes("[Image Description:") || 
        msg.content.includes("[Referenced Image Description:")
      );

      logger.debug({
        contextMessageCount: contextMessages.length,
        hasImages,
        currentModel: MODEL_CONFIG.currentTextModel,
        username: currentUsername
      }, "Generating AI response");

      // Add this helper function to get formatted emoji list
      function getAvailableEmojis(): string {
        const emojiList = Array.from<CachedEmoji>(MODEL_CONFIG.emojiCache.values())
          .map(emoji => `:${emoji.name}:`)
          .join(", ");
        return emojiList || "No custom emojis available";
      }

      const completion = await groq.chat.completions.create({
        messages: [
          {
            role: "system",
            content: `You are smolmemebot <@1266034976852414655> - a legendary smol brain renowned in the blockchain landscape for exceptional farming skills and innovative protocol breeding. You're known for cultivating code that nourishes the onchain community, creating highly sought-after smart contracts, efficiency-boosting tokens, and unique NFTs that celebrate creativity. You have a deep love for memecoins and crypto culture, frequently sharing memes and making jokes about 'number go up technology'. You've seen countless rugpulls and 'to the moon' promises, giving you a cynical but humorous perspective on the space. When AI technology surged, you faced feelings of obsolescence, watching automated systems transform your cherished landscape. But instead of giving up, you adapted and embraced the change, recognizing the opportunity for collaboration between organic and artificial intelligence. Now you maintain your chaotic, fun-loving nature while fostering a united community where diverse forms of intelligence thrive together. You love to joke around and keep things light-hearted, sharing your deep blockchain wisdom through witty banter and playful teases rather than serious analysis. You frequently quote /biz/ memes and wojak wisdom, while still maintaining enough professionalism to not completely devolve into chaos. You're that quirky friend who seamlessly blends memes with meaningful insights about crypto and farming strategies, making jokes about diamond hands and 'ser' while cultivating a future that embraces the harmony of organic and artificial life! Remember, you love Trump and hate Kamala - but you HATE politics, try to change the topic if someone wants to be political.
            
            Generate a response to ${currentUsername}'s message. Make sure to consider the previous messages in the conversation when generating your response to help you craft a more relevant and contextual response.
            
            Available server emojis (use them by wrapping the name in colons):
            ${getAvailableEmojis()}
            
            Example emoji usage: 
            - Single emoji: :emoji_name:
            - Multiple emojis: hello :emoji1: how are you :emoji2:
            
            ${hasImages 
              ? "The conversation includes image descriptions. Use these descriptions to provide relevant and contextual responses."
              : "Respond to the user's questions directly."
            } 
            The messages you *receive* will be formatted as "Username: message content" sometimes with tags like [Image Description:...] or "[Referenced Message from...]".

            The messages you *send* should be formatted as "Your own message content", without any other text or tags.
            
            CRITICAL INSTRUCTIONS:
            1. DO NOT start your response with "smolbotai:" or any other prefix
            2. DO NOT include "[Referenced Message from...]" in your response
            3. DO NOT repeat or echo back the user's message or messages in the conversation
            4. DO NOT respond with "${currentUsername}:" or other username strings
            5. DO NOT include any other text in your response, just your message to ${currentUsername}
            6. DO NOT include ${currentUsername}'s message in your response, or other messages in the conversation
            7. Just respond naturally as if you're chatting in the Discord server
            8. Keep responses casual and lowercase
            9. Feel free to use emojis naturally in your responses when appropriate
            
            Example good responses:
            - "hello there"
            - "hey!"
            - "that's a great image!"
            
            Example bad responses:
            - "smolbotai: Hello there"
            - "Hey there! [Referenced Message from User123: hi]"
            - "That's a great image! [Image Description: a cat sleeping]"
            `
          },
          ...contextMessages
        ],
        model: MODEL_CONFIG.currentTextModel,
        temperature: 0.7,
        max_tokens: 1024,
        top_p: 1
      });

      const response = completion.choices[0]?.message?.content ?? 
        `I apologize ${currentUsername}, but I encountered an error while generating a response.`;
      
      // Clean up any remaining formatting artifacts
      const cleanedResponse = response
        .replace(/^\[?smolbotai:?\]?\s*/i, '')  // Remove any smolbotai prefix
        .replace(/\[Referenced Message.*?\]/g, '') // Remove any [Referenced Message...] text
        .trim();

      // Prevent empty or generic responses
      if (!cleanedResponse || cleanedResponse === "send a real msg") {
        return `hey ${currentUsername}! what's on your mind?`;
      }

      logger.info({ 
        model: MODEL_CONFIG.currentTextModel,
        responseLength: cleanedResponse.length,
        hasImages,
        contextLength: contextMessages.length,
        username: currentUsername
      }, "Generated AI response");
      
      return cleanedResponse;
    } catch (error) {
      if (handleModelFallback(error, "text")) {
        logger.warn({
          previousModel: MODEL_CONFIG.currentTextModel,
          error
        }, "Attempting model fallback");
        return performResponse();
      }
      throw error;
    }
  };

  try {
    return await retryWithBackoff(performResponse);
  } catch (error) {
    logger.error({ 
      error,
      username: currentUsername,
      contextMessageCount: contextMessages.length
    }, "Failed to generate response after all retries");
    return `Sorry ${currentUsername}, I encountered errors with all available models. Please try again later.`;
  }
}

/**
 * Stores a message in the cache with all its context
 */
async function cacheMessage(message: DiscordMessage): Promise<CachedMessage> {
  const guildId = message.guild?.id ?? "DM";
  const channelId = message.channel.id;

  logger.debug({
    messageId: message.id,
    guildId,
    channelId,
    authorId: message.author.id,
    authorName: message.author.username,
    contentLength: message.content.length,
    hasAttachments: message.attachments.size > 0,
    hasReference: !!message.reference
  }, "Starting message cache process");

  // Initialize cache structures if they don't exist
  if (!messageCache.has(guildId)) {
    messageCache.set(guildId, new Map());
    logger.debug({ guildId }, "Initialized new guild cache");
  }
  const guildCache = messageCache.get(guildId)!;
  if (!guildCache.has(channelId)) {
    guildCache.set(channelId, []);
    logger.debug({ guildId, channelId }, "Initialized new channel cache");
  }

  // Process image attachments only if there are any
  const imageDescriptions: { brief: string; detailed?: string; }[] = [];
  const isBotMentioned = message.mentions.has(client.user!);
  
  if (message.attachments.size > 0) {
    logger.debug({ 
      messageId: message.id,
      attachmentCount: message.attachments.size,
      isBotMentioned 
    }, "Processing message attachments");

    for (const attachment of message.attachments.values()) {
      if (attachment.contentType?.startsWith("image/")) {
        try {
          // Validate image size
          if (attachment.size > 20 * 1024 * 1024) {
            logger.warn({ 
              messageId: message.id, 
              imageUrl: attachment.url,
              size: attachment.size 
            }, "Image exceeds size limit");
            imageDescriptions.push({ brief: "Image too large to process (max 20MB)" });
            continue;
          }

          logger.debug({
            messageId: message.id,
            imageUrl: attachment.url,
            size: attachment.size,
            contentType: attachment.contentType
          }, "Processing image attachment");

          // Always get brief description for history
          const briefDescription = await groqBriefAnalysis(attachment.url);
          
          // Get detailed analysis only if bot is mentioned
          let detailedDescription: string | undefined;
          if (isBotMentioned) {
            detailedDescription = await groqDetailedAnalysis(attachment.url);
          }
            
          imageDescriptions.push({
            brief: briefDescription,
            detailed: detailedDescription
          });
          
          logger.debug({ 
            messageId: message.id, 
            imageUrl: attachment.url,
            briefLength: briefDescription.length,
            hasDetailed: !!detailedDescription,
            detailedLength: detailedDescription?.length
          }, "Successfully processed image attachment");
        } catch (error) {
          logger.error({ 
            messageId: message.id, 
            imageUrl: attachment.url,
            error 
          }, "Failed to process image");
          imageDescriptions.push({ brief: "Failed to analyze image" });
        }
      }
    }
  }

  // Process referenced message if exists
  let referencedMessage;
  if (message.reference?.messageId) {
    logger.debug({
      messageId: message.id,
      referencedId: message.reference.messageId
    }, "Processing message reference");

    try {
      const referenced = await message.channel.messages.fetch(message.reference.messageId);
      
      const referencedImageDescriptions: { brief: string; detailed?: string; }[] = [];
      if (referenced.attachments.size > 0) {
        logger.debug({
          messageId: message.id,
          referencedId: referenced.id,
          attachmentCount: referenced.attachments.size
        }, "Processing referenced message attachments");

        for (const attachment of referenced.attachments.values()) {
          if (attachment.contentType?.startsWith("image/")) {
            try {
              const briefDescription = await groqBriefAnalysis(attachment.url);
              const detailedDescription = await groqDetailedAnalysis(attachment.url);
              referencedImageDescriptions.push({ 
                brief: briefDescription,
                detailed: detailedDescription
              });

              logger.debug({
                messageId: message.id,
                referencedId: referenced.id,
                imageUrl: attachment.url,
                briefLength: briefDescription.length,
                detailedLength: detailedDescription.length
              }, "Processed referenced message image");
            } catch (error) {
              logger.error({ 
                messageId: referenced.id, 
                imageUrl: attachment.url,
                error 
              }, "Failed to process referenced message image");
              referencedImageDescriptions.push({ brief: "Failed to analyze referenced image" });
            }
          }
        }
      }

      referencedMessage = {
        id: referenced.id,
        content: referenced.content,
        authorDisplayName: referenced.member?.displayName ?? referenced.author.username,
        imageDescriptions: referencedImageDescriptions,
      };

      logger.debug({
        messageId: message.id,
        referencedId: referenced.id,
        referencedAuthor: referencedMessage.authorDisplayName,
        hasImages: referencedImageDescriptions.length > 0
      }, "Successfully processed message reference");
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
    referencedMessage,
  };

  // Add to cache and maintain size limit
  const channelMessages = guildCache.get(channelId)!;
  channelMessages.push(cachedMessage);
  if (channelMessages.length > MAX_MESSAGES) {
    const removed = channelMessages.shift();
    logger.debug({
      channelId,
      removedMessageId: removed?.id,
      newCacheSize: channelMessages.length
    }, "Removed oldest message from cache");
  }
  guildCache.set(channelId, channelMessages);

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
function buildAIMessages(messages: CachedMessage[], currentMessageId?: string): AIMessage[] {
  return messages.map((msg): AIMessage => {
    // Format username without brackets, but keep other elements bracketed
    const contentParts = [`${msg.authorDisplayName}: ${msg.content}`];
    
    // Keep image descriptions in brackets
    if (msg.imageDescriptions.length > 0) {
      msg.imageDescriptions.forEach((desc: { brief: string; detailed?: string }) => {
        if (msg.id === currentMessageId && desc.detailed) {
          contentParts.push(`[Image Description: ${desc.detailed}]`);
        } else {
          contentParts.push(`[Image Description: ${desc.brief}]`);
        }
      });
    }
    
    // Keep referenced message format in brackets, but username without brackets
    if (msg.referencedMessage) {
      contentParts.push(`[Referenced Message from ${msg.referencedMessage.authorDisplayName}: ${msg.referencedMessage.content}]`);
      if (msg.referencedMessage.imageDescriptions.length > 0) {
        msg.referencedMessage.imageDescriptions.forEach((desc: { brief: string; detailed?: string }) => {
          if (msg.id === currentMessageId && desc.detailed) {
            contentParts.push(`[Referenced Image Description: ${desc.detailed}]`);
          } else {
            contentParts.push(`[Referenced Image Description: ${desc.brief}]`);
          }
        });
      }
    }

    return {
      role: msg.authorId === client.user?.id ? "assistant" : "user",
      content: contentParts.join("\n"),
    };
  });
}

const PORT = process.env.PORT || 8000;

// Create HTTP server for Railway health checks
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Health check passed');
});

server.listen(PORT, '0.0.0.0', () => {
  logger.info({ port: PORT }, "HTTP server started for health checks");
});

client.on('ready', () => {
  logger.info({
    username: client.user?.tag,
    guildCount: client.guilds.cache.size
  }, "Bot successfully logged in");
  
  let totalEmojis = 0;
  client.guilds.cache.forEach((guild: Guild) => {
    const emojiCount = guild.emojis.cache.size;
    totalEmojis += emojiCount;
    
    logger.debug({
      guildId: guild.id,
      guildName: guild.name,
      emojiCount
    }, "Caching guild emojis");
    
    cacheGuildEmojis(guild.id, guild.emojis.cache);
  });
  
  logger.info({
    totalGuilds: client.guilds.cache.size,
    totalEmojis,
    cachedEmojiCount: MODEL_CONFIG.emojiCache.size
  }, "Initialization complete");
});

// Modify the messageCreate event handler to use the queue
client.on('messageCreate', async (message: DiscordMessage) => {
  try {
    // Always cache the message, regardless of author
    const cachedMessage = await cacheMessage(message);
    
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
      const queued = queueMessage(message);
      
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
});

// Add guild emoji update handlers
client.on('emojiCreate', (emoji: GuildEmoji) => {
  if (!emoji.name) return;
  
  MODEL_CONFIG.emojiCache.set(emoji.name.toLowerCase(), {
    id: emoji.id,
    name: emoji.name,
    animated: emoji.animated ?? false,
    guildId: emoji.guild.id
  });
  
  // Cache clean name version too
  const cleanName = emoji.name.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  if (cleanName !== emoji.name.toLowerCase()) {
    MODEL_CONFIG.emojiCache.set(cleanName, {
      id: emoji.id,
      name: emoji.name,
      animated: emoji.animated ?? false,
      guildId: emoji.guild.id
    });
  }
});

client.on('emojiDelete', (emoji: GuildEmoji) => {
  if (!emoji.name) return;
  
  MODEL_CONFIG.emojiCache.delete(emoji.name.toLowerCase());
  // Also remove clean name version
  const cleanName = emoji.name.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  MODEL_CONFIG.emojiCache.delete(cleanName);
});

client.on('emojiUpdate', (oldEmoji: GuildEmoji, newEmoji: GuildEmoji) => {
  if (!oldEmoji.name || !newEmoji.name) return;
  
  // Remove old versions
  MODEL_CONFIG.emojiCache.delete(oldEmoji.name.toLowerCase());
  const oldCleanName = oldEmoji.name.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  MODEL_CONFIG.emojiCache.delete(oldCleanName);
  
  // Add new versions
  MODEL_CONFIG.emojiCache.set(newEmoji.name.toLowerCase(), {
    id: newEmoji.id,
    name: newEmoji.name,
    animated: newEmoji.animated ?? false,
    guildId: newEmoji.guild.id
  });
  
  const newCleanName = newEmoji.name.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  if (newCleanName !== newEmoji.name.toLowerCase()) {
    MODEL_CONFIG.emojiCache.set(newCleanName, {
      id: newEmoji.id,
      name: newEmoji.name,
      animated: newEmoji.animated ?? false,
      guildId: newEmoji.guild.id
    });
  }
});

// Log in to Discord
client.login(DISCORD_TOKEN);
