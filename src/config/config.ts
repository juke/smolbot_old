import { config as dotenvConfig } from "dotenv";
import { ModelConfig } from "../types.js";

// Initialize environment variables
dotenvConfig();

// Validate required environment variables
const requiredEnvVars = ["GROQ_API_KEY", "DISCORD_TOKEN"] as const;
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    throw new Error(`Missing required environment variable: ${envVar}`);
  }
}

export const CONFIG = {
  GROQ_API_KEY: process.env.GROQ_API_KEY!,
  DISCORD_TOKEN: process.env.DISCORD_TOKEN!,
  PORT: parseInt(process.env.PORT || "8000", 10),
  MAX_MESSAGES: 15,
  QUEUE: {
    maxQueueSize: 5,
    processingDelay: 2500
  },
  RATE_LIMITS: {
    resetInterval: 60 * 60 * 1000, // 1 hour in ms
    maxRequestsPerModel: {
      "llama-3.3-70b-versatile": 100000,
      "llama-3.2-3b-preview": 200000,
      "llama-3.1-8b-instant": 500000
    }
  }
} as const;

export const MODEL_CONFIG: ModelConfig = {
  textModels: [
    "llama-3.3-70b-versatile",
    "llama-3.2-3b-preview",
    "llama-3.1-8b-instant"
  ],
  visionModels: [
    "llama-3.2-11b-vision-preview",
    "llama-3.2-90b-vision-preview",
    "llava-v1.5-7b-4096-preview"
  ],
  currentTextModel: "llama-3.1-70b-versatile",
  currentVisionModel: "llama-3.2-11b-vision-preview",
  emojiCache: new Map()
}; 
