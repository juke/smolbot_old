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
async function generateResponse(contextMessages: AIMessage[], currentUsername: string): Promise<string> {
  try {
    const hasImages = contextMessages.some(msg => 
      msg.content.includes("[Image Description:") || 
      msg.content.includes("[Referenced Image Description:")
    );

    const completion = await groq.chat.completions.create({
      messages: [
        {
          role: "system",
          content: `You are SmolBot, a helpful Discord assistant. You are currently talking to ${currentUsername}. 
            Generate a response to ${currentUsername}'s message. Make sure to consider the previous messages in the conversation when generating your response.${
            hasImages 
              ? "The conversation includes image descriptions. Use these descriptions to provide relevant and contextual responses."
              : "Respond to the user's questions directly."
          } 
          The messages you receive will be formatted as [Username]: Message Content.
          Just respond naturally like you're a chatter in the Discord server. Keep your responses concise and to the point.
          Use lowercase for your responses and be casual. Don't include any other text in your responses, just your message to the user.
          Here's an example of how messages are formatted:
          --EXAMPLE--
          [User123]: Hey, check out this photo!
          [Image Description: A golden retriever puppy playing with a red ball in a sunny backyard]
          
          [SmolBot]: that's such a cute puppy! i love how happy they look playing with the ball
          [Referenced Message from User123: Hey, check out this photo!]
          [Referenced Image Description: A golden retriever puppy playing with a red ball in a sunny backyard]
          --EXAMPLE END--
          Each message includes the username in brackets, followed by their message.
          Image descriptions are added on new lines after the message.
          Referenced messages and their image descriptions are included with proper attribution.
          When you see <@1234567890> in a message, it's a "mention" of a different user, or even you.
          `
        },
        ...contextMessages,
        {
          role: "assistant",
          content: "[smolbotai]: "  // Prefill the assistant's response
        }
      ],
      model: "llama-3.2-90b-text-preview",
      temperature: 0.7,
      max_tokens: 1024,
      top_p: 1
    });

    const response = completion.choices[0]?.message?.content ?? 
      `I apologize ${currentUsername}, but I encountered an error while generating a response.`;
    
    // Prevent empty responses
    if (!response.trim()) {
      return `I apologize ${currentUsername}, but I couldn't generate a proper response. Could you please rephrase your question?`;
    }

    // Simply return everything after the prefill
    const cleanedResponse = response.includes("[smolbotai]: ") 
      ? response.split("[smolbotai]: ")[1] 
      : response;

    logger.debug({ 
      hasImages,
      contextLength: contextMessages.length,
      response: cleanedResponse,
      currentUsername
    }, "Generated AI response");
    
    return cleanedResponse || `I apologize ${currentUsername}, but I couldn't generate a proper response. Could you please rephrase your question?`;
  } catch (error) {
    logger.error({ error }, "Failed to generate AI response");
    return `Sorry ${currentUsername}, I encountered an error while generating a response.`;
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
    // Add the author's name to the start of the content
    const contentParts = [`[${msg.authorDisplayName}]: ${msg.content}`];
    
    // Add image descriptions
    if (msg.imageDescriptions.length > 0) {
      msg.imageDescriptions.forEach(desc => {
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

client.on('ready', () => {
  logger.info(`Logged in as ${client.user?.tag}!`);
});

client.on('messageCreate', async (message) => {
  try {
    // Ignore messages from the bot itself
    if (message.author.id === client.user?.id) {
      return;
    }

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

      const currentUsername = message.member?.displayName ?? message.author.username;

      logger.debug({ 
        messageId: message.id,
        authorId: message.author.id,
        username: currentUsername,
        displayName: message.member?.displayName,
        originalUsername: message.author.username
      }, "User identification debug");

      const aiMessages = buildAIMessages(channelMessages, message.id);
      
      logger.debug({ 
        messageId: message.id,
        username: currentUsername,
        messageContent: message.content,
        conversationContext: aiMessages 
      }, "Processing bot mention with conversation context");

      await message.channel.sendTyping();
      
      const responseText = await generateResponse(aiMessages, currentUsername);
      
      // Prevent sending empty messages
      if (!responseText.trim()) {
        await message.reply({
          content: `I apologize ${currentUsername}, but I couldn't generate a proper response. Could you please rephrase your question?`,
          failIfNotExists: false
        });
        return;
      }
      
      // Use reply instead of send
      await message.reply({
        content: responseText,
        failIfNotExists: false  // Prevents errors if the original message was deleted
      });
    }
  } catch (error) {
    logger.error({ 
      messageId: message.id, 
      error 
    }, "Error processing message");
    
    // Attempt to send an error message as a reply
    try {
      const username = message.member?.displayName ?? message.author.username;
      await message.reply({
        content: `Sorry ${username}, I encountered an error while processing your message.`,
        failIfNotExists: false
      });
    } catch (sendError) {
      logger.error({ sendError }, "Failed to send error message to user");
    }
  }
});

// Log in to Discord
client.login(DISCORD_TOKEN);
