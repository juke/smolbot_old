import { Message } from "discord.js";

/**
 * Represents an image description with brief and optional detailed analysis
 */
export interface ImageDescription {
  brief: string;
  detailed?: string;
}

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
  imageDescriptions: ImageDescription[];
  referencedMessage?: {
    id: string;
    content: string;
    authorDisplayName: string;
    imageDescriptions: ImageDescription[];
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
  | "llama-3.3-70b-versatile"
  | "llama-3.2-3b-preview"
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
  message: Message;
  timestamp: number;
}

/**
 * Represents a message queue
 */
export interface MessageQueue {
  queue: QueuedMessage[];
  isProcessing: boolean;
}
