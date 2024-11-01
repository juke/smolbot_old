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