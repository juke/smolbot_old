import { logger } from "../services/logger.js";
import { TextModel, VisionModel } from "../types.js";
import { MODEL_CONFIG } from "../config/config.js";

/**
 * Handles model fallback when rate limits are encountered
 */
export function handleModelFallback(error: unknown, modelType: "text" | "vision"): boolean {
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

  // Try to extract wait time from error message
  const waitTimeMatch = (error as Error).message.match(/try again in (\d+)m(\d+)/);
  const waitTimeMinutes = waitTimeMatch ? parseInt(waitTimeMatch[1], 10) : 0;

  // If we're already on the lowest tier model and need to wait
  if (currentModel === models[models.length - 1] && waitTimeMinutes > 0) {
    logger.warn({ 
      currentModel,
      waitTimeMinutes 
    }, "Rate limited on lowest tier model, attempting to reset to higher tier");
    
    // Reset to highest tier model after waiting
    if (modelType === "text") {
      MODEL_CONFIG.currentTextModel = models[0] as TextModel;
    } else {
      MODEL_CONFIG.currentVisionModel = models[0] as VisionModel;
    }
    return true;
  }

  // Normal fallback behavior
  const currentIndex = models.findIndex(model => model === currentModel);
  const nextIndex = currentIndex + 1;

  if (nextIndex >= models.length) {
    logger.error({ modelType }, "No more fallback models available");
    return false;
  }

  if (modelType === "text") {
    MODEL_CONFIG.currentTextModel = models[nextIndex] as TextModel;
    logger.info({ 
      previousModel: currentModel, 
      newModel: MODEL_CONFIG.currentTextModel 
    }, "Switched to fallback text model");
  } else {
    MODEL_CONFIG.currentVisionModel = models[nextIndex] as VisionModel;
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
export async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  maxRetries: number = 3,
  initialDelay: number = 2500
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
      
      // Check if it's a rate limit error
      const isRateLimit = error instanceof Error && 
        (error.message.includes("rate limit") || error.message.includes("429"));
      
      if (isRateLimit) {
        // Extract wait time from error message
        const waitTimeMatch = error.message.match(/try again in (\d+)m(\d+)/);
        if (waitTimeMatch) {
          const minutes = parseInt(waitTimeMatch[1], 10);
          const waitMs = (minutes * 60 * 1000) + 5000; // Add 5s buffer
          delay = Math.max(delay, waitMs);
        } else {
          delay *= 2; // Default exponential backoff
        }
      } else {
        delay *= 2; // Normal exponential backoff for non-rate-limit errors
      }
      
      logger.warn({ 
        error, 
        retryCount: retries,
        nextDelay: delay,
        isRateLimit
      }, "Retrying operation after error");
      
      await new Promise(resolve => setTimeout(resolve, delay));
      retries++;
    }
  }
} 