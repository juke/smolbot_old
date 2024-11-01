// src/index.ts

import { config } from 'dotenv';
import { Groq } from "groq-sdk";
import { Client, GatewayIntentBits, TextChannel, Message, Collection } from "discord.js";
import pino from "pino";
import { CachedMessage, AIMessage } from "./types";

// Initialize dotenv
config();

const logger = pino({
  level: 'debug',
  transport: {
    target: 'pino-pretty'
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

/**
 * Analyzes an image using Groq's vision API
 */
async function groqBriefAnalysis(imageUrl: string): Promise<string> {
  try {
    const completion = await groq.chat.completions.create({
      model: "llama-3.2-11b-vision-preview", // Using the vision-specific model
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

    logger.debug({ 
      imageUrl, 
      description: completion.choices[0]?.message?.content 
    }, "Image analysis completed");
    
    return completion.choices[0]?.message?.content ?? "No description available.";
  } catch (error) {
    logger.error({ imageUrl, error }, "Failed to analyze image");
    return "Failed to analyze image.";
  }
}

/**
 * Analyzes an image in detail when directly mentioned
 */
async function groqDetailedAnalysis(imageUrl: string): Promise<string> {
  try {
    const completion = await groq.chat.completions.create({
      model: "llama-3.2-90b-vision-preview", // Using the more powerful vision model for detailed analysis
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

    logger.debug({ 
      imageUrl, 
      detailedDescription: completion.choices[0]?.message?.content 
    }, "Detailed image analysis completed");
    
    return completion.choices[0]?.message?.content ?? "No detailed description available.";
  } catch (error) {
    logger.error({ imageUrl, error }, "Failed to perform detailed image analysis");
    return "Failed to analyze image in detail.";
  }
}

/**
 * Generates a response using the vision model when images are present
 */
async function generateResponse(contextMessages: AIMessage[]): Promise<string> {
  try {
    // Check if any of the messages contain image descriptions
    const hasImages = contextMessages.some(msg => 
      msg.content.includes("[Image Description:") || 
      msg.content.includes("[Referenced Image Description:")
    );

    // Always use text model for response generation, but include image context
    const completion = await groq.chat.completions.create({
      messages: [
        {
          role: "system",
          content: hasImages 
            ? "You are a helpful assistant responding to a conversation that includes image descriptions. Use these descriptions to provide relevant and contextual responses."
            : "You are a helpful assistant that responds to user questions."
        },
        ...contextMessages
      ],
      model: "mixtral-8x7b-32768",  // Always use text model for responses
      temperature: 0.7,
      max_tokens: 1024,
      top_p: 1
    });

    const response = completion.choices[0]?.message?.content ?? "I couldn't generate a response.";
    logger.debug({ 
      hasImages,
      contextLength: contextMessages.length,
      response 
    }, "Generated AI response");
    
    return response;
  } catch (error) {
    logger.error({ error }, "Failed to generate AI response");
    return "Sorry, I encountered an error while generating a response.";
  }
}

/**
 * Stores a message in the cache with all its context
 */
async function cacheMessage(message: Message): Promise<CachedMessage> {
  const guildId = message.guild?.id ?? "DM";
  const channelId = message.channel.id;

  // Initialize cache structures if they don't exist
  if (!messageCache.has(guildId)) {
    messageCache.set(guildId, new Map());
  }
  const guildCache = messageCache.get(guildId)!;
  if (!guildCache.has(channelId)) {
    guildCache.set(channelId, []);
  }

  // Process image attachments only if there are any
  const imageDescriptions: { brief: string; detailed?: string; }[] = [];
  const isBotMentioned = message.mentions.has(client.user!);
  
  if (message.attachments.size > 0) {
    logger.debug({ 
      messageId: message.id,
      attachmentCount: message.attachments.size 
    }, "Processing message with attachments");

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
            isBotMentioned,
            briefDescription,
            detailedDescription
          }, "Processed image attachment");
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

  // Update referenced message handling
  let referencedMessage;
  if (message.reference?.messageId) {
    try {
      const referenced = await message.channel.messages.fetch(message.reference.messageId);
      
      const referencedImageDescriptions: { brief: string; detailed?: string; }[] = [];
      if (referenced.attachments.size > 0) {
        for (const attachment of referenced.attachments.values()) {
          if (attachment.contentType?.startsWith("image/")) {
            try {
              const briefDescription = await groqBriefAnalysis(attachment.url);
              // Get detailed analysis when the referenced message contains images
              const detailedDescription = await groqDetailedAnalysis(attachment.url);
              referencedImageDescriptions.push({ 
                brief: briefDescription,
                detailed: detailedDescription
              });
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
        hasImages: referencedImageDescriptions.length > 0,
        imageDescriptions: referencedImageDescriptions
      }, "Processed referenced message with images");
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
    channelMessages.shift();
  }
  guildCache.set(channelId, channelMessages);

  return cachedMessage;
}

/**
 * Converts cached messages to AI-friendly format
 */
function buildAIMessages(messages: CachedMessage[], currentMessageId?: string): AIMessage[] {
  return messages.map((msg): AIMessage => {
    const contentParts = [msg.content];
    
    // Add image descriptions
    if (msg.imageDescriptions.length > 0) {
      msg.imageDescriptions.forEach(desc => {
        // Use detailed description only for the current message if it's being directly responded to
        if (msg.id === currentMessageId && desc.detailed) {
          contentParts.push(`[Image Description: ${desc.detailed}]`);
        } else {
          contentParts.push(`[Image Description: ${desc.brief}]`);
        }
      });
    }
    
    // Add referenced message with detailed image descriptions
    if (msg.referencedMessage) {
      contentParts.push(`[Referenced Message from ${msg.referencedMessage.authorDisplayName}: ${msg.referencedMessage.content}]`);
      if (msg.referencedMessage.imageDescriptions.length > 0) {
        msg.referencedMessage.imageDescriptions.forEach(desc => {
          // Use detailed description for referenced images when the message is being responded to
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
      name: msg.authorDisplayName,
      content: contentParts.join("\n"),
    };
  });
}

client.on('ready', () => {
  logger.info(`Logged in as ${client.user?.tag}!`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  try {
    const cachedMessage = await cacheMessage(message);
    
    const botId = client.user?.id;
    const mentioned = message.mentions.has(client.user!);
    const isReplyToBot = message.reference?.messageId
      ? (await message.channel.messages.fetch(message.reference.messageId))
          .author.id === botId
      : false;

    if (mentioned || isReplyToBot) {
      const guildId = message.guild?.id ?? "DM";
      const channelId = message.channel.id;
      const channelMessages = messageCache.get(guildId)?.get(channelId) ?? [];

      // Pass current message ID to buildAIMessages to use detailed descriptions
      const aiMessages = buildAIMessages(channelMessages, message.id);
      
      logger.debug({ 
        messageId: message.id,
        conversationContext: aiMessages 
      }, "Processing bot mention with conversation context");

      await message.channel.sendTyping();
      const responseText = await generateResponse(aiMessages);
      await message.channel.send(responseText);
    }
  } catch (error) {
    logger.error({ 
      messageId: message.id, 
      error 
    }, "Error processing message");
  }
});

// Log in to Discord
client.login(DISCORD_TOKEN);
