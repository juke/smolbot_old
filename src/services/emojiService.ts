import { Collection, GuildEmoji } from "discord.js";
import { CachedEmoji } from "../types.js";
import { logger } from "../config/logger.js";
import { MODEL_CONFIG } from "../config/config.js";
import fs from "fs/promises";
import path from "path";

/**
 * Service for managing emoji processing, caching, and popularity tracking
 */
export class EmojiService {
  private readonly dataDir: string;
  private readonly rankingsPath: string;
  private emojiRankings: Map<string, number> = new Map();
  private readonly maxDisplayedEmojis = 15;
  private readonly saveInterval = 10 * 60 * 1000; // Save every 10 minutes
  private readonly updateInterval = 60 * 60 * 1000; // Update cache every hour
  private currentGuildId?: string;
  private currentGuildEmojis?: Collection<string, GuildEmoji>;

  constructor() {
    // Handle both local and Railway paths
    this.dataDir = process.env.RAILWAY_ENVIRONMENT 
      ? "/app/data"
      : "./data";
    
    this.rankingsPath = path.join(this.dataDir, "emoji-rankings.json");

    // Log environment info
    logger.info({
      environment: process.env.RAILWAY_ENVIRONMENT ? 'railway' : 'local',
      dataDir: this.dataDir,
      rankingsPath: this.rankingsPath,
      uid: process.getuid?.(),
      gid: process.getgid?.(),
      cwd: process.cwd(),
      volumes: process.env.RAILWAY_VOLUME_MOUNTS
    }, "Initializing EmojiService");

    // Initialize data store
    void this.initializeDataStore();
    // Save rankings periodically
    setInterval(() => void this.saveRankings(), this.saveInterval);
    // Update available emojis periodically
    setInterval(() => this.updateAvailableEmojis(), this.updateInterval);
  }

  /**
   * Initializes the data directory and rankings file
   */
  private async initializeDataStore(): Promise<void> {
    try {
      // Create data directory if it doesn't exist
      try {
        await fs.mkdir(this.dataDir, { recursive: true });
        logger.info({
          dataDir: this.dataDir,
        }, "Created/verified data directory");
      } catch (mkdirError) {
        logger.error({ 
          error: mkdirError,
          dataDir: this.dataDir 
        }, "Failed to create data directory");
      }

      // Try to load or create rankings file
      try {
        const fileContent = await fs.readFile(this.rankingsPath, "utf-8").catch(() => "");
        
        // Check if file is empty or invalid JSON
        let rankings: Record<string, number> = {};
        if (fileContent.trim()) {
          try {
            rankings = JSON.parse(fileContent);
            // Validate the parsed content
            if (typeof rankings !== "object" || rankings === null) {
              throw new Error("Invalid rankings format");
            }
          } catch (parseError) {
            logger.warn({ 
              error: parseError,
              content: fileContent.slice(0, 100) // Log first 100 chars for debugging
            }, "Failed to parse rankings file, creating new one");
            rankings = {};
          }
        }

        // Write/overwrite file with valid content
        await fs.writeFile(
          this.rankingsPath, 
          JSON.stringify(rankings, null, 2), 
          { 
            encoding: "utf-8",
            mode: 0o666 // Read/write for all
          }
        );

        this.emojiRankings = new Map(Object.entries(rankings));
        logger.info({
          rankingsCount: this.emojiRankings.size,
          path: this.rankingsPath
        }, "Initialized emoji rankings");

      } catch (fileError: any) {
        logger.error({ 
          error: {
            message: fileError.message,
            code: fileError.code,
            stack: fileError.stack
          },
          path: this.rankingsPath 
        }, "Failed to handle rankings file");
        
        // Fallback to in-memory rankings
        this.emojiRankings = new Map();
        logger.info("Falling back to in-memory emoji rankings");
      }
    } catch (error: any) {
      logger.error({ 
        error: {
          message: error.message,
          code: error.code,
          stack: error.stack
        },
        dataDir: this.dataDir,
        rankingsPath: this.rankingsPath 
      }, "Failed to initialize data store");
      
      // Ensure we have a working rankings map even if everything fails
      this.emojiRankings = new Map();
    }
  }

  /**
   * Updates the available emojis based on current rankings
   */
  private updateAvailableEmojis(): void {
    if (!this.currentGuildId || !this.currentGuildEmojis) return;

    // Don't clear the cache, just update it
    this.currentGuildEmojis.forEach(emoji => {
      if (!emoji.name) return;
      
      const lowercaseName = emoji.name.toLowerCase();
      if (!MODEL_CONFIG.emojiCache.has(lowercaseName)) {
        MODEL_CONFIG.emojiCache.set(lowercaseName, {
          id: emoji.id,
          name: emoji.name,
          animated: emoji.animated ?? false,
          guildId: this.currentGuildId!
        });
      }
    });

    logger.debug({ 
      guildId: this.currentGuildId,
      cachedEmojis: Array.from(MODEL_CONFIG.emojiCache.keys()),
      cacheSize: MODEL_CONFIG.emojiCache.size
    }, "Updated available emojis");
  }

  /**
   * Loads emoji rankings from JSON file
   */
  private async loadRankings(): Promise<void> {
    try {
      const data = await fs.readFile(this.rankingsPath, "utf-8");
      const rankings = JSON.parse(data);
      this.emojiRankings = new Map(Object.entries(rankings));
      
      logger.info({
        rankingsCount: this.emojiRankings.size,
        path: this.rankingsPath
      }, "Loaded emoji rankings");
    } catch (error) {
      logger.error({ error, path: this.rankingsPath }, "Error loading emoji rankings");
      // Initialize empty rankings if load fails
      this.emojiRankings = new Map();
    }
  }

  /**
   * Saves emoji rankings to JSON file
   */
  private async saveRankings(): Promise<void> {
    try {
      const rankings = Object.fromEntries(this.emojiRankings);
      await fs.writeFile(
        this.rankingsPath, 
        JSON.stringify(rankings, null, 2),
        { encoding: "utf-8" }
      );
      
      logger.debug({
        rankingsCount: this.emojiRankings.size,
        path: this.rankingsPath
      }, "Saved emoji rankings");
    } catch (error) {
      logger.error({ error, path: this.rankingsPath }, "Error saving emoji rankings");
    }
  }

  /**
   * Updates emoji usage count and refreshes available emojis if needed
   */
  public trackEmojiUsage(emojiName: string): void {
    const currentCount = this.emojiRankings.get(emojiName) ?? 0;
    this.emojiRankings.set(emojiName, currentCount + 1);
    
    // Save rankings immediately after update
    void this.saveRankings();
    
    // Update available emojis if needed
    const lowestTopEmoji = Array.from(MODEL_CONFIG.emojiCache.values())
      .sort((a, b) => {
        const rankA = this.emojiRankings.get(a.name.toLowerCase()) ?? 0;
        const rankB = this.emojiRankings.get(b.name.toLowerCase()) ?? 0;
        return rankA - rankB;
      })[0];
    
    if (lowestTopEmoji) {
      const lowestRank = this.emojiRankings.get(lowestTopEmoji.name.toLowerCase()) ?? 0;
      if (currentCount + 1 >= lowestRank) {
        this.updateAvailableEmojis();
      }
    }
  }

  /**
   * Caches all emojis from a guild and initializes rankings for new emojis
   */
  public cacheGuildEmojis(guildId: string, emojis: Collection<string, GuildEmoji>): void {
    this.currentGuildId = guildId;
    this.currentGuildEmojis = emojis;

    // Don't clear the cache, just update/add new emojis
    emojis.forEach(emoji => {
      if (!emoji.name) return;
      
      const lowercaseName = emoji.name.toLowerCase();
      
      MODEL_CONFIG.emojiCache.set(lowercaseName, {
        id: emoji.id,
        name: emoji.name, // Keep original name for display
        animated: emoji.animated ?? false,
        guildId: guildId
      });

      if (!this.emojiRankings.has(lowercaseName)) {
        this.emojiRankings.set(lowercaseName, 0);
      }
    });

    // Only update available emojis if cache is empty
    if (MODEL_CONFIG.emojiCache.size === 0) {
      this.updateAvailableEmojis();
    }
  }

  /**
   * Processes text to properly format any emoji references and track usage
   */
  public processEmojiText(text: string): string {
    // First, preserve any properly formatted emojis
    const formattedEmojiPattern = /<(a)?:[\w-]+:\d+>/g;
    const preservedEmojis: string[] = [];
    
    const preservedText = text.replace(formattedEmojiPattern, (match) => {
      preservedEmojis.push(match);
      return `__EMOJI${preservedEmojis.length - 1}__`;
    });

    // Process unformatted emoji patterns
    const processedText = preservedText.replace(/:([\w-]+):/g, (fullMatch, emojiName) => {
      // Don't process if emojiName contains any emoji formatting
      if (emojiName.includes('<') || emojiName.includes('>')) {
        return fullMatch;
      }

      const lowercaseName = emojiName.toLowerCase();
      const emoji = MODEL_CONFIG.emojiCache.get(lowercaseName);

      if (emoji) {
        this.trackEmojiUsage(lowercaseName);
        return emoji.animated 
          ? `<a:${emoji.name}:${emoji.id}>`
          : `<:${emoji.name}:${emoji.id}>`;
      }

      return fullMatch;
    });

    // Restore preserved emojis
    return processedText.replace(/__EMOJI(\d+)__/g, (_, index) => 
      preservedEmojis[parseInt(index)]
    );
  }

  /**
   * Gets a formatted list of top emojis by usage
   */
  public getAvailableEmojis(): string {
    const emojiList = Array.from(MODEL_CONFIG.emojiCache.values())
      .map(emoji => ({
        name: emoji.name,
        rank: this.emojiRankings.get(emoji.name.toLowerCase()) ?? 0
      }))
      .sort((a, b) => b.rank - a.rank)
      .slice(0, this.maxDisplayedEmojis)
      .map(({ name }) => {
        const emoji = MODEL_CONFIG.emojiCache.get(name.toLowerCase());
        if (!emoji) return name;
        return emoji.animated 
          ? `<a:${emoji.name}:${emoji.id}>`
          : `<:${emoji.name}:${emoji.id}>`;
      });

    return emojiList.join(", ") || "No custom emojis available";
  }

  /**
   * Gets emoji usage statistics
   */
  public getEmojiStats(): Record<string, unknown> {
    const sortedRankings = Array.from(this.emojiRankings.entries())
      .sort(([, a], [, b]) => b - a);

    return {
      totalEmojis: this.emojiRankings.size,
      topEmojis: Object.fromEntries(sortedRankings.slice(0, 10)),
      totalUsage: Array.from(this.emojiRankings.values()).reduce((a, b) => a + b, 0)
    };
  }
}

export const emojiService = new EmojiService();