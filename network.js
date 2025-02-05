// network.js
import fetch from "node-fetch";
import { logToFile } from "./logger.js";
import { randomBytes } from "crypto";
import { signTypedData } from "@metamask/eth-sig-util";
import dotenv from "dotenv";

dotenv.config();

const API_BASE_URL = "https://api.sx.bet";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const MAKER_ADDRESS = process.env.USER_ADDRESS;

/**
 * Fetch with timeout.
 *
 * @param {string} url - The URL to fetch.
 * @param {object} options - Fetch options.
 * @param {number} timeoutMs - Timeout in milliseconds.
 * @returns {Promise<Response>}
 */
export async function fetchWithTimeout(url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return response;
  } catch (err) {
    clearTimeout(id);
    if (err.name === "AbortError") {
      throw new Error(`Request to ${url} timed out after ${timeoutMs}ms`);
    }
    throw err;
  }
}

/**
 * Fetch the user’s active orders for this market with retry logic.
 *
 * @param {string} marketHash - The market to fetch orders for.
 * @param {string} makerAddress - The address of the maker.
 * @param {number} maxRetries - Maximum number of retries before giving up (default: 3).
 * @returns {Promise<object[]>} - Array of active orders or an empty array if all retries fail.
 */
export async function fetchActiveOrders(marketHash, makerAddress, maxRetries = 3) {
    let attempt = 0;
  
    while (attempt < maxRetries) {
      try {
        const url = `${API_BASE_URL}/orders?marketHashes=${marketHash}&maker=${makerAddress}`;
        logToFile(`Fetching active orders from URL (attempt ${attempt + 1}/${maxRetries}): ${url}`);
  
        const response = await fetchWithTimeout(url, {}, 5000); // 5s timeout
        logToFile(`Fetched response status for active orders: ${response.status}`);
  
        const data = await response.json();
        logToFile(`Active orders data for ${marketHash}: ${JSON.stringify(data)}`);
  
        if (!response.ok || !data?.data) {
          throw new Error(`Unexpected response for active orders: ${JSON.stringify(data)}`);
        }
  
        return data.data; // Return the valid orders if fetch is successful
  
      } catch (err) {
        logToFile(`⚠️ Error fetching active orders for ${marketHash} (attempt ${attempt + 1}): ${err.message}`);
  
        attempt++;
        if (attempt < maxRetries) {
          logToFile(`🔄 Retrying in 2 seconds...`);
          await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds before retrying
        } else {
          logToFile(`❌ Max retries reached. Skipping order placement for ${marketHash} this iteration.`);
        }
      }
    }
  
    return []; // Return empty array if all retries failed
  }
  

/**
 * Cancels an array of order hashes belonging to the user.
 *
 * @param {string[]} orderHashes - Array of order hashes to cancel.
 */
export async function cancelOrdersForMonitoring(orderHashes) {
  if (!orderHashes.length) return;

  const salt = `0x${randomBytes(32).toString("hex")}`;
  const timestamp = Math.floor(Date.now() / 1000);

  // EIP712 typed data structure
  const payload = {
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "salt", type: "bytes32" },
      ],
      Details: [
        { name: "orderHashes", type: "string[]" },
        { name: "timestamp", type: "uint256" },
      ],
    },
    primaryType: "Details",
    domain: {
      name: "CancelOrderV2SportX",
      version: "1.0",
      chainId: 4162,
      salt,
    },
    message: { orderHashes, timestamp },
  };

  const privateKeyBuffer = Buffer.from(PRIVATE_KEY.replace(/^0x/, ""), "hex");
  const signature = signTypedData({
    privateKey: privateKeyBuffer,
    data: payload,
    version: "V4",
  });

  const apiPayload = {
    signature,
    orderHashes,
    salt,
    maker: MAKER_ADDRESS,
    timestamp,
  };

  try {
    const response = await fetchWithTimeout(`${API_BASE_URL}/orders/cancel/v2?chainVersion=SXR`, {
      method: "POST",
      body: JSON.stringify(apiPayload),
      headers: { "Content-Type": "application/json" },
    }, 5000);

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Failed to cancel orders: ${response.statusText} - ${errText}`);
    }

    logToFile(`Canceled orders: ${JSON.stringify(orderHashes)}`);
  } catch (err) {
    logToFile(`Error canceling orders: ${err.message}`);
  }
}
