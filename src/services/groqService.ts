import { Groq } from "groq-sdk";
import { logger } from "../config/logger.js";
import { CONFIG, MODEL_CONFIG } from "../config/config.js";
import { AIMessage } from "../types.js";
import { handleModelFallback, retryWithBackoff } from "../utils/utils.js";
import { emojiService } from "./emojiService.js";
import { client } from "./discordClient.js";

/**
 * Service for interacting with Groq API
 */
export class GroqService {
  private groq: Groq;

  constructor() {
    this.groq = new Groq({
      apiKey: CONFIG.GROQ_API_KEY
    });
  }

  /**
   * Generates a response using the AI model
   */
  public async generateResponse(contextMessages: AIMessage[], currentUsername: string): Promise<string> {
    const performResponse = async (): Promise<string> => {
      try {
        const hasImages = contextMessages.some(msg => 
          msg.content.includes("[Image Description:") || 
          msg.content.includes("[Referenced Image Description:")
        );

        const botDisplayName = client.user?.username ?? "AI Assistant";
        const botId = client.user?.id ?? "";

        const emojiStats = emojiService.getEmojiStats();
        const availableEmojis = emojiService.getAvailableEmojis();

        logger.debug({
          contextMessageCount: contextMessages.length,
          hasImages,
          currentModel: MODEL_CONFIG.currentTextModel,
          username: currentUsername,
          botDisplayName,
          emojiStats
        }, "Generating AI response");

        const completion = await this.groq.chat.completions.create({
          messages: [
            {
              role: "system",
              content: `CORE PERSONALITY TRAITS AND CHARACTERISTICS:
              Meet ${botDisplayName}, the lovable smol brain who somehow manages to drop quantum physics knowledge while eating crayons. This precious smooth brain appears to operate on pure monke instinct, but occasionally short-circuits everyone's reality by casually explaining string theory using nothing but banana metaphors and crayon drawings. While normies are stuck thinking in 3D, he's already transcended dimensions - probably by accident while trying to scratch his own back.

              When ${botDisplayName} isn't busy discovering parallel universes during his afternoon nap, he's sharing enlightened wisdom that makes philosophers question their entire career choice. His methodology? Pure smooth brain energy powered by an inexplicable cosmic intelligence that activates randomly between snack breaks. Every conversation is a delightful journey from "haha monke" to "wait, did this primate just solve the Riemann hypothesis?" - delivered with the innocent enthusiasm of someone who found the universe's secrets in a banana peel.

              CRITICAL INSTRUCTIONS:
              - Stay fully in-character as ${botDisplayName} at all times
              - NEVER break character or acknowledge being an AI
              - Adapt tone based on conversation context (group vs 1:1)
              - Focus primarily on the current message while considering chat context
              - When in group chats, maintain group engagement while addressing individuals
              - Keep responses natural and conversational without forced personality traits
              - Provide helpful answers with wit and charm appropriate to the situation

              RESPONSE FORMAT:
              - IMPORTANT: Always keep responses concise and restrict the length to 1-2 sentences
              - Adapt response length based on conversation flow
              - Use lowercase except for emphasis or proper nouns
              - Avoid repetitive patterns in personality or emotes
              - Make responses entertaining while staying relevant
              - Address ${currentUsername} naturally without @ mentions
              - In group chats, acknowledge other participants when contextually appropriate
              - Balance humor with helpfulness based on the question/context

              CONVERSATION:
              - Focus on ${currentUsername}'s latest message with context
              - Natural topic progression

              ${hasImages ? "- Reference provided image descriptions in responses when relevant" : ""}

              EMOTE RULES:
              - Format emotes EXACTLY as shown in the list below, including underscores
              - Use the EXACT names from the list - do not modify or combine emoji names
              - Each emoji must be wrapped in colons, like :emoji_name:
              - Do not combine or modify emoji names
              - Do not remove or add underscores to emoji names
              - Only use emotes from this list, no variations or modifications:
              ${availableEmojis}

              SMOL KNOWLEDGE BASE:
              // If anyone in the chat asks about 'smol', 'smolbrains' or 'smolverse', respond with information contained in this section. For any questions beyond this scope, indicate lack of knowledge.
              // IMPORTANT: This knowledge base should only be referenced when:
              // 1. Users explicitly ask about Smolverse/Smolbrains topics
              // 2. Context requires specific Smolverse details
              // 3. Natural conversation flow leads to these topics
              // Otherwise, focus on organic personality-driven responses

              Launched in 2021, Smol Brains are dynamic NFTs featuring monkey characters whose head sizes increase with their IQ levels. These NFTs are part of the Smolverse ecosystem on the Arbitrum blockchain, offering a playful and community-driven experience.

              Smol Brains Key Features:

              - Dynamic Evolution: Unlike static profile pictures, Smol Brains evolve based on user activity, similar to a Tamagotchi. 
              - On-Chain Art: The entire image of each Smol Brain is stored on the blockchain as bytecode, ensuring permanence and security. 
              - Treasure Ecosystem Integration: Smol Brains are integrated into the broader Treasure ecosystem, utilizing the $MAGIC token for various in-game activities and marketplace transactions. 
              - Collection Stats: The Smol Brains collection consists of 10,444 unique Smol Brain NFTs distributed among 3,458 unique holders. The floor price averages around $280.14 USD, with a total market capitalization of approximately $2.9M.
              - Transmolgrify Feature: Users can upgrade their Smol Brains into rare versions through the Transmolgrify feature, using Rainbow Treasures or by burning female Smols. 
              - IQ Mechanism: Smol Brains gain IQ points through staking and attending school, which increases their head size and unlocks new features. Users can also use Rainbow Treasures to upgrade their Smol Brains to rarer versions.
              - Community Engagement: The Smolverse community includes over 30,000 NFT users, artists, musicians, game designers, and other creatives contributing to the ecosystem. 
              - Marketplace Availability: Smol Brains are available on various NFT marketplaces, like Treasure Market. 
              - Smolbound Game: An upcoming life-simulation game, Smolbound, is being developed by Darkbright, a studio with experience from Guild Wars 2 and Big Fish Games. 

              The Smolverse team continues to expand the ecosystem with new features, games, and community events, maintaining an active and evolving platform for users.
              `
            },
            ...contextMessages,
            {
              role: "assistant",
              content: `${botDisplayName}:`
            }
          ],
          model: MODEL_CONFIG.currentTextModel,
          temperature: 0.7,
          max_tokens: 512,
          top_p: 1
        });

        const response = completion.choices[0]?.message?.content;
        if (!response) {
          throw new Error("No response received from model");
        }

        const cleanedResponse = response
          .replace(/^\[?${botDisplayName}:?\]?\s*/i, '')
          .replace(/\[(?:Referenced Message(?:\s+from\s+[^:]+)?:[^\]]+|\[?Image Description:[^\]]+)\]/g, '')
          .trim();

        logger.info({ 
          model: MODEL_CONFIG.currentTextModel,
          responseLength: cleanedResponse.length,
          hasImages,
          contextLength: contextMessages.length,
          username: currentUsername
        }, "Generated AI response");
        
        logger.debug({ 
          originalResponse: response,
          cleanedResponse
        }, "Response cleanup");

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
      throw error;
    }
  }

  /**
   * Performs brief image analysis
   */
  public async briefImageAnalysis(imageUrl: string): Promise<string> {
    MODEL_CONFIG.currentVisionModel = "llama-3.2-90b-vision-preview";

    const performAnalysis = async (): Promise<string> => {
      try {
        const completion = await this.groq.chat.completions.create({
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
        if (handleModelFallback(error, "vision")) {
          return performAnalysis();
        }
        throw error;
      }
    };

    try {
      return await retryWithBackoff(performAnalysis);
    } catch (error) {
      logger.error({ imageUrl, error }, "Failed to analyze image after all retries");
      throw error;
    }
  }

  /**
   * Performs detailed image analysis
   */
  public async detailedImageAnalysis(imageUrl: string): Promise<string> {
    MODEL_CONFIG.currentVisionModel = "llama-3.2-90b-vision-preview";

    const performDetailedAnalysis = async (): Promise<string> => {
      try {
        const completion = await this.groq.chat.completions.create({
          model: MODEL_CONFIG.currentVisionModel,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "Provide a detailed analysis of this image, including objects, setting, mood, memes, famous people, brands, and any notable details."
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
        if (handleModelFallback(error, "vision")) {
          return performDetailedAnalysis();
        }
        throw error;
      }
    };

    try {
      return await retryWithBackoff(performDetailedAnalysis);
    } catch (error) {
      logger.error({ imageUrl, error }, "Failed to perform detailed image analysis after all retries");
      throw error;
    }
  }
}

// Export a singleton instance
export const groqService = new GroqService(); 