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
const MAKER_ADDRESS = process.env.USER_ADDRESS.toLowerCase();

// *** NEW: We’ll store the last time we posted an order per market to enforce a “cool-down” ***
const COOL_DOWN_MS = 5000; // e.g. 5 seconds
const lastPostTimes = new Map(); // { marketHash => timestamp }

// *** NEW: We’ll allow a small fill tolerance so if we’re 99% filled, we treat it as done ***
const FILL_TOLERANCE = 0.99; // i.e. 99% fill is considered "complete"

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

// Subscribe to the channel that tracks your own orders' fill changes
subscribeToActiveOrders();

const orderBooks = new Map();

// A helper structure to track fill amounts across multiple user orders in the same market
const userOrdersByMarket = new Map(); 
// shape: { marketHash => { orderHash => fill, ... }, ... }

// ===================== SUBSCRIBE TO ORDER BOOK =====================
async function subscribeToOrderBook(marketHash) {
  const token = "0x6629Ce1Cf35Cc1329ebB4F63202F3f197b3F050B"; // SX token
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

// ===================== SUBSCRIBE TO YOUR ACTIVE ORDERS =====================
/**
 * Whenever an order's fillAmount changes, update our userFills map.
 *
 * *** Fix applied ***: If an order is INACTIVE, we finalize the fill so
 * getLocalFillForMarket() sees the matched volume.
 */
function subscribeToActiveOrders() {
  const token = BASE_TOKEN.toLowerCase();
  const user = MAKER_ADDRESS.toLowerCase();

  const channelName = `active_orders:${token}:${user}`;
  const channel = ablyClient.channels.get(channelName);

  logToFile(`🔔 Subscribing to active orders channel: ${channelName}`);

  channel.subscribe((message) => {
    logToFile(`🔔 active_orders update => ${JSON.stringify(message.data)}`);

    if (!Array.isArray(message.data)) return;

    for (const row of message.data) {
      // row format: [orderHash, marketHash, status, fillAmount, totalBetSize, ...]
      const orderHash = row[0];
      const marketHash = row[1];
      const status = row[2];
      const fillAmountBN = new BigNumber(row[3]);
      const totalBetSizeBN = new BigNumber(row[4]);

      const fillAmount = fillAmountBN.div(1e6).toNumber();
      const totalBetSize = totalBetSizeBN.div(1e6).toNumber();

      logToFile(`Order ${orderHash} for market ${marketHash} fillAmount=${fillAmount}`);
      updateUserOrderFill(marketHash, orderHash, fillAmount);

      if (status === "INACTIVE") {
        logToFile(`Order ${orderHash} is INACTIVE for ${marketHash}, fill=${fillAmount}/${totalBetSize}`);

        // If near full, treat it as final fill
        const nearFull = fillAmount >= totalBetSize * 0.99;
        const finalFill = nearFull ? totalBetSize : fillAmount;

        // Overwrite the fill with finalFill so we don’t lose it
        updateUserOrderFill(marketHash, orderHash, finalFill);

        // Optionally remove it from the map if you prefer:
        // removeUserOrderFromMap(marketHash, orderHash);
      }
    }
  });
}

function updateUserOrderFill(marketHash, orderHash, fill) {
  let ordersMap = userOrdersByMarket.get(marketHash);
  if (!ordersMap) {
    ordersMap = new Map();
    userOrdersByMarket.set(marketHash, ordersMap);
  }
  ordersMap.set(orderHash, fill);
}

function removeUserOrderFromMap(marketHash, orderHash) {
  let ordersMap = userOrdersByMarket.get(marketHash);
  if (ordersMap) {
    ordersMap.delete(orderHash);
  }
}

// ===================== FETCH INITIAL ORDER BOOK =====================
async function fetchInitialOrderBook(marketHash) {
  try {
    const url = `${API_BASE_URL}/orders?marketHashes=${marketHash}`;
    logToFile(`🔍 Fetching initial order book from API: ${url}`);

    const response = await fetchWithTimeout(url, {}, 5000); // 5s timeout
    if (!response.ok) {
      throw new Error(`Failed to fetch initial order book: ${response.statusText}`);
    }

    const data = await response.json();
    if (!data?.data || !Array.isArray(data.data)) {
      throw new Error(`Invalid order book data format received.`);
    }

    // Convert API data to WebSocket format if needed
    const formattedOrders = data.data.map((order) => [
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

    handleOrderBookUpdate(marketHash, formattedOrders);
    logToFile(`✅ Initial order book fetched for ${marketHash}. Orders: ${formattedOrders.length}`);
  } catch (err) {
    logToFile(`⚠️ Error fetching initial order book for ${marketHash}: ${err.message}`);
  }
}

/**
 * handleOrderBookUpdate
 * 
 * Now includes logic to detect if your own order is INACTIVE with a final fill,
 * so we can record it in userOrdersByMarket (similar to subscribeToActiveOrders).
 */
function handleOrderBookUpdate(marketHash, orders, minOrderSize = 100) {
    if (!orderBooks.has(marketHash)) {
      orderBooks.set(marketHash, []);
    }
  
    const orderBook = orderBooks.get(marketHash);
    const newOrders = [];
    let validExternalCount = 0;
  
    for (const o of orders) {
      // The raw array structure from your WebSocket or fetch:
      // [ orderHash, status, fillAmount, maker, totalBetSize, percentageOdds, expiry, apiExpiry, salt, isMakerBettingOutcomeOne, signature, updateTime, chainVersion, sportXeventId ]
      const orderHash      = o[0];
      const status         = o[1]; // "ACTIVE", "INACTIVE", ...
      const fillAmountBN   = new BigNumber(o[2]); // final or partial fill (micro-units)
      const makerAddr      = o[3].toLowerCase();
      const rawTotalBN     = new BigNumber(o[4]); // totalBetSize in micro-units
  
      const fillAmount     = fillAmountBN.div(1e6).toNumber();
      const totalBetSize   = rawTotalBN.div(1e6).toNumber();
  
      const percentageOdds = o[5];
      const isMakerBettingOutcomeOne = o[9];
      const isMyOrder = (makerAddr === MAKER_ADDRESS);
  
      // Ignore small external orders
      if (!isMyOrder && totalBetSize < minOrderSize) {
        logToFile(`🚫 Ignoring small external order: ${orderHash} (${totalBetSize.toFixed(4)} units)`);
        continue;
      }
  
      // *** If your order is INACTIVE with a non-zero fill, treat that as a final fill. ***
      if (isMyOrder && status === "INACTIVE") {
        if (fillAmount > 0) {
          // e.g. partial or full fill. You can also do a "nearFull" check if you want:
          logToFile(`🔔 handleOrderBookUpdate => My order ${orderHash} is INACTIVE with fill=${fillAmount}/${totalBetSize}. Finalizing fill.`);
          updateUserOrderFill(marketHash, orderHash, fillAmount);
        } else {
          // fillAmount=0 => likely canceled with no fill
          logToFile(`🔔 handleOrderBookUpdate => My order ${orderHash} is INACTIVE but fill=0 => canceled, not finalizing fill.`);
        }
      }
  
      // Store the order in our local array for top-of-book or vig calculations
      newOrders.push({
        orderHash: orderHash,
        status: status,
        maker: makerAddr,
        isMyOrder,
        totalBetSize: totalBetSize.toFixed(4),
        percentageOdds: percentageOdds,
        isMakerBettingOutcomeOne
        // ... add other fields if needed
      });
  
      // Count external ACTIVE orders for your top-of-book logic
      if (!isMyOrder && status === "ACTIVE") {
        validExternalCount++;
      }
    }
  
    // Merge these new orders with any existing ones we keep
    orderBooks.set(marketHash, [...orderBook, ...newOrders]);
    logToFile(`📡 Order book updated for ${marketHash}. Valid external orders: ${validExternalCount}`);
}
  
  

// ===================== ORDERBOOK PROCESSING & CALCULATIONS =====================
function getMarketDataFromOrderBook(marketHash, isUserBettingOutcomeOne, minOrderSize = 100) {
  const allOrders = orderBooks.get(marketHash) || [];
  let bestMakerProbOpposite = 0;
  let validExternal = 0;

  for (const ord of allOrders) {
    if (ord.isMyOrder) continue;

    const sizeBN = new BigNumber(ord.totalBetSize);
    if (sizeBN.lt(minOrderSize)) continue;

    if (ord.isMakerBettingOutcomeOne !== isUserBettingOutcomeOne) {
      const probability = parseFloat(ord.percentageOdds) / 1e20;
      if (probability > bestMakerProbOpposite) {
        bestMakerProbOpposite = probability;
      }
      validExternal++;
    }
  }

  const bestTakerOdds = 1 - bestMakerProbOpposite;
  const vig = getVigFromOrderBook(marketHash, minOrderSize);

  logToFile(`📊 Found ${validExternal} valid external orders for market ${marketHash}`);
  return { bestTakerOdds, vig };
}

function getVigFromOrderBook(marketHash, minOrderSize = 100) {
  const allOrders = orderBooks.get(marketHash) || [];
  let bestMakerProbO1 = 0, bestMakerProbO2 = 0;
  let validCount = 0;

  for (const ord of allOrders) {
    if (ord.isMyOrder) continue;

    const sizeBN = new BigNumber(ord.totalBetSize);
    if (sizeBN.lt(minOrderSize)) continue;

    const probability = parseFloat(ord.percentageOdds) / 1e20;
    if (ord.isMakerBettingOutcomeOne) {
      bestMakerProbO1 = Math.max(bestMakerProbO1, probability);
    } else {
      bestMakerProbO2 = Math.max(bestMakerProbO2, probability);
    }
    validCount++;
  }

  if (validCount === 0) {
    logToFile(`⚠️ No valid external orders found for vig in ${marketHash}. Returning default vig=0.`);
    return 0.0;
  }

  const bestTakerOddsO1 = 1 - bestMakerProbO2;
  const bestTakerOddsO2 = 1 - bestMakerProbO1;
  const vig = (bestTakerOddsO1 + bestTakerOddsO2) - 1;

  logToFile(`📈 Vig Calculation: O1=${bestTakerOddsO1.toFixed(6)}, O2=${bestTakerOddsO2.toFixed(6)}, Vig=${vig.toFixed(6)}`);
  return vig;
}

function roundDownOddsToNearestStep(oddsBigNum) {
  const step = new BigNumber(ODDS_LADDER_STEP_SIZE).times(IMPLIED_ODDS_MULTIPLIER);
  return oddsBigNum.div(step).integerValue(BigNumber.ROUND_FLOOR).times(step);
}

// ===================== MONITORING CONFIG & ORDER POSTING =====================
const monitoringConfig = new Map();

async function postOrderForPosition(marketHash, outcome, amount, edge, minOrderSize = 100) {
  if (!monitoringConfig.has(marketHash)) {
    logToFile(`🚨 Failsafe triggered: Market ${marketHash} is no longer monitored. Skipping order.`);
    return null;
  }

  // COOL-DOWN CHECK
  const lastPosted = lastPostTimes.get(marketHash) || 0;
  if (Date.now() - lastPosted < COOL_DOWN_MS) {
    logToFile(`⌛ Market ${marketHash} is in cool-down. Skipping post.`);
    return null;
  }

  try {
    const { bestTakerOdds } = getMarketDataFromOrderBook(marketHash, outcome === 1, minOrderSize);
    if (!bestTakerOdds || bestTakerOdds <= 0 || bestTakerOdds >= 1) {
      logToFile(`⚠️ No valid taker odds for market ${marketHash}, outcome ${outcome}. Skipping post.`);
      return null;
    }

    const adjustedTakerOdds = bestTakerOdds * (1 - edge / 100);
    const newMakerProb = adjustedTakerOdds;

    if (newMakerProb <= 0 || newMakerProb >= 1) {
      logToFile(`🚨 Invalid makerProb=${newMakerProb} for market ${marketHash}. Skipping.`);
      return null;
    }

    logToFile(`📝 Preparing to post order for ${marketHash}, outcome=${outcome}, adjustedTakerOdds=${adjustedTakerOdds.toFixed(6)}`);

    let scaledMakerOddsBN = new BigNumber(newMakerProb).times(IMPLIED_ODDS_MULTIPLIER);
    scaledMakerOddsBN = roundDownOddsToNearestStep(scaledMakerOddsBN);
    const finalPercentageOdds = scaledMakerOddsBN.toFixed(0);

    const scaledAmount = new BigNumber(amount).times(1e6).toFixed(0);

    if (!monitoringConfig.has(marketHash)) {
      logToFile(`🚨 Market ${marketHash} was stopped AFTER calculating order. Aborting.`);
      return null;
    }

    if (isNaN(Number(scaledAmount))) {
      logToFile(`Invalid scaledAmount (${scaledAmount}) for market ${marketHash}. Skipping.`);
      return null;
    }

    const isMakerBettingOutcomeOne = (outcome === 1);
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
      salt: `0x${saltBytes.toString("hex")}`
    };

    logToFile(`Order details => ${JSON.stringify(order)}`);

    const orderHashBytes = getBytes(
      solidityPackedKeccak256(
        ["bytes32", "address", "uint256", "uint256", "uint256", "uint256", "address", "address", "bool"],
        [order.marketHash, order.baseToken, order.totalBetSize, order.percentageOdds, order.expiry, order.salt, order.maker, order.executor, order.isMakerBettingOutcomeOne]
      )
    );

    const wallet = new Wallet(PRIVATE_KEY);
    order.signature = await wallet.signMessage(orderHashBytes);

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

    logToFile(`✅ Successfully posted order for ${marketHash}, outcome ${outcome}.`);

    // Update last post time to avoid immediate re-post spam
    lastPostTimes.set(marketHash, Date.now());

    return `0x${Buffer.from(orderHashBytes).toString("hex")}`;
  } catch (err) {
    logToFile(`Error in postOrderForPosition: ${err.message}`);
    return null;
  }
}

// ===================== MONITORING LOOP =====================
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
    await new Promise((resolve) => setTimeout(resolve, 3500));
  }
}

/**
 * getLocalFillForMarket:
 * Sum the fill for all user orders in the given market from userOrdersByMarket.
 */
function getLocalFillForMarket(marketHash) {
  const ordersMap = userOrdersByMarket.get(marketHash);
  if (!ordersMap) return 0;

  let totalFill = 0;
  for (const fill of ordersMap.values()) {
    totalFill += fill;
  }
  return totalFill;
}

async function processMarket(marketHash, config) {
  logToFile(`Processing ${marketHash}: outcome=${config.outcome}, maxFill=${config.maxFill}, increments=${config.increments}, edge=${config.edge}, maxVig=${config.maxVig}, minOrderSize=${config.minOrderSize}`);

  const { outcome, maxFill, increments, edge, maxVig, minOrderSize } = config;

  // 1) Check total fill
  const totalFilledBase = getLocalFillForMarket(marketHash);
  logToFile(`📦 ${marketHash} progress: ${totalFilledBase}/${maxFill} => ${(totalFilledBase / maxFill * 100).toFixed(1)}%`);

  // 1a) partial fill tolerance
  const effectiveFill = totalFilledBase / maxFill;
  if (effectiveFill >= FILL_TOLERANCE) {
    logToFile(`✅ Fill tolerance triggered => effectively filled => stopping monitor.`);
    if (process.send) {
      process.send({ action: "markFilled", marketHash, currentFill: totalFilledBase });
    }
    monitoringConfig.delete(marketHash);
    return;
  }

  // 1b) If near or at max fill
  const remainingNeeded = maxFill - totalFilledBase;
  if (remainingNeeded < 10) {
    logToFile(`✅ Remaining fill < 10 => done`);
    if (process.send) {
      process.send({ action: "markFilled", marketHash, currentFill: maxFill });
    }
    monitoringConfig.delete(marketHash);
    return;
  } else {
    if (process.send) {
      process.send({ action: "updateFill", marketHash, currentFill: totalFilledBase });
    }
  }

  // 2) Vig check
  const { bestTakerOdds, vig } = getMarketDataFromOrderBook(marketHash, outcome === 1, minOrderSize);
  if (vig > maxVig) {
    logToFile(`⚠️ Vig ${vig.toFixed(6)} > maxVig ${maxVig}, canceling orders...`);
    const activeOrders = await fetchActiveOrders(marketHash, MAKER_ADDRESS);
    await cancelOrdersForMonitoring(activeOrders.map(o => o.orderHash));
    return;
  }

  // 3) Fetch your active orders
  const activeOrders = await fetchActiveOrders(marketHash, MAKER_ADDRESS, 3);
  if (activeOrders === null) {
    logToFile(`⚠️ fetchActiveOrders failed => skip cycle.`);
    return;
  }

  // 3a) If no active orders => post if enough left
  if (activeOrders.length === 0) {
    if (remainingNeeded < 10) {
      logToFile(`🚨 Not posting new order. Remaining size < 10 => done.`);
      monitoringConfig.delete(marketHash);
      return;
    }
    const sizeToPost = Math.min(remainingNeeded, increments);
    logToFile(`🆕 No active orders => posting new => ${sizeToPost}`);
    await postOrderForPosition(marketHash, outcome, sizeToPost, edge, minOrderSize);
    return;
  }

  // 4) If there are active orders, check if they match the desired edge
  if (!bestTakerOdds || bestTakerOdds <= 0 || bestTakerOdds >= 1) {
    logToFile(`⚠️ bestTakerOdds invalid => skip repost.`);
    return;
  }
  const desiredTakerOdds = bestTakerOdds * (1 - edge / 100);
  if (isNaN(desiredTakerOdds)) {
    logToFile(`🚨 desiredTakerOdds is NaN => skip.`);
    return;
  }

  const desiredMakerOddsScaled = new BigNumber(desiredTakerOdds).times(IMPLIED_ODDS_MULTIPLIER);
  const desiredLadderedOddsBN = roundDownOddsToNearestStep(desiredMakerOddsScaled);
  const desiredLadderedOddsStr = desiredLadderedOddsBN.toFixed(0);

  logToFile(`Desired TakerOdds => ${desiredTakerOdds.toFixed(6)}, scaled => ${desiredLadderedOddsStr}`);

  let needsRepost = false;
  for (const order of activeOrders) {
    if (order.percentageOdds !== desiredLadderedOddsStr) {
      needsRepost = true;
      logToFile(`⚠️ Mismatch => order ${order.orderHash} has ${order.percentageOdds}, expected ${desiredLadderedOddsStr}`);
      break;
    }
  }

  if (needsRepost) {
    const hashesToCancel = activeOrders.map(o => o.orderHash);
    await cancelOrdersForMonitoring(hashesToCancel);

    const sizeToPost = Math.min(remainingNeeded, increments);
    if (sizeToPost < 10) {
      logToFile(`🚨 Not reposting => sizeToPost < 10 => done`);
      monitoringConfig.delete(marketHash);
      return;
    }

    await postOrderForPosition(marketHash, outcome, sizeToPost, edge, minOrderSize);
  } else {
    logToFile(`✅ Active orders are still competitive => no need to repost.`);
  }
}

// ===================== PROCESS MESSAGE HANDLERS =====================
process.on("message", async (message) => {
  if (!message || !message.action) return;
  const { action, marketHash, config } = message;
  logToFile(`Received message: ${JSON.stringify(message)}`);

  if (action === "start") {
    if (!config.startTime || isNaN(config.startTime)) {
      config.startTime = Date.now();
      logToFile(`startTime not provided => using current time: ${config.startTime}`);
    } else if (config.startTime < 1e12) {
      config.startTime = config.startTime * 1000;
      logToFile(`Detected startTime in seconds => converting to ms => ${config.startTime}`);
    }
    monitoringConfig.set(marketHash, config);
    logToFile(`✅ Started monitoring ${marketHash}`);
    subscribeToOrderBook(marketHash);
    logToFile(`📡 Subscribed to real-time order book for ${marketHash}`);
  } else if (action === "stop") {
    if (monitoringConfig.has(marketHash)) {
      logToFile(`Stopping monitoring => ${marketHash}`);
      const activeOrders = await fetchActiveOrders(marketHash, MAKER_ADDRESS);
      if (activeOrders.length > 0) {
        await cancelOrdersForMonitoring(activeOrders.map(o => o.orderHash));
        logToFile(`Canceled orders => ${activeOrders.map(o => o.orderHash)}`);
      }
      monitoringConfig.delete(marketHash);
      logToFile(`Stopped monitoring => ${marketHash}`);
    } else {
      logToFile(`Stop requested => non-existent ${marketHash}`);
    }
  } else if (action === "stopAll") {
    await stopAllMarkets();
  } else if (action === "update") {
    if (monitoringConfig.has(marketHash)) {
      const oldCfg = monitoringConfig.get(marketHash);
      const merged = { ...oldCfg, ...config };
      monitoringConfig.set(marketHash, merged);
      logToFile(`Updated config => ${marketHash}`);
    } else {
      logToFile(`Attempted update => non-existent market => ${marketHash}`);
    }
  } else if (action === "forceRefreshAll") {
    logToFile("Received 'forceRefreshAll' => checking all monitored markets...");
    for (const [hash, cfg] of monitoringConfig.entries()) {
      try {
        await processMarket(hash, cfg);
      } catch (err) {
        logToFile(`Error in forceRefreshAll => ${hash}: ${err.message}`);
      }
    }
  }
});

// ===================== GRACEFUL SHUTDOWN & CLEANUP =====================
async function gracefulShutdown(signal) {
  logToFile(`Received ${signal} => Initiating graceful shutdown.`);
  await stopAllMarkets();
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

async function stopAllMarkets() {
  logToFile("Canceling all active orders before shutdown...");
  const allOrderHashes = [];

  for (const [mHash] of monitoringConfig.entries()) {
    logToFile(`Fetching active orders => ${mHash}`);
    const activeOrders = await fetchActiveOrders(mHash, MAKER_ADDRESS);
    if (activeOrders.length > 0) {
      allOrderHashes.push(...activeOrders.map(o => o.orderHash));
    }
  }

  if (allOrderHashes.length > 0) {
    logToFile(`Canceling ${allOrderHashes.length} total orders now...`);
    await cancelOrdersForMonitoring(allOrderHashes);
  } else {
    logToFile("No active orders found to cancel.");
  }

  monitoringConfig.clear();
  logToFile("Monitoring config cleared => Exiting process.");
  process.exit(0);
}

// ===================== START THE LOOP =====================
monitoringLoop().catch((err) => {
  logToFile(`Fatal error in monitoring loop: ${err.message}`);
  process.exit(1);
});
