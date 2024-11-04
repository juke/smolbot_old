import { Collection, GuildEmoji } from "discord.js";
import { CachedEmoji } from "../types.js";
import { logger } from "../config/logger.js";
import { MODEL_CONFIG } from "../config/config.js";
import fs from "fs/promises";
import path from "path";
import { client } from "./discordClient.js";

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
  private lastUsedEmoji: string | null = null;
  private lastSaveLog: number = 0;
  private readonly cacheRefreshInterval = 5 * 60 * 1000; // 5 minutes
  private lastCacheRefresh: number = 0;

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

    // Clear existing emojis for this guild first
    Array.from(MODEL_CONFIG.emojiCache.entries()).forEach(([name, emoji]) => {
      if (emoji.guildId === this.currentGuildId) {
        MODEL_CONFIG.emojiCache.delete(name);
      }
    });

    // Re-cache all current emojis
    this.currentGuildEmojis.forEach(emoji => {
      if (!emoji.name) return;
      
      const lowercaseName = emoji.name.toLowerCase();
      MODEL_CONFIG.emojiCache.set(lowercaseName, {
        id: emoji.id,
        name: emoji.name,
        animated: emoji.animated ?? false,
        guildId: this.currentGuildId!
      });
    });

    logger.debug({
      guildId: this.currentGuildId,
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
        
        // Only log hourly
        const now = Date.now();
        if (!this.lastSaveLog || now - this.lastSaveLog > 3600000) {
            logger.debug({
                rankingsCount: this.emojiRankings.size,
            }, "Saved emoji rankings");
            this.lastSaveLog = now;
        }
    } catch (error) {
        logger.error({ error }, "Error saving emoji rankings");
    }
  }

  /**
   * Updates emoji usage count and refreshes available emojis if needed
   */
  public trackEmojiUsage(emojiName: string, isFromBot: boolean = false): void {
    // Skip tracking if message is from the bot
    if (isFromBot) {
        return;
    }

    const currentCount = this.emojiRankings.get(emojiName) ?? 0;
    const newCount = currentCount + 1;
    this.emojiRankings.set(emojiName, newCount);
    
    // Only log significant ranking changes (e.g., milestones)
    if (newCount % 10 === 0) { // Log every 10th use
        logger.debug({ 
            emojiName, 
            uses: newCount
        }, "Emoji usage milestone");
    }
    
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
        if (newCount >= lowestRank) {
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

    // Clear existing emojis for this guild
    const previousSize = MODEL_CONFIG.emojiCache.size;
    Array.from(MODEL_CONFIG.emojiCache.entries()).forEach(([name, emoji]) => {
        if (emoji.guildId === guildId) {
            MODEL_CONFIG.emojiCache.delete(name);
        }
    });

    // Cache new emojis with validation
    emojis.forEach(emoji => {
        if (!emoji.name || !emoji.id || !this.isValidEmojiName(emoji.name)) {
            logger.warn({
                emojiName: emoji.name,
                emojiId: emoji.id,
                guildId
            }, "Skipping invalid emoji");
            return;
        }
        
        const emojiData = {
            id: emoji.id,
            name: emoji.name,
            animated: Boolean(emoji.animated),
            guildId: guildId
        };

        // Cache both cases to ensure matching
        MODEL_CONFIG.emojiCache.set(emoji.name, emojiData);
        MODEL_CONFIG.emojiCache.set(emoji.name.toLowerCase(), emojiData);

        // Initialize or update ranking
        if (!this.emojiRankings.has(emoji.name.toLowerCase())) {
            this.emojiRankings.set(emoji.name.toLowerCase(), 0);
        }
    });

    logger.info({
        guildId,
        previousCacheSize: previousSize,
        newCacheSize: MODEL_CONFIG.emojiCache.size,
        emojiCount: emojis.size,
        cachedCount: MODEL_CONFIG.emojiCache.size / 2 // Divide by 2 because we cache each emoji twice
    }, "Updated emoji cache");

    // Add this debug log after caching emojis
    logger.debug({
        peacefulPlace: {
            exact: MODEL_CONFIG.emojiCache.get('peacefulPlace'),
            lowercase: MODEL_CONFIG.emojiCache.get('peacefulplace')
        },
        totalCached: MODEL_CONFIG.emojiCache.size,
        allEmojis: Array.from(MODEL_CONFIG.emojiCache.keys())
    }, "Emoji cache state after update");
  }

  /**
   * Gets a formatted list of top emojis by usage
   */
  public getAvailableEmojis(): string {
    const emojiList = Array.from(MODEL_CONFIG.emojiCache.values())
        .filter(emoji => emoji.name.toLowerCase() !== this.lastUsedEmoji)
        .map(emoji => ({
            name: emoji.name,
            rank: this.emojiRankings.get(emoji.name.toLowerCase()) ?? 0
        }))
        .sort((a, b) => b.rank - a.rank)
        .slice(0, this.maxDisplayedEmojis)
        .map(({ name }) => `:${name}:`);

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

  /**
   * Validates an emoji name with strict rules
   */
  private isValidEmojiName(name: string): boolean {
    // Simplified validation - just check for basic emoji name rules
    const validPattern = /^[\w-]{2,32}$/;
    const isValid = validPattern.test(name);
    
    if (!isValid) {
        logger.debug({ 
            name,
            pattern: validPattern.source
        }, "Invalid emoji name");
    }
    
    return isValid;
  }

  /**
   * Safely extracts emoji components from a Discord emoji format
   */
  private parseDiscordEmoji(emojiText: string): { name: string; id: string; animated: boolean } | null {
    // Updated regex to better capture animated flag
    const match = emojiText.match(/<(a)?:(?<name>[\w-]+):(?<id>\d{17,20})>/);
    if (!match?.groups) return null;

    return {
      name: match.groups.name,
      id: match.groups.id,
      // Explicitly check for 'a' in the capture group
      animated: match[1] === 'a'
    };
  }

  private async refreshGuildEmojis(): Promise<void> {
    if (!this.currentGuildId) return;
    
    const now = Date.now();
    if (now - this.lastCacheRefresh < this.cacheRefreshInterval) {
        logger.debug({
            timeSinceLastRefresh: now - this.lastCacheRefresh,
            interval: this.cacheRefreshInterval,
            cacheSize: MODEL_CONFIG.emojiCache.size
        }, "Skipping emoji cache refresh - too soon");
        return;
    }
    
    try {
        const guild = await client.guilds.fetch(this.currentGuildId);
        const emojis = await guild.emojis.fetch();
        
        // Validate emoji cache before updating
        const validEmojis = emojis.filter(emoji => 
            emoji.name && 
            emoji.id && 
            this.isValidEmojiName(emoji.name)
        );
        
        if (validEmojis.size !== emojis.size) {
            logger.warn({
                totalEmojis: emojis.size,
                validEmojis: validEmojis.size,
                guildId: this.currentGuildId
            }, "Some emojis failed validation");
        }
        
        this.cacheGuildEmojis(this.currentGuildId, validEmojis);
        this.lastCacheRefresh = now;
        
        logger.info({
            guildId: this.currentGuildId,
            cacheSize: MODEL_CONFIG.emojiCache.size,
            animatedCount: Array.from(MODEL_CONFIG.emojiCache.values()).filter(e => e.animated).length,
            timeSinceLastRefresh: now - this.lastCacheRefresh
        }, "Refreshed emoji cache");
    } catch (error) {
        logger.error({ 
            error, 
            guildId: this.currentGuildId 
        }, "Failed to refresh guild emojis");
    }
  }

  /**
   * Processes text to properly format any emoji references and track usage
   */
  public async processEmojiText(text: string, isFromBot: boolean = false): Promise<string> {
    if (!text) return "";
    
    try {
        await this.refreshGuildEmojis();
        
        // First pass: Validate and ensure proper formatting of existing Discord emojis
        const formattedEmojiPattern = /<(a)?:(\w+):(\d{17,20})>/g;
        
        // Check if text contains pre-formatted emojis
        if (text.match(formattedEmojiPattern)) {
            // Validate each pre-formatted emoji
            const processed = text.replace(formattedEmojiPattern, (match, animated, name, id) => {
                // Verify emoji exists in cache
                const emojiData = MODEL_CONFIG.emojiCache.get(name) || 
                                MODEL_CONFIG.emojiCache.get(name.toLowerCase());
                
                if (!emojiData) {
                    logger.debug({
                        name,
                        id,
                        match,
                        cacheSize: MODEL_CONFIG.emojiCache.size
                    }, "Pre-formatted emoji not found in cache");
                    return match;
                }

                // Track usage
                this.trackEmojiUsage(name.toLowerCase(), isFromBot);
                if (isFromBot) {
                    this.lastUsedEmoji = name.toLowerCase();
                }

                // Return the properly formatted version from cache
                return emojiData.animated 
                    ? `<a:${emojiData.name}:${emojiData.id}>`
                    : `<:${emojiData.name}:${emojiData.id}>`;
            });

            logger.debug({
                original: text,
                processed,
                matches: Array.from(text.matchAll(formattedEmojiPattern))
            }, "Processed pre-formatted emojis");

            return processed;
        }

        // Second pass: Process :emoji: format with improved handling
        const processed = text.replace(/:(\w+):/g, (match, name) => {
            // Debug log each emoji being processed
            logger.debug({
                processingEmoji: name,
                exactMatch: MODEL_CONFIG.emojiCache.get(name),
                lowercaseMatch: MODEL_CONFIG.emojiCache.get(name.toLowerCase()),
                isValid: this.isValidEmojiName(name)
            }, "Processing emoji");

            if (!this.isValidEmojiName(name)) {
                logger.debug({ name }, "Invalid emoji name");
                return match;
            }

            // Try exact match first, then lowercase
            const emoji = MODEL_CONFIG.emojiCache.get(name) || 
                         MODEL_CONFIG.emojiCache.get(name.toLowerCase());
            
            if (!emoji) {
                logger.debug({ 
                    emojiName: name,
                    cacheSize: MODEL_CONFIG.emojiCache.size,
                    availableEmojis: Array.from(MODEL_CONFIG.emojiCache.keys()),
                    lastUsedEmoji: this.lastUsedEmoji
                }, "Emoji not found in cache");
                return match;
            }

            this.trackEmojiUsage(name.toLowerCase(), isFromBot);
            
            // Ensure proper formatting with exact emoji name from cache
            const formatted = emoji.animated 
                ? `<a:${emoji.name}:${emoji.id}>`
                : `<:${emoji.name}:${emoji.id}>`;
            
            logger.debug({
                originalName: name,
                formattedEmoji: formatted,
                emojiId: emoji.id,
                animated: emoji.animated,
                isFromBot,
                lastUsedEmoji: this.lastUsedEmoji
            }, "Emoji formatted successfully");
            
            if (isFromBot) {
                this.lastUsedEmoji = emoji.name.toLowerCase();
            }
            
            return formatted;
        });

        // Debug log any unprocessed emojis
        const remainingEmojis = processed.match(/:(\w+):/g);
        if (remainingEmojis) {
            logger.debug({
                remainingEmojis,
                text: processed,
                cacheSize: MODEL_CONFIG.emojiCache.size,
                cacheKeys: Array.from(MODEL_CONFIG.emojiCache.keys())
            }, "Emojis that weren't processed");
        }

        return processed;

    } catch (error) {
        logger.error({ 
            error,
            text,
            cacheSize: MODEL_CONFIG.emojiCache.size 
        }, "Error processing emoji text");
        return text;
    }
  }

  /**
   * Validates that an emoji is properly formatted for Discord
   */
  private validateEmojiFormat(emojiText: string): boolean {
    // Check for proper Discord emoji format including animated
    const emojiPattern = /<(a)?:[\w-]+:\d{17,20}>/;
    const isValid = emojiPattern.test(emojiText);
    
    if (!isValid) {
        logger.warn({
            emojiText,
            pattern: emojiPattern.source
        }, "Invalid emoji format detected");
    }
    
    return isValid;
  }
}

export const emojiService = new EmojiService();