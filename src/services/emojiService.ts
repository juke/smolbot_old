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
      ? "/data"
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
        // Set directory permissions explicitly
        if (process.env.RAILWAY_ENVIRONMENT) {
          await fs.chmod(this.dataDir, 0o777);
        }
        logger.info({
          dataDir: this.dataDir,
          permissions: (await fs.stat(this.dataDir)).mode.toString(8)
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

        // Write/overwrite file with valid content and explicit permissions
        await fs.writeFile(
          this.rankingsPath, 
          JSON.stringify(rankings, null, 2), 
          { 
            encoding: "utf-8",
            mode: 0o666 // Read/write for all
          }
        );

        // Set file permissions explicitly for Railway
        if (process.env.RAILWAY_ENVIRONMENT) {
          await fs.chmod(this.rankingsPath, 0o666);
        }

        this.emojiRankings = new Map(Object.entries(rankings));
        logger.info({
          rankingsCount: this.emojiRankings.size,
          path: this.rankingsPath,
          permissions: (await fs.stat(this.rankingsPath)).mode.toString(8)
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
    Array.from(MODEL_CONFIG.emojiCache.entries()).forEach(([_, emoji]) => {
      if (emoji.guildId === this.currentGuildId) {
        MODEL_CONFIG.emojiCache.delete(emoji.name);
      }
    });

    // Cache emojis with original names only
    this.currentGuildEmojis.forEach(emoji => {
      if (!emoji.name) return;
      
      MODEL_CONFIG.emojiCache.set(emoji.name, {
        id: emoji.id,
        name: emoji.name,
        animated: emoji.animated ?? false,
        guildId: this.currentGuildId!
      });
    });

    logger.info({
      guildId: this.currentGuildId,
      cacheSize: MODEL_CONFIG.emojiCache.size,
      emojiCount: this.currentGuildEmojis.size,
      cachedCount: MODEL_CONFIG.emojiCache.size
    }, "Updated emoji cache");

    // Debug log for cache state
    logger.debug({
      totalCached: MODEL_CONFIG.emojiCache.size,
      allEmojis: Array.from(MODEL_CONFIG.emojiCache.keys())
    }, "Emoji cache state after update");
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
    Array.from(MODEL_CONFIG.emojiCache.entries()).forEach(([_, emoji]) => {
      if (emoji.guildId === guildId) {
        MODEL_CONFIG.emojiCache.delete(emoji.name);
      }
    });

    // Cache new emojis with validation (original names only)
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

      // Cache only original name
      MODEL_CONFIG.emojiCache.set(emoji.name, emojiData);

      // Initialize or update ranking (always use lowercase for rankings)
      if (!this.emojiRankings.has(emoji.name.toLowerCase())) {
        this.emojiRankings.set(emoji.name.toLowerCase(), 0);
      }
    });

    logger.info({
      guildId,
      previousCacheSize: previousSize,
      newCacheSize: MODEL_CONFIG.emojiCache.size,
      emojiCount: emojis.size,
      cachedCount: MODEL_CONFIG.emojiCache.size
    }, "Updated emoji cache");

    // Debug log for cache state verification
    logger.debug({
      totalCached: MODEL_CONFIG.emojiCache.size,
      allEmojis: Array.from(MODEL_CONFIG.emojiCache.keys())
    }, "Emoji cache state after update");
  }

  /**
   * Gets a formatted list of top emojis by usage
   */
  public getAvailableEmojis(): string {
    // Debug log current cache state
    logger.debug({
      cacheSize: MODEL_CONFIG.emojiCache.size,
      allEmojis: Array.from(MODEL_CONFIG.emojiCache.values()).map(e => e.name)
    }, "Getting available emojis");

    // Get all emojis except the last used one, preserving exact names
    const emojiList = Array.from(MODEL_CONFIG.emojiCache.values())
      .filter(emoji => emoji.name.toLowerCase() !== this.lastUsedEmoji)
      .map(emoji => ({
        name: emoji.name,  // Use exact name from cache
        rank: this.emojiRankings.get(emoji.name.toLowerCase()) ?? 0
      }))
      .sort((a, b) => b.rank - a.rank)
      .slice(0, this.maxDisplayedEmojis)
      .map(({ name }) => `:${name}:`);

    const emojiString = emojiList.join(", ");
    
    // Debug log the final emoji list
    logger.debug({
      emojiCount: emojiList.length,
      emojis: emojiList
    }, "Available emojis list generated");

    return emojiString || "No custom emojis available";
  }

  /**
   * Gets emoji usage statistics
   */
  public getEmojiStats(): Record<string, unknown> {
    const sortedRankings = Array.from(this.emojiRankings.entries())
      .sort(([, a], [, b]) => b - a);

    return {
      totalEmojis: this.emojiRankings.size,
      topEmojis: Object.fromEntries(sortedRankings.slice(0, 15)),
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
            uniqueEmojis: new Set(Array.from(MODEL_CONFIG.emojiCache.values()).map(e => e.id)).size,
            totalWithCaseVariants: MODEL_CONFIG.emojiCache.size,
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
   * Gets an emoji from cache with case-insensitive matching
   */
  private getEmojiFromCache(name: string): CachedEmoji | undefined {
    if (!name) return undefined;

    // Try exact match first
    const exactMatch = MODEL_CONFIG.emojiCache.get(name);
    if (exactMatch) return exactMatch;

    // Case-insensitive search
    const lowercaseName = name.toLowerCase();
    const caseInsensitiveMatch = Array.from(MODEL_CONFIG.emojiCache.values()).find(
      emoji => emoji.name.toLowerCase() === lowercaseName
    );

    if (caseInsensitiveMatch) {
      // Update cache with found emoji to speed up future lookups
      MODEL_CONFIG.emojiCache.set(name, caseInsensitiveMatch);
      return caseInsensitiveMatch;
    }

    return undefined;
  }

  /**
   * Processes text to properly format any emoji references and track usage
   */
  public async processEmojiText(text: string, isFromBot: boolean = false): Promise<string> {
    if (!text) return "";
    
    try {
      await this.refreshGuildEmojis();
      
      // Convert all emoji formats to consistent Discord format
      const processEmoji = (name: string): string => {
        const emoji = this.getEmojiFromCache(name);
        if (!emoji) return `:${name}:`; // Keep original format if not found
        
        this.trackEmojiUsage(name.toLowerCase(), isFromBot);
        if (isFromBot) {
          this.lastUsedEmoji = name.toLowerCase();
        }
        
        return emoji.animated 
          ? `<a:${emoji.name}:${emoji.id}>`
          : `<:${emoji.name}:${emoji.id}>`;
      };

      // First pass: Handle both pre-formatted and :emoji: format
      let processedText = text.replace(/(?:<(a)?:(\w+):(\d{17,20})>|:(\w+):)/g, (match, animated, name1, id, name2) => {
        // If it's a pre-formatted emoji (with ID)
        if (name1) {
          return processEmoji(name1);
        }
        // If it's :emoji: format
        if (name2) {
          return processEmoji(name2);
        }
        return match;
      });

      return processedText;

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
   * Verifies if an emoji still exists in its guild
   */
  private async verifyEmojiExists(emoji: CachedEmoji): Promise<boolean> {
    try {
      const guild = await client.guilds.fetch(emoji.guildId);
      const guildEmoji = await guild.emojis.fetch(emoji.id);
      return !!guildEmoji;
    } catch (error) {
      logger.warn({
        emojiId: emoji.id,
        emojiName: emoji.name,
        guildId: emoji.guildId,
        error
      }, "Failed to verify emoji existence");
      return false;
    }
  }

  /**
   * Finds the best matching emoji with improved validation
   */
  private findBestMatchingEmoji(requestedName: string): CachedEmoji | undefined {
    // Validate input
    if (!requestedName || typeof requestedName !== "string") {
      logger.warn({ requestedName }, "Invalid emoji name requested");
      return undefined;
    }

    // Log the requested emoji name for debugging
    logger.debug({
      requestedName,
      cacheSize: MODEL_CONFIG.emojiCache.size,
      availableEmojis: Array.from(MODEL_CONFIG.emojiCache.values()).map(e => e.name)
    }, "Finding best matching emoji");

    // Try exact match first (case-sensitive)
    const exactMatch = MODEL_CONFIG.emojiCache.get(requestedName);
    if (exactMatch) {
      logger.debug({ 
        requestedName,
        matchedName: exactMatch.name,
        matchType: "exact"
      }, "Found exact emoji match");
      return exactMatch;
    }

    // Try case-insensitive match
    const lowercaseRequest = requestedName.toLowerCase();
    const caseInsensitiveMatch = Array.from(MODEL_CONFIG.emojiCache.values()).find(
      emoji => emoji.name.toLowerCase() === lowercaseRequest
    );
    
    if (caseInsensitiveMatch) {
      logger.debug({ 
        requestedName,
        matchedName: caseInsensitiveMatch.name,
        matchType: "case-insensitive"
      }, "Found case-insensitive emoji match");
      return caseInsensitiveMatch;
    }

    // Try normalized match (removing underscores and hyphens)
    const normalizedRequest = lowercaseRequest.replace(/[_-]/g, "");
    const normalizedMatch = Array.from(MODEL_CONFIG.emojiCache.values()).find(emoji => {
      const normalizedEmoji = emoji.name.toLowerCase().replace(/[_-]/g, "");
      return normalizedEmoji === normalizedRequest;
    });

    if (normalizedMatch) {
      logger.debug({ 
        requestedName,
        matchedName: normalizedMatch.name,
        matchType: "normalized"
      }, "Found normalized emoji match");
    } else {
      logger.debug({ 
        requestedName,
        availableEmojis: Array.from(MODEL_CONFIG.emojiCache.values()).map(e => e.name)
      }, "No emoji match found");
    }

    return normalizedMatch;
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