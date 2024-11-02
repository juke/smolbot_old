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
  private readonly dataDir = "./data";
  private readonly rankingsPath = "./data/emoji-rankings.json";
  private emojiRankings: Map<string, number> = new Map();
  private readonly maxDisplayedEmojis = 15;
  private readonly saveInterval = 10 * 60 * 1000; // Save every 10 minutes
  private readonly updateInterval = 60 * 60 * 1000; // Update cache every hour
  private currentGuildId?: string;
  private currentGuildEmojis?: Collection<string, GuildEmoji>;

  constructor() {
    // Ensure data directory and rankings file exist on startup
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
      await fs.mkdir(this.dataDir, { recursive: true });
      
      // Check if rankings file exists, create it if it doesn't
      try {
        await fs.access(this.rankingsPath);
      } catch {
        // File doesn't exist, create it with empty rankings
        await fs.writeFile(this.rankingsPath, JSON.stringify({}, null, 2));
        logger.info("Created new emoji rankings file");
      }
      
      // Load rankings after ensuring file exists
      await this.loadRankings();
    } catch (error) {
      logger.error({ error }, "Failed to initialize data store");
    }
  }

  /**
   * Updates the available emojis based on current rankings
   */
  private updateAvailableEmojis(): void {
    if (!this.currentGuildId || !this.currentGuildEmojis) return;

    MODEL_CONFIG.emojiCache.clear();
    
    // Get top 15 emojis based on rankings
    const topEmojis = Array.from(this.currentGuildEmojis.values())
      .filter(emoji => emoji.name)
      .sort((a, b) => {
        const rankA = this.emojiRankings.get(a.name?.toLowerCase() ?? "") ?? 0;
        const rankB = this.emojiRankings.get(b.name?.toLowerCase() ?? "") ?? 0;
        return rankB - rankA;
      })
      .slice(0, this.maxDisplayedEmojis);

    // Cache top emojis
    topEmojis.forEach(emoji => {
      if (!emoji.name) return;
      
      MODEL_CONFIG.emojiCache.set(emoji.name.toLowerCase(), {
        id: emoji.id,
        name: emoji.name,
        animated: emoji.animated ?? false,
        guildId: this.currentGuildId!
      });
    });
    
    logger.debug({ 
      guildId: this.currentGuildId,
      cachedEmojis: Array.from(MODEL_CONFIG.emojiCache.keys()),
      topRankings: Object.fromEntries(
        Array.from(this.emojiRankings.entries())
          .sort(([, a], [, b]) => b - a)
          .slice(0, this.maxDisplayedEmojis)
      )
    }, "Updated available emojis based on rankings");
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

    MODEL_CONFIG.emojiCache.clear();

    emojis.forEach(emoji => {
      if (!emoji.name) return;
      
      const lowercaseName = emoji.name.toLowerCase();
      
      MODEL_CONFIG.emojiCache.set(lowercaseName, {
        id: emoji.id,
        name: lowercaseName,
        animated: emoji.animated ?? false,
        guildId: guildId
      });

      if (!this.emojiRankings.has(lowercaseName)) {
        this.emojiRankings.set(lowercaseName, 0);
      }
    });

    logger.debug({
      guildId,
      cachedEmojis: Array.from(MODEL_CONFIG.emojiCache.values()).map(e => e.name),
      emojiCount: MODEL_CONFIG.emojiCache.size
    }, "Updated emoji cache");

    this.updateAvailableEmojis();
  }

  /**
   * Processes text to properly format any emoji references and track usage
   */
  public processEmojiText(text: string): string {
    // First, preserve any already formatted Discord emojis
    const formattedEmojiPattern = /<(a)?:[\w-]+:\d+>/g;
    const preservedEmojis: string[] = [];
    
    const preservedText = text.replace(formattedEmojiPattern, (match) => {
      preservedEmojis.push(match);
      return `__EMOJI${preservedEmojis.length - 1}__`;
    });

    // Process unformatted emoji patterns
    const processedText = preservedText.replace(/:([\w-]+):/g, (fullMatch, emojiName) => {
      const lowercaseName = emojiName.toLowerCase();
      const emoji = MODEL_CONFIG.emojiCache.get(lowercaseName);

      if (emoji) {
        this.trackEmojiUsage(lowercaseName);
        // Format with proper Discord emoji syntax
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
      .map(({ name }) => name);

    logger.debug({
      availableEmojis: emojiList,
      cacheSize: MODEL_CONFIG.emojiCache.size,
      rankings: Object.fromEntries(this.emojiRankings)
    }, "Getting available emojis");

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