import { client, initializeDiscordClient } from "./services/discordClient.js";
import { logger } from "./config/logger.js";
import { CONFIG } from "./config/config.js";
import { handleReady, handleMessage } from "./services/eventHandlers.js";
import http from "http";

// Create HTTP server for Railway health checks
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Health check passed");
});

server.listen(CONFIG.PORT, () => {
  logger.info({ port: CONFIG.PORT }, "HTTP server started for health checks");
});

// Set up event handlers
client.on("ready", handleReady);
client.on("messageCreate", handleMessage);

// Initialize Discord client
void initializeDiscordClient(); 