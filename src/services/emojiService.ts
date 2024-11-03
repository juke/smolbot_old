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
  public trackEmojiUsage(emojiName: string, isFromBot: boolean = false): void {
    // Add debug logging
    logger.debug({ 
        emojiName, 
        isFromBot, 
        currentCount: this.emojiRankings.get(emojiName) ?? 0 
    }, "Attempting to track emoji usage");

    // Skip tracking if message is from the bot
    if (isFromBot) {
        logger.debug({ emojiName }, "Skipping emoji tracking for bot message");
        return;
    }

    const currentCount = this.emojiRankings.get(emojiName) ?? 0;
    const newCount = currentCount + 1;
    this.emojiRankings.set(emojiName, newCount);
    
    // Add debug logging for update
    logger.debug({ 
        emojiName, 
        oldCount: currentCount,
        newCount,
        rankings: Object.fromEntries(this.emojiRankings)
    }, "Updated emoji ranking");
    
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

    // Clear existing emojis for this guild to prevent stale data
    Array.from(MODEL_CONFIG.emojiCache.entries()).forEach(([name, emoji]) => {
      if (emoji.guildId === guildId) {
        MODEL_CONFIG.emojiCache.delete(name);
      }
    });

    // Cache new emojis
    emojis.forEach(emoji => {
      if (!emoji.name) return;
      
      const lowercaseName = emoji.name.toLowerCase();
      
      logger.debug({
        name: emoji.name,
        id: emoji.id,
        animated: emoji.animated,
        guildId
      }, "Caching emoji");

      MODEL_CONFIG.emojiCache.set(lowercaseName, {
        id: emoji.id,
        name: emoji.name,
        animated: emoji.animated ?? false,
        guildId: guildId
      });

      if (!this.emojiRankings.has(lowercaseName)) {
        this.emojiRankings.set(lowercaseName, 0);
      }
    });

    logger.info({
      guildId,
      emojiCount: MODEL_CONFIG.emojiCache.size,
      emojis: Array.from(MODEL_CONFIG.emojiCache.entries()).map(([name, e]) => ({
        name,
        id: e.id
      }))
    }, "Updated emoji cache");
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
    // Discord emoji name rules:
    // - 2-32 characters
    // - Only alphanumeric, underscores, and hyphens
    // - No double underscores (Discord restriction)
    // - No consecutive hyphens
    // - Cannot start/end with hyphen or underscore
    const validPattern = /^[a-zA-Z0-9][a-zA-Z0-9-_]*[a-zA-Z0-9]$/;
    return (
      name.length >= 2 && 
      name.length <= 32 && 
      validPattern.test(name) &&
      !name.includes("__") && // No double underscores
      !name.includes("--") && // No double hyphens
      !/-.*_|_.*-/.test(name) // No mix of hyphen and underscore
    );
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

  /**
   * Processes text to properly format any emoji references and track usage
   */
  public processEmojiText(text: string, isFromBot: boolean = false): string {
    if (!text) return "";
    
    try {
        // Create a unique prefix for this processing run to avoid collisions
        const uniquePrefix = `__EMOJI_${Date.now()}_`;
        const placeholders: Map<string, string> = new Map();
        let placeholderCount = 0;

        // Step 1: Preserve properly formatted Discord emojis
        const preserveDiscordEmojis = (input: string): string => {
            return input.replace(/<(?:a)?:[\w-]+:\d{17,20}>/g, (match) => {
                const parsed = this.parseDiscordEmoji(match);
                if (!parsed) return match;

                // Validate the emoji components
                if (!this.isValidEmojiName(parsed.name)) return match;
                if (!/^\d{17,20}$/.test(parsed.id)) return match;

                this.trackEmojiUsage(parsed.name.toLowerCase(), isFromBot);

                const placeholder = `${uniquePrefix}${placeholderCount++}`;
                placeholders.set(placeholder, match);
                return placeholder;
            });
        };

        // Step 2: Process unformatted emoji patterns
        const processUnformattedEmojis = (input: string): string => {
            // Handle :emoji: format
            return input.replace(/:([\w-]+):/g, (fullMatch, emojiName) => {
                // Add debug logging for each match
                logger.debug({ 
                    fullMatch, 
                    emojiName,
                    isFromBot,
                    cacheContents: Array.from(MODEL_CONFIG.emojiCache.keys())
                }, "Processing emoji match");

                // Skip if it's already a placeholder
                if (fullMatch.startsWith(uniquePrefix)) {
                    logger.debug({ fullMatch }, "Skipping placeholder");
                    return fullMatch;
                }

                // Basic validation
                if (!this.isValidEmojiName(emojiName)) {
                    logger.debug({ emojiName }, "Invalid emoji name");
                    return fullMatch;
                }

                // Try case-insensitive match first
                const lowercaseName = emojiName.toLowerCase();
                let emoji = MODEL_CONFIG.emojiCache.get(lowercaseName);

                // If not found, try exact match
                if (!emoji) {
                    emoji = MODEL_CONFIG.emojiCache.get(emojiName);
                }

                if (emoji) {
                    // Add debug logging before tracking
                    logger.debug({ 
                        emojiName: emoji.name,
                        isFromBot,
                        currentRanking: this.emojiRankings.get(emoji.name.toLowerCase())
                    }, "Found emoji in cache");

                    this.trackEmojiUsage(emoji.name.toLowerCase(), isFromBot);
                    
                    // Use the correct format based on whether the emoji is animated
                    const formattedEmoji = emoji.animated 
                        ? `<a:${emoji.name}:${emoji.id}>`
                        : `<:${emoji.name}:${emoji.id}>`;
                    
                    const placeholder = `${uniquePrefix}${placeholderCount++}`;
                    placeholders.set(placeholder, formattedEmoji);
                    return placeholder;
                }

                logger.debug({ 
                    emojiName,
                    lowercaseName,
                    cacheKeys: Array.from(MODEL_CONFIG.emojiCache.keys())
                }, "Emoji not found in cache");
                return fullMatch;
            });
        };

        // Step 3: Handle edge cases and cleanup
        const cleanupText = (input: string): string => {
            let cleaned = input;
            
            // Sort placeholders by length (longest first) to prevent partial replacements
            const sortedPlaceholders = Array.from(placeholders.entries())
                .sort(([a], [b]) => b.length - a.length);

            // Replace all placeholders with their original emoji
            for (const [placeholder, emoji] of sortedPlaceholders) {
                const escapedPlaceholder = placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                cleaned = cleaned.replace(new RegExp(escapedPlaceholder, 'g'), emoji);
            }

            // Remove any remaining placeholder patterns that weren't properly replaced
            cleaned = cleaned.replace(new RegExp(`${uniquePrefix}\\d+`, 'g'), '');

            return cleaned;
        };

        // Apply processing steps
        let processed = text;
        processed = preserveDiscordEmojis(processed);
        processed = processUnformattedEmojis(processed);
        processed = cleanupText(processed);

        return processed;

    } catch (error) {
        logger.error({ 
            error,
            text: text.slice(0, 100),
            isFromBot
        }, "Error processing emoji text");
        return text;
    }
  }
}

export const emojiService = new EmojiService();