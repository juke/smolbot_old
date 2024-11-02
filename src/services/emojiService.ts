import { Collection, GuildEmoji } from "discord.js";
import { CachedEmoji } from "../types.js";
import { logger } from "./logger.js";
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

    // Initialize rankings for new emojis
    emojis.forEach(emoji => {
      if (emoji.name && !this.emojiRankings.has(emoji.name.toLowerCase())) {
        this.emojiRankings.set(emoji.name.toLowerCase(), 0);
      }
    });

    // Initial update of available emojis
    this.updateAvailableEmojis();
  }

  /**
   * Processes text to properly format any emoji references and track usage
   */
  public processEmojiText(text: string): string {
    // Handle already formatted Discord emojis
    const discordEmojiPattern = /(<a?:[\w-]+:\d+>)/g;
    const preservedEmojis: string[] = [];
    
    // Track emoji usage from formatted emojis
    const formattedMatches = text.matchAll(/<a?:(\w+):\d+>/g);
    for (const match of formattedMatches) {
      this.trackEmojiUsage(match[1].toLowerCase());
    }
    
    // Preserve existing formatted emojis
    const preservedText = text.replace(discordEmojiPattern, (match) => {
      preservedEmojis.push(match);
      return `__EMOJI${preservedEmojis.length - 1}__`;
    });
    
    // Track and format :emoji_name: patterns
    const processedText = preservedText.replace(/:([a-zA-Z0-9_-]+):/g, (_, emojiName) => {
      const lowercaseName = emojiName.toLowerCase();
      this.trackEmojiUsage(lowercaseName);
      
      const emoji = MODEL_CONFIG.emojiCache.get(lowercaseName);
      return emoji 
        ? `<${emoji.animated ? "a" : ""}:${emoji.name}:${emoji.id}>`
        : `:${emojiName}:`;
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
    const topEmojis = Array.from(MODEL_CONFIG.emojiCache.values())
      .sort((a, b) => {
        const rankA = this.emojiRankings.get(a.name.toLowerCase()) ?? 0;
        const rankB = this.emojiRankings.get(b.name.toLowerCase()) ?? 0;
        return rankB - rankA;
      })
      .slice(0, this.maxDisplayedEmojis)
      .map(emoji => `:${emoji.name}:`);

    return topEmojis.join(", ") || "No custom emojis available";
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