// logger.js
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOG_FILE_PATH = path.resolve(__dirname, "monitoring.log");

// Initialize log directory and file
try {
  if (!fs.existsSync(path.dirname(LOG_FILE_PATH))) {
    fs.mkdirSync(path.dirname(LOG_FILE_PATH), { recursive: true });
    console.log(`Created log directory at ${path.dirname(LOG_FILE_PATH)}`);
  }

  // Initialize or clear the log file
  fs.writeFileSync(LOG_FILE_PATH, "=== Monitoring Script Log ===\n", { flag: "w" });
  console.log(`Initialized log file at ${LOG_FILE_PATH}`);
} catch (err) {
  console.error(`Failed to initialize log file: ${err.message}`);
  process.exit(1); // Exit if logging cannot be initialized
}

/**
 * Logs a message to both the console and the log file.
 *
 * @param {string} message - The message to log.
 */
export function logToFile(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;

  fs.appendFile(LOG_FILE_PATH, logMessage, (err) => {
    if (err) {
      console.error(`Failed to write to log file: ${err.message}`);
    }
  });
}
