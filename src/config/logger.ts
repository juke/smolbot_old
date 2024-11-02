import pino from "pino";

/**
 * Configures and exports the application logger
 */
export const logger = pino.default({
  level: "debug",
  transport: {
    target: "pino-pretty",
    options: {
      colorize: true,
      translateTime: "SYS:standard",
      ignore: "pid,hostname"
    }
  }
}); 