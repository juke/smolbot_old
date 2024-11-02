import { Client, GatewayIntentBits } from "discord.js";
import { logger } from "../config/logger.js";
import { CONFIG } from "../config/config.js";

/**
 * Creates and configures the Discord client
 */
export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

/**
 * Initializes the Discord client connection
 */
export async function initializeDiscordClient(): Promise<void> {
  try {
    await client.login(CONFIG.DISCORD_TOKEN);
    logger.info({
      username: client.user?.tag,
      guildCount: client.guilds.cache.size
    }, "Discord client successfully initialized");
  } catch (error) {
    logger.error({ error }, "Failed to initialize Discord client");
    throw error;
  }
} 