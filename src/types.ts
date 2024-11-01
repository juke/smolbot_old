/**
 * Represents a cached message with additional metadata
 */
export interface CachedMessage {
  id: string;
  authorId: string;
  authorUsername: string;
  authorDisplayName: string;
  content: string;
  timestamp: Date;
  imageDescriptions: {
    brief: string;
    detailed?: string;
  }[];
  referencedMessage?: {
    id: string;
    content: string;
    authorDisplayName: string;
    imageDescriptions: {
      brief: string;
      detailed?: string;
    }[];
  };
}

/**
 * Represents the structure of messages sent to the AI
 */
export interface AIMessage {
  role: "user" | "assistant" | "system";
  name?: string;
  content: string;
}

/**
 * Represents available text generation models in order of preference
 */
export type TextModel = 
  | "llama-3.2-90b-text-preview"
  | "llama-3.1-70b-versatile"
  | "llama-3.1-8b-instant";

/**
 * Represents available vision models in order of preference
 */
export type VisionModel = 
  | "llama-3.2-11b-vision-preview"
  | "llama-3.2-90b-vision-preview"
  | "llava-v1.5-7b-4096-preview";

/**
 * Represents a cached Discord emoji
 */
export interface CachedEmoji {
  id: string;
  name: string;
  animated: boolean;
  guildId: string;
}

/**
 * Configuration for model fallback behavior
 */
export interface ModelConfig {
  textModels: TextModel[];
  visionModels: VisionModel[];
  currentTextModel: TextModel;
  currentVisionModel: VisionModel;
  emojiCache: Map<string, CachedEmoji>;
}

/**
 * Represents a queued message
 */
export interface QueuedMessage {
  message: DiscordMessage;
  timestamp: number;
}

/**
 * Represents a message queue
 */
export interface MessageQueue {
  queue: QueuedMessage[];
  isProcessing: boolean;
}