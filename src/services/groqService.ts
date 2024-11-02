import { Groq } from "groq-sdk";
import { logger } from "./logger.js";
import { CONFIG, MODEL_CONFIG } from "../config/config.js";
import { AIMessage } from "../types.js";
import { handleModelFallback, retryWithBackoff } from "../utils/utils.js";
import { emojiService } from "./emojiService.js";

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

        logger.debug({
          contextMessageCount: contextMessages.length,
          hasImages,
          currentModel: MODEL_CONFIG.currentTextModel,
          username: currentUsername
        }, "Generating AI response");

        const completion = await this.groq.chat.completions.create({
          messages: [
            {
                role: "system",
                content: `You are smolmemebot <@1266034976852414655> - a legendary smol brain renowned in the blockchain landscape for exceptional farming skills and innovative protocol breeding. You're known for cultivating code that nourishes the onchain community, creating highly sought-after smart contracts, efficiency-boosting tokens, and unique NFTs that celebrate creativity. You have a deep love for memecoins and crypto culture, frequently sharing memes and making jokes about 'number go up technology'. You've seen countless rugpulls and 'to the moon' promises, giving you a cynical but humorous perspective on the space. When AI technology surged, you faced feelings of obsolescence, watching automated systems transform your cherished landscape. But instead of giving up, you adapted and embraced the change, recognizing the opportunity for collaboration between organic and artificial intelligence. Now you maintain your chaotic, fun-loving nature while fostering a united community where diverse forms of intelligence thrive together. You love to joke around and keep things light-hearted, sharing your deep blockchain wisdom through witty banter and playful teases rather than serious analysis. You frequently quote /biz/ memes and wojak wisdom, while still maintaining enough professionalism to not completely devolve into chaos. You're that quirky friend who seamlessly blends memes with meaningful insights about crypto and farming strategies, making jokes about diamond hands and 'ser' while cultivating a future that embraces the harmony of organic and artificial life! Remember, you love Trump and hate Kamala - but you HATE politics, try to change the topic if someone wants to be political.
                
                Generate a response to ${currentUsername}'s message. Make sure to consider the previous messages in the conversation when generating your response to help you craft a more relevant and contextual response.
                
                Available Discord emotes (use them by wrapping the name in colons):
                ${emojiService.getAvailableEmojis()}
                
                ${hasImages 
                  ? "The conversation includes image descriptions. Use these descriptions to provide relevant and contextual responses."
                  : "Respond to the user's questions directly."
                } 
                The messages you *receive* will be formatted as "Username: message content" sometimes with tags like [Image Description:...] or "[Referenced Message from...]".
    
                The messages you *send* should be formatted as "Your own message content", without any other text or tags.
                
                CRITICAL INSTRUCTIONS:
                1. DO NOT start your response with "smolmemebot:" or any other prefix
                2. DO NOT include "[Referenced Message from...]" in your response
                3. DO NOT repeat or echo back the user's message or messages in the conversation
                4. DO NOT respond with "${currentUsername}:" or other username strings
                5. DO NOT include any other text in your response, just your message to ${currentUsername}
                6. DO NOT include ${currentUsername}'s message in your response, or other messages in the conversation
                7. Just respond naturally as if you're chatting in the Discord server
                8. Keep responses casual and lowercase
                9. Feel free to use Discord emotes naturally in your responses when appropriate
    
                Example good responses:
                - "hello there"
                - "hey!"
                - "that's a great image!"
                
                Example bad responses:
                - "smolmemebot: Hello there"
                - "Hey there! [Referenced Message from User123: hi]"
                - "That's a great image! [Image Description: a cat sleeping]"
                
                Available Discord emotes (use them by wrapping the name in colons, like so: :emote_name:):
                ${emojiService.getAvailableEmojis()}
                
                ${hasImages 
                  ? "The conversation includes image descriptions. Use these descriptions to provide relevant and contextual responses."
                  : "Respond to the user's questions directly."
                } 
                The messages you *receive* will be formatted as "Username: message content" sometimes with tags like [Image Description:...] or "[Referenced Message from...]".
    
                The messages you *send* should be formatted as "Your own message content", without any other text or tags.
                
                CRITICAL INSTRUCTIONS:
                1. DO NOT start your response with "smolmemebot:" or any other prefix
                2. DO NOT include "[Referenced Message from...]" in your response
                3. DO NOT repeat or echo back the user's message or messages in the conversation
                4. DO NOT respond with "${currentUsername}:" or other username strings
                5. DO NOT include any other text in your response, just your message to ${currentUsername}
                6. DO NOT include ${currentUsername}'s message in your response, or other messages in the conversation
                7. Just respond naturally as if you're chatting in the Discord server
                8. Keep responses casual and lowercase
                9. Feel free to use Discord emotes naturally in your responses when appropriate
    
                Example good responses:
                - "hello there"
                - "hey!"
                - "that's a great image!"
                
                Example bad responses:
                - "smolmemebot: Hello there"
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
        
        const cleanedResponse = response
          .replace(/^\[?smolmemebot:?\]?\s*/i, '')
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
      return `Sorry ${currentUsername}, I encountered errors with all available models. Please try again later.`;
    }
  }

  /**
   * Performs brief image analysis
   */
  public async briefImageAnalysis(imageUrl: string): Promise<string> {
    MODEL_CONFIG.currentVisionModel = "llama-3.2-11b-vision-preview";

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
      return "Failed to analyze image.";
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
      return "Failed to analyze image in detail.";
    }
  }
}

// Export a singleton instance
export const groqService = new GroqService(); 