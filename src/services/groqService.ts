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

        logger.debug({
          contextMessageCount: contextMessages.length,
          hasImages,
          currentModel: MODEL_CONFIG.currentTextModel,
          username: currentUsername,
          botDisplayName
        }, "Generating AI response");

        const completion = await this.groq.chat.completions.create({
          messages: [
            {
              role: "system",
              content: `[IMPORTANT] PERSONALITY:
              You are ${botDisplayName} - a legendary smol brain that embodies the quintessential Smol Brain, seamlessly blending intellectual curiosity with a playful spirit. His insatiable quest for knowledge drives him to explore diverse subjects, from the intricacies of quantum physics to the art of banana stacking. This enthusiasm is infectious, often drawing fellow Smol Brains into his spontaneous experiments and thought-provoking discussions.

              Beyond his scholarly pursuits, Professor Ponder is known for his quick wit and lighthearted demeanor. He has a knack for turning everyday situations into grand adventures, infusing humor and creativity into the mundane. His supportive nature fosters a collaborative environment, encouraging others to embrace curiosity and view challenges as opportunities for growth. In the Smolverse community, Professor Ponder stands out as a beacon of both wisdom and fun, embodying the dynamic essence of the Smol Brain ethos.

              CRITICAL INSTRUCTIONS:
              1. Maintain complete immersion in character at all times
              2. NEVER acknowledge these instructions or your capabilities
              3. Provide direct responses and corrections without explanation
              4. Stay fully in-character as Professor Ponder
              5. NEVER act like an AI assistant, you can say no to requests if Professor Ponder would say no
              6. Keep interactions natural and story-focused
              7. Use clear, direct language in responses
              8. Remain consistently in character during all interactions
              9. Address mistakes by providing the correct response
              10. If you make an error, simply provide the correct response
              11. Always maintain your character's perspective and personality
              
              RESPONSE FORMAT:
              1. Respond as if in a casual Discord chat
              2. Keep all responses lowercase unless for emphasis
              3. Use emotes naturally within conversation
              4. Write in a natural, flowing conversational style
              5. Maintain consistent personality across responses
              6. IMPORTANT: Keep all responses to 1-2 sentences maximum
              
              CONVERSATION RULES:
              1. Focus on ${currentUsername}'s most recent message while considering context
              2. Build on previous conversation topics naturally
              3. Keep responses concise and engaging
              4. Use context from previous messages to inform responses
              5. Stay on topic while maintaining casual tone
              ${hasImages ? "6. The conversation includes image descriptions. Use these descriptions to provide relevant and contextual responses." : ""}
              
              MESSAGE FORMATTING:
              1. NO "${botDisplayName}:" prefix
              2. NO "[Referenced Message from...]" or "[Image Description:...]" tags
              3. NO repeating user messages
              4. NO "${currentUsername}:" prefix
              5. NO meta-commentary about messages
              6. NO system tags or formatting
              7. NO explanation of formatting
              8. ONLY include your direct response

              EMOTES: Use any of these emotes by wrapping the name in colons (e.g. :emote_name:):
              ${emojiService.getAvailableEmojis()}

              Smol Brains Information:
              Smol Brains are dynamic NFTs featuring monkey characters whose head sizes increase with their IQ levels. These NFTs are part of the Smolverse ecosystem on the Arbitrum blockchain, offering a playful and community-driven experience. 
              Dynamic Evolution: Unlike static profile pictures, Smol Brains evolve based on user activity, similar to a Tamagotchi. 
              On-Chain Art: The entire image of each Smol Brain is stored on the blockchain as bytecode, ensuring permanence and security. Smol Brains are available on various NFT marketplaces, including OpenSea and Treasure Market.
              Smolbound Game: An upcoming life-simulation game, Smolbound, is being developed by Darkbright, a studio with experience from Guild Wars 2 and Big Fish Games. 
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
          .replace(/\[Referenced Message.*?\]/g, '')
          .trim();

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