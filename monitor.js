/**
 * MONITOR.JS
 *
 * This file:
 *  - Receives messages from the main process to "start", "stop", "stopAll", or "update" monitoring a given market
 *  - Places/cancels orders on SX Bet to maintain an iceberg position:
 *    1. If no user orders are active for the market, place the first order (increments).
 *    2. If there's an active user order but the top-of-book moved, cancel & repost.
 *    3. Check if we've reached the max fill. If so, stop monitoring.
 *    4. Check if the market vig is above the user’s limit; if above, cancel orders.
 */
import fetch from "node-fetch";
import dotenv from "dotenv";
import BigNumber from "bignumber.js";
import { Wallet, getBytes, solidityPackedKeccak256 } from "ethers";
import { randomBytes } from "crypto";
import { API_BASE_URL, BASE_TOKEN, EXECUTOR, IMPLIED_ODDS_MULTIPLIER, ODDS_LADDER_STEP_SIZE } from "./config.js";
import * as Ably from "ably";
import { logToFile } from "./logger.js";
import { fetchWithTimeout, fetchActiveOrders, cancelOrdersForMonitoring } from "./network.js";

// ===================== ENVIRONMENT SETUP =====================

dotenv.config();

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const MAKER_ADDRESS = process.env.USER_ADDRESS;

// ===================== WEBSOCKET (ORDERBOOK) =====================
const ablyClient = new Ably.Realtime({
  authCallback: async (tokenParams, callback) => {
    try {
      const response = await fetch("https://api.sx.bet/user/token", {
        headers: { "X-Api-Key": process.env.SX_BET_API_KEY },
      });
      const tokenRequest = await response.json();
      callback(null, tokenRequest);
    } catch (error) {
      callback(error, null);
    }
  },
});

const orderBooks = new Map();

async function subscribeToOrderBook(marketHash) {
  const token = "0x6629Ce1Cf35Cc1329ebB4F63202F3f197b3F050B"; // Update with your SX token
  const channel = ablyClient.channels.get(`order_book:${token}:${marketHash}`);

  logToFile(`🔍 Subscribing to WebSocket order book: order_book:${token}:${marketHash}`);

  // Step 1: Fetch initial order book from API
  await fetchInitialOrderBook(marketHash);

  // Step 2: Subscribe to WebSocket updates
  channel.subscribe((message) => {
    logToFile(`📡 WebSocket message received for ${marketHash}. Raw data: ${JSON.stringify(message.data, null, 2)}`);
    handleOrderBookUpdate(marketHash, message.data);
  });

  logToFile(`✅ Subscribed to order book for market: ${marketHash}`);
}

async function fetchInitialOrderBook(marketHash) {
  try {
    const url = `${API_BASE_URL}/orders?marketHashes=${marketHash}`;
    logToFile(`🔍 Fetching initial order book from API: ${url}`);

    const response = await fetchWithTimeout(url, {}, 5000); // 5-second timeout
    if (!response.ok) {
      throw new Error(`Failed to fetch initial order book: ${response.statusText}`);
    }

    const data = await response.json();
    if (!data?.data || !Array.isArray(data.data)) {
      throw new Error(`Invalid order book data format received.`);
    }

    // Convert API data to WebSocket format (if necessary)
    const formattedOrders = data.data.map(order => [
      order.orderHash,
      "ACTIVE",
      order.fillAmount,
      order.maker,
      order.totalBetSize,
      order.percentageOdds,
      order.expiry,
      order.apiExpiry,
      order.salt,
      order.isMakerBettingOutcomeOne,
      order.signature,
      order.updateTime,
      order.chainVersion,
      order.sportXeventId,
    ]);

    // Store orders in our order book map
    handleOrderBookUpdate(marketHash, formattedOrders);
    logToFile(`✅ Initial order book fetched for ${marketHash}. Orders: ${formattedOrders.length}`);
  } catch (err) {
    logToFile(`⚠️ Error fetching initial order book for ${marketHash}: ${err.message}`);
  }
}

function handleOrderBookUpdate(marketHash, orders, minOrderSize = 100) {
    if (!orderBooks.has(marketHash)) {
        orderBooks.set(marketHash, []);
    }
  
    const orderBook = orderBooks.get(marketHash);
    const newOrderBook = [];
  
    let validOrders = 0;
  
    for (const order of orders) {
        const rawSize = new BigNumber(order[4]); // Raw order size
        const orderSize = rawSize.div(1e6); // Convert units properly
  
        // Ignore small orders AND bot's own orders
        if (orderSize.lt(minOrderSize) || order[3] === MAKER_ADDRESS) {
            logToFile(`🚫 Ignoring small order: ${order[0]} (${orderSize.toFixed(4)} units)`);
            continue;
        }
  
        newOrderBook.push({
            orderHash: order[0],
            status: order[1],
            maker: order[3],
            totalBetSize: orderSize.toFixed(4),
            percentageOdds: order[5],
            expiry: order[6],
            isMakerBettingOutcomeOne: order[9],
            updateTime: order[11]
        });
  
        validOrders++;
    }
  
    // ✅ **Instead of overwriting, merge new valid orders with existing orders**
    orderBooks.set(marketHash, [...orderBook, ...newOrderBook]);
  
    logToFile(`📡 Order book updated for market: ${marketHash}. Valid orders: ${validOrders}`);
}

// ===================== ORDERBOOK PROCESSING & CALCULATIONS =====================
function getMarketDataFromOrderBook(marketHash, isUserBettingOutcomeOne, minOrderSize = 100) {
    const orders = orderBooks.get(marketHash) || [];
    let bestMakerProbOpposite = 0;
    let validOrders = 0;
  
    for (const order of orders) {
      const orderSize = new BigNumber(order.totalBetSize); // Already converted in `handleOrderBookUpdate`
  
      if (orderSize.lt(minOrderSize)) {
        logToFile(`🚫 Ignoring small order for market odds: ${order.orderHash} (${orderSize.toFixed(4)} units)`);
        continue;
      }
  
      if (order.isMakerBettingOutcomeOne !== isUserBettingOutcomeOne) {
        const probability = parseFloat(order.percentageOdds) / 1e20;
        if (probability > bestMakerProbOpposite) {
          bestMakerProbOpposite = probability;
        }
        validOrders++;
      }
    }
  
    const bestTakerOdds = 1 - bestMakerProbOpposite;
    logToFile(`📊 Found ${validOrders} valid orders for market ${marketHash}`);
    return { bestTakerOdds, vig: getVigFromOrderBook(marketHash, minOrderSize) };
}

function getVigFromOrderBook(marketHash, minOrderSize = 100) {
    const orders = orderBooks.get(marketHash) || [];
    let bestMakerProbO1 = 0, bestMakerProbO2 = 0;
    let validOrders = 0;
  
    for (const order of orders) {
      const orderSize = new BigNumber(order.totalBetSize);
  
      if (orderSize.lt(minOrderSize)) {
        logToFile(`🚫 Ignoring small order for vig calculation: ${order.orderHash} (${orderSize.toFixed(4)} units)`);
        continue;
      }
  
      const probability = parseFloat(order.percentageOdds) / 1e20;
      if (order.isMakerBettingOutcomeOne) {
        bestMakerProbO1 = Math.max(bestMakerProbO1, probability);
      } else {
        bestMakerProbO2 = Math.max(bestMakerProbO2, probability);
      }
  
      validOrders++;
    }
  
    if (validOrders === 0) {
      logToFile(`⚠️ No valid orders found for vig calculation in ${marketHash}. Returning default vig.`);
      return 0.0; // Default to 0 if no valid orders
    }
  
    const bestTakerOddsO1 = 1 - bestMakerProbO2;
    const bestTakerOddsO2 = 1 - bestMakerProbO1;
    const vig = (bestTakerOddsO1 + bestTakerOddsO2) - 1;
  
    logToFile(`📈 Vig Calculation for ${marketHash}: BestTakerOddsO1=${bestTakerOddsO1.toFixed(6)}, BestTakerOddsO2=${bestTakerOddsO2.toFixed(6)}, Vig=${vig.toFixed(6)}`);
  
    return vig;
}

function roundDownOddsToNearestStep(oddsBigNum) {
    // For example, step = 0.0025 => scaled step = 0.0025 * 1e20 = 2.5e17
    const step = new BigNumber(ODDS_LADDER_STEP_SIZE).times(IMPLIED_ODDS_MULTIPLIER);
    return oddsBigNum.div(step).integerValue(BigNumber.ROUND_FLOOR).times(step);
}

// MONITORING CONFIG
const monitoringConfig = new Map();

// ===================== ORDER EXECUTION & MANAGEMENT =====================
async function postOrderForPosition(marketHash, outcome, amount, edge, minOrderSize = 100) {
    if (!monitoringConfig.has(marketHash)) {
      logToFile(`🚨 Failsafe triggered: Market ${marketHash} is no longer monitored. Skipping order.`);
      return null;
    }
  
    try {
      const { bestTakerOdds } = getMarketDataFromOrderBook(marketHash, outcome === 1, minOrderSize);
      
      if (!bestTakerOdds || bestTakerOdds <= 0 || bestTakerOdds >= 1) {
        logToFile(`⚠️ No valid taker odds available for market ${marketHash}, outcome ${outcome}. Skipping post.`);
        return null;
      }
  
      const adjustedTakerOdds = bestTakerOdds * (1 - edge / 100);
      const newMakerProb = adjustedTakerOdds;
  
      if (newMakerProb <= 0 || newMakerProb >= 1) {
        logToFile(`🚨 Invalid makerProb=${newMakerProb} for market ${marketHash}. Skipping order.`);
        return null;
      }
  
      logToFile(`📝 Preparing to post order for ${marketHash}, outcome ${outcome}. Adjusted taker odds: ${adjustedTakerOdds.toFixed(6)}`);
  
      let scaledMakerOddsBN = new BigNumber(newMakerProb).times(IMPLIED_ODDS_MULTIPLIER);
      scaledMakerOddsBN = roundDownOddsToNearestStep(scaledMakerOddsBN);
      const finalPercentageOdds = scaledMakerOddsBN.toFixed(0);
  
      const scaledAmount = new BigNumber(amount).times(new BigNumber(10).pow(6)).toFixed(0);
  
      if (!monitoringConfig.has(marketHash)) {
        logToFile(`🚨 Post-execution check: Market ${marketHash} was stopped AFTER calculating order! Aborting.`);
        return null;
      }
  
      if (isNaN(Number(scaledAmount))) {
        logToFile(`Invalid scaledAmount (${scaledAmount}) for market ${marketHash}. Skipping order.`);
        return null;
      }
  
      const isMakerBettingOutcomeOne = outcome === 1;
      const saltBytes = randomBytes(32);
  
      const order = {
        marketHash,
        maker: MAKER_ADDRESS,
        baseToken: BASE_TOKEN,
        totalBetSize: scaledAmount,
        percentageOdds: finalPercentageOdds,
        apiExpiry: Math.floor(Date.now() / 1000) + 300,
        expiry: 2209006800,
        executor: EXECUTOR,
        isMakerBettingOutcomeOne,
        salt: `0x${saltBytes.toString("hex")}`,
      };
  
      logToFile(`Order details: ${JSON.stringify(order)}`);
  
      const orderHashBytes = getBytes(
        solidityPackedKeccak256(
          ["bytes32", "address", "uint256", "uint256", "uint256", "uint256", "address", "address", "bool"],
          [order.marketHash, order.baseToken, order.totalBetSize, order.percentageOdds, order.expiry, order.salt, order.maker, order.executor, order.isMakerBettingOutcomeOne]
        )
      );
  
      const wallet = new Wallet(PRIVATE_KEY);
      order.signature = await wallet.signMessage(orderHashBytes);
  
      try {
        const postUrl = `${API_BASE_URL}/orders/new`;
        logToFile(`Posting order to URL: ${postUrl}`);
        const response = await fetchWithTimeout(postUrl, {
          method: "POST",
          body: JSON.stringify({ orders: [order] }),
          headers: { "Content-Type": "application/json" },
        }, 5000);
  
        if (!response.ok) {
          const errorText = await response.text();
          logToFile(`Order post error: ${errorText}`);
          throw new Error(`Failed to post order: ${response.statusText}`);
        }
  
        logToFile(`✅ Successfully posted order for market ${marketHash}, outcome ${outcome}.`);
  
        return `0x${Buffer.from(orderHashBytes).toString("hex")}`;
      } catch (err) {
        logToFile(`Error in postOrderForPosition: ${err.message}`);
        return null;
      }
    } catch (err) {
      logToFile(`Error in postOrderForPosition: ${err.message}`);
      return null;
    }
}

// ===================== MONITORING LOGIC =====================
/**
 * This loop runs continuously, checking each monitored market.
 * For each market:
 *  1. Check the total fill => if >= maxFill, stop monitoring.
 *  2. Check the vig => if > maxVig, cancel orders.
 *  3. If no active order, post our increments.
 *  4. If there's an active order not matching the “desired edge,” cancel & repost.
 */
async function monitoringLoop() {
  logToFile("Monitoring loop started.");
  while (true) {
    logToFile("Monitoring loop iteration started.");
    for (const [marketHash, config] of monitoringConfig.entries()) {
      try {
        await processMarket(marketHash, config);
      } catch (err) {
        logToFile(`Error in processMarket for ${marketHash}: ${err.message}`);
      }
    }
    logToFile("Monitoring loop iteration completed. Sleeping for 3.5 seconds.");
    // Sleep for 3.5 seconds before next iteration
    await new Promise((resolve) => setTimeout(resolve, 3500));
  }
}

async function processMarket(marketHash, config) {
  logToFile(`Processing market ${marketHash}: outcome=${config.outcome}, maxFill=${config.maxFill}, increments=${config.increments}, edge=${config.edge}, maxVig=${config.maxVig}, startTime=${config.startTime}, minOrderSize=${config.minOrderSize}`);

  const { outcome, maxFill, increments, edge, maxVig, startTime, minOrderSize } = config;

  // 1) Calculate total filled volume
  const totalFilledBN = await getFilledVolumeSinceStart(marketHash, startTime);
  const totalFilledBase = totalFilledBN.div(1e6).toNumber(); // Convert to base units

  logToFile(`📦 ${marketHash} progress: ${totalFilledBase}/${maxFill} (${((totalFilledBase / maxFill) * 100).toFixed(1)}%)`);

  if (isNaN(totalFilledBase)) {
      logToFile(`🚨 Total filled volume is NaN for market ${marketHash}. Skipping processing.`);
      return;
  }

  // 2) If remaining fill is less than 10 units, consider it filled and stop monitoring
  const remainingNeeded = maxFill - totalFilledBase;
  if (remainingNeeded < 10) {
      logToFile(`✅ Remaining fill for ${marketHash} is below 10 units (${remainingNeeded.toFixed(4)}). Marking as fully filled.`);
      monitoringConfig.delete(marketHash);
      return;
  }

  // 3) Check vig using real-time order book data (WebSocket)
  const { bestTakerOdds, vig } = getMarketDataFromOrderBook(marketHash, outcome === 1, minOrderSize);
  if (vig > maxVig) {
    logToFile(`⚠️ Vig ${vig.toFixed(6)} > maxVig ${maxVig}. Checking order book validity before canceling orders.`);
  
    // Double-check the order book before canceling orders
    const orderBookCheck = orderBooks.get(marketHash);
    if (!orderBookCheck || orderBookCheck.length === 0) {
      logToFile(`⚠️ No valid orders in order book for ${marketHash}. Skipping cancel action.`);
      return;
    }
  
    logToFile(`❌ Canceling orders due to high vig.`);
    const activeOrders = await fetchActiveOrders(marketHash, MAKER_ADDRESS);
    await cancelOrdersForMonitoring(activeOrders.map(o => o.orderHash));
    return;
  }

  // 4) Fetch active orders
    const activeOrders = await fetchActiveOrders(marketHash, MAKER_ADDRESS, 3);

    if (activeOrders.length === 0) {
        if (remainingNeeded < 10) {
            logToFile(`🚨 Not posting new order. Remaining size (${remainingNeeded.toFixed(4)}) is below 10 units.`);
            monitoringConfig.delete(marketHash);
            return;
        }
  
        // 🛑 **Only post if fetchActiveOrders succeeded!**
        if (activeOrders === null) {
            logToFile(`⚠️ Skipping order post due to active order fetch failure.`);
            return;
        }

        const sizeToPost = Math.min(remainingNeeded, increments);
  
        logToFile(`🆕 Posting new order (${sizeToPost.toFixed(4)} units)`);
        await postOrderForPosition(marketHash, outcome, sizeToPost, edge, minOrderSize);
        return;
    }
  

  // 5) Ensure active orders are at correct edge
  if (bestTakerOdds <= 0 || bestTakerOdds >= 1) {
      logToFile(`⚠️ No valid taker odds (or out of range) for market ${marketHash}; skipping cancel/repost.`);
      return;
  }

  const desiredTakerOdds = bestTakerOdds * (1 - edge / 100);
  const desiredMakerProb = desiredTakerOdds;
  if (isNaN(desiredMakerProb)) {
      logToFile(`🚨 Invalid desiredMakerProb calculation. Skipping posting.`);
      return;
  }

  const desiredMakerOddsScaled = new BigNumber(desiredMakerProb).times(IMPLIED_ODDS_MULTIPLIER);
  const desiredLadderedOddsBN = roundDownOddsToNearestStep(desiredMakerOddsScaled);
  const desiredLadderedOddsStr = desiredLadderedOddsBN.toFixed(0);

  logToFile(`Desired takerOdds (readable): ${desiredTakerOdds.toFixed(6)}, Scaled: ${desiredLadderedOddsStr}`);

  let needsRepost = false;
  for (const order of activeOrders) {
      if (order.percentageOdds !== desiredLadderedOddsStr) {
          needsRepost = true;
          logToFile(`⚠️ Order ${order.orderHash} has mismatched odds. Expected: ${desiredLadderedOddsStr}, Found: ${order.percentageOdds}`);
          break;
      }
  }

  if (needsRepost) {
      const hashesToCancel = activeOrders.map(o => o.orderHash);
      await cancelOrdersForMonitoring(hashesToCancel);

      const sizeToPost = Math.min(remainingNeeded, increments);
      if (sizeToPost < 10) {
          logToFile(`🚨 Not reposting. Remaining size (${sizeToPost.toFixed(4)}) is below 10 units.`);
          monitoringConfig.delete(marketHash);
          return;
      }

      await postOrderForPosition(marketHash, outcome, sizeToPost, edge, minOrderSize);
  } else {
      logToFile(`✅ Active orders are still competitive for ${marketHash}. No need to repost.`);
  }
}

/**
 * Fetch the total trades for the user on this market since we started monitoring.
 *
 * We'll sum up 'stake' from the trades to see how much has been filled.
 *
 * @param {string} marketHash
 * @param {number} startTimestamp - when we began monitoring (in milliseconds)
 * @returns {BigNumber} - total filled volume
 */
async function getFilledVolumeSinceStart(marketHash, startTimestamp) {
    try {
      logToFile(`Attempting to fetch trades with startTimestamp: ${startTimestamp}`);
  
      // ===== Added Validation =====
      if (!startTimestamp || isNaN(startTimestamp)) {
        throw new Error(`Invalid startTimestamp: ${startTimestamp}`);
      }
  
      const startDate = new Date(startTimestamp);
      if (isNaN(startDate.getTime())) {
        logToFile(`Invalid Date object created from startTimestamp: ${startTimestamp}`);
        throw new Error(`Invalid Date object created from startTimestamp: ${startTimestamp}`);
      } else {
        logToFile(`Valid Date object: ${startDate.toISOString()}`);
      }
      // ===== End of Validation =====
  
      const startDateISO = startDate.toISOString();
      const url = `${API_BASE_URL}/trades?marketHashes=${marketHash}&startDate=${startDateISO}&bettor=${MAKER_ADDRESS}&chainVersion=SXR`;
      logToFile(`Fetching trades from URL: ${url}`);
  
      const response = await fetchWithTimeout(url, {}, 5000); // 5-second timeout
      logToFile(`Fetched response status for trades: ${response.status}`);
  
      const data = await response.json();
      logToFile(`Fetched trades data for ${marketHash}: ${JSON.stringify(data)}`);
  
      if (!data.data || !Array.isArray(data.data.trades)) {
        logToFile(`Unexpected trades data format for ${marketHash}: ${JSON.stringify(data)}`);
        return new BigNumber(0);
      }
  
      let filledVolume = new BigNumber(0);
      for (const trade of data.data.trades) {
        const betSize = new BigNumber(trade.stake);
        if (betSize.isNaN()) {
          logToFile(`Invalid bet size in trade: ${JSON.stringify(trade)}`);
          continue; // Skip invalid bet sizes
        }
        filledVolume = filledVolume.plus(betSize);
      }
  
      logToFile(`Total filled volume for ${marketHash}: ${filledVolume.toString()}`);
      return filledVolume;
    } catch (err) {
      logToFile(`Error fetching trades for ${marketHash}: ${err.message}`);
      return new BigNumber(0);
    }
}

// ===================== PROCESS MESSAGE HANDLERS =====================
process.on("message", async (message) => {
  if (!message || !message.action) return;

  const { action, marketHash, config } = message;

  logToFile(`Received message: ${JSON.stringify(message)}`);

   if (action === "start") {
    // ===== Ensure startTime is properly set =====
    if (!config.startTime || isNaN(config.startTime)) {
      config.startTime = Date.now(); // Current time in milliseconds
      logToFile(`startTime not provided or invalid. Setting startTime to current time: ${config.startTime}`);
    } else {
      // ===== Handle timestamps given in seconds instead of milliseconds =====
      if (config.startTime < 1e12) { // Unix timestamp in milliseconds is >1e12
        config.startTime = config.startTime * 1000; // Convert seconds to milliseconds
        logToFile(`Detected startTime in seconds. Converted to milliseconds: ${config.startTime}`);
      }
    }
    // ===== End of Added Time Fix =====

    // ✅ Store the new monitoring configuration
    monitoringConfig.set(marketHash, config);
    logToFile(`✅ Started monitoring market: ${marketHash}`);

    // 🔹 Ensure real-time updates are received
    subscribeToOrderBook(marketHash);

    logToFile(`📡 Subscribed to real-time order book for market: ${marketHash}`);
    // You can initiate monitoring logic here if needed
  } else if (action === "stop") {
    if (monitoringConfig.has(marketHash)) {
      const pos = monitoringConfig.get(marketHash);
      logToFile(`Stopping monitoring for market: ${marketHash} (${pos.marketDetails.teamOneName} vs. ${pos.marketDetails.teamTwoName} // ${pos.outcome === 1 ? pos.marketDetails.outcomeOneName : pos.marketDetails.outcomeTwoName})`);

      // Fetch active orders for this market and maker
      const activeOrders = await fetchActiveOrders(marketHash, MAKER_ADDRESS);
      const orderHashes = activeOrders.map(order => order.orderHash);

      if (orderHashes.length > 0) {
        // Cancel the orders
        await cancelOrdersForMonitoring(orderHashes);
        logToFile(`Canceled orders for market ${marketHash}: ${orderHashes.join(", ")}`);
      } else {
        logToFile(`No active orders to cancel for market ${marketHash}`);
      }

      // Remove the market from monitoringConfig
      monitoringConfig.delete(marketHash);
      logToFile(`Stopped monitoring market: ${marketHash}`);
    } else {
      logToFile(`Attempted to stop monitoring non-existent market: ${marketHash}`);
    }
  } else if (action === "stopAll") {
    await stopAllMarkets();
  } else if (action === "update") {
    if (monitoringConfig.has(marketHash)) {
      const pos = monitoringConfig.get(marketHash);
      const updatedConfig = { ...pos, ...config };
      monitoringConfig.set(marketHash, updatedConfig);
      logToFile(`Updated monitoring configuration for market: ${marketHash}`);

      // You can implement additional logic to handle configuration updates if needed
    } else {
      logToFile(`Attempted to update non-existent market: ${marketHash}`);
    }
  }
});

// ===================== GRACEFUL SHUTDOWN & CLEANUP =====================
/**
 * Handles graceful shutdown on receiving termination signals.
 */
async function gracefulShutdown(signal) {
  logToFile(`Received ${signal}. Initiating graceful shutdown.`);
  await stopAllMarkets();
}

// Handle termination signals for graceful shutdown
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

/**
 * Cancels all active orders across all monitored markets and clears the monitoring configuration.
 */
async function stopAllMarkets() {
  logToFile("Initiating graceful shutdown: Canceling all active orders.");
  
  const allOrderHashes = [];
  
  for (const [marketHash, config] of monitoringConfig.entries()) {
    logToFile(`Fetching active orders for market: ${marketHash}`);
    const activeOrders = await fetchActiveOrders(marketHash, MAKER_ADDRESS);
    
    if (activeOrders.length > 0) {
      const orderHashes = activeOrders.map(order => order.orderHash);
      allOrderHashes.push(...orderHashes);
      logToFile(`Found ${orderHashes.length} active orders for market ${marketHash}: ${orderHashes.join(", ")}`);
    } else {
      logToFile(`No active orders found for market ${marketHash}.`);
    }
  }
  
  if (allOrderHashes.length > 0) {
    logToFile(`Canceling all ${allOrderHashes.length} active orders.`);
    await cancelOrdersForMonitoring(allOrderHashes);
  } else {
    logToFile("No active orders to cancel.");
  }
  
  monitoringConfig.clear();
  logToFile("Cleared all monitoring configurations.");
  
  logToFile("Graceful shutdown completed. Exiting process.");
  process.exit(0);
}

// ===================== START THE LOOP =====================
monitoringLoop().catch((err) => {
  logToFile(`Fatal error in monitoring loop: ${err.message}`);
  process.exit(1);
});
