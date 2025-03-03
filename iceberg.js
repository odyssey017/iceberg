/**
 * main.js
 * 
 * This file handles:
 *  - The interactive CLI menu (using readlineSync).
 *  - Position creation and storage.
 *  - Launching/stopping the monitoring child process.
 * 
 * Usage:
 *  1. Run "node iceberg.js"
 */

// ===================== IMPORTS & SETUP =====================
import * as readlineSync from "readline-sync";
import { fork } from "child_process";
import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import { API_BASE_URL } from "./config.js";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CLI_THEME = {
  icons: {
    header: '┏━━━▶ ',
    divider: '├' + '─'.repeat(50),
    section: '│ ',
    footer: '┗━━━▶ ',
    sports: '🏅 ',
    money: '💵 ',
    alert: '🚨 ',
    success: '✅ ',
    progress: (pct) => {
      const totalBlocks = 20; // Length of the progress bar
      const filled = Math.round((pct / 100) * totalBlocks); // Scale correctly to 20 blocks
      const empty = totalBlocks - filled; // Remaining empty blocks
      return `[${'■'.repeat(filled)}${' '.repeat(empty)}] ${pct.toFixed(1)}%`;
  }  
  },
  colors: {
    warning: '\x1b[33m',
    error: '\x1b[31m',
    success: '\x1b[32m',
    reset: '\x1b[0m'
  }
};

function showHeader(title) {
  console.log(`\n${CLI_THEME.icons.header}${title}`);
  console.log(CLI_THEME.icons.divider);
}

function showFooter(message) {
  console.log(`${CLI_THEME.icons.footer}${message}\n`);
}

// ===================== CHILD PROCESS MANAGEMENT =====================
let monitoringProcess = null;

/**
 * Ensure the monitoring process is running. If not, starts it.
 * We communicate with the child process via IPC (process.send).
 */
function ensureMonitoringProcess() {
  if (!monitoringProcess) {
    monitoringProcess = fork(path.join(__dirname, "monitor.js"));

    monitoringProcess.on("message", (msg) => {

      if (!msg || !msg.action) return;

      if (msg.action === "updateFill") {
        if (positions.has(msg.marketHash)) {
          const position = positions.get(msg.marketHash);
          position.currentFill = msg.currentFill;
        }
      }

      if (msg.action === "markFilled") {
        if (positions.has(msg.marketHash)) {
          const completedPos = positions.get(msg.marketHash);
          completedPos.currentFill = completedPos.maxFill;

          completedPositions.set(msg.marketHash, completedPos);
          positions.delete(msg.marketHash);
        }
      }
    });

    monitoringProcess.on("error", (err) => {
      console.error("Monitoring process error:", err);
    });

    monitoringProcess.on("exit", (code, signal) => {
      console.log("Monitoring process exited:", code, signal);
      monitoringProcess = null;
    });
  }
}
  

process.on("exit", () => {
  if (monitoringProcess) {
    monitoringProcess.kill();
  }
});

// ===================== FETCH HELPERS =====================
/**
 * Fetch all leagues from the SX API
 */
async function fetchLeagues() {
  try {
    const response = await fetch(`${API_BASE_URL}/leagues`);
    if (!response.ok) {
      throw new Error(`Failed to fetch leagues: ${response.statusText}`);
    }
    const data = await response.json();
    return data.data || [];
  } catch (error) {
    return [];
  }
}

/**
 * Fetches detailed market information, including team and outcome names.
 *
 * @param {string} marketHash - The market hash.
 * @returns {object|null} - An object containing team and outcome names or null if failed.
 */
async function fetchMarketDetails(marketHash) {
  try {
    const response = await fetch(`${API_BASE_URL}/markets/${marketHash}`);
    if (!response.ok) {
      throw new Error(`Failed to fetch market details: ${response.statusText}`);
    }

    const data = await response.json();
    const { teamOneName, teamTwoName, outcomeOneName, outcomeTwoName } = data;

    if (!teamOneName || !teamTwoName || !outcomeOneName || !outcomeTwoName) {
      throw new Error("Incomplete market details received.");
    }

    return { teamOneName, teamTwoName, outcomeOneName, outcomeTwoName };
  } catch (error) {
    return null;
  }
}

/**
 * Fetch active markets for a given league ID, including outcome names.
 *
 * @param {number} leagueId - The league ID.
 * @returns {object[]} - Array of active markets with detailed information.
 */
async function fetchActiveMarkets(leagueId) {
  try {
    const response = await fetch(
      `${API_BASE_URL}/markets/active?leagueId=${leagueId}&onlyMainLine=true`
    );
    if (!response.ok) {
      throw new Error(`Failed to fetch active markets: ${response.statusText}`);
    }
    const data = await response.json();
    const markets = data.data.markets || [];

    // Fetch and attach outcome names for each market
    const detailedMarkets = await Promise.all(
      markets.map(async (market) => {
        const details = await fetchMarketDetails(market.marketHash);
        if (details) {
          return { ...market, ...details };
        } else {
          // If fetching details failed, return the market as is
          return market;
        }
      })
    );

    return detailedMarkets;
  } catch (error) {
    return [];
  }
}

/**
 * Fetch top-of-book (best) odds for both outcomes of a given market.
 * We’ll use this to estimate the implied vig and see if it exceeds the user’s threshold.
 */
async function fetchMarketOdds(marketHash) {
  try {
    const response = await fetch(`${API_BASE_URL}/orders?marketHashes=${marketHash}`);
    if (!response.ok) {
      throw new Error(`Failed to fetch orders: ${response.statusText}`);
    }
    const data = await response.json();
    const orders = data.data || [];

    // For a 2-outcome market, we want to identify the best available taker odds for outcome1 and outcome2.
    // "makerOdds" or "percentageOdds" in SX means the implied probability for the maker’s side of the bet.
    // If isMakerBettingOutcomeOne = true => percentageOdds is for outcome1 from maker perspective.
    // Taker perspective on that same bet has implied probability = 1 - (percentageOdds).
    // We want the top (lowest implied probability from maker perspective => highest from taker perspective) for each outcome.

    let bestTakerOddsForOutcome1 = 0;
    let bestTakerOddsForOutcome2 = 0;

    // We’ll look for the best maker-odds for each side
    let bestMakerOddsForO1 = 0; // For isMakerBettingOutcomeOne = true
    let bestMakerOddsForO2 = 0; // For isMakerBettingOutcomeOne = false

    orders.forEach((order) => {
      const makerProb = parseFloat(order.percentageOdds) / 1e20; // 10^20 scaling
      if (order.isMakerBettingOutcomeOne) {
        // outcome1
        if (makerProb > bestMakerOddsForO1) {
          bestMakerOddsForO1 = makerProb;
        }
      } else {
        // outcome2
        if (makerProb > bestMakerOddsForO2) {
          bestMakerOddsForO2 = makerProb;
        }
      }
    });

    // Taker perspective:
    // - If makerOddsForO1 = p, then takerOddsForO2 = 1 - p
    // - If makerOddsForO2 = q, then takerOddsForO1 = 1 - q
    // But we only consider “best” from the taker’s perspective, which means the highest possible takerOdds for each side.
    // bestTakerOddsForOutcome1 => 1 - bestMakerOddsForO2
    // bestTakerOddsForOutcome2 => 1 - bestMakerOddsForO1
    bestTakerOddsForOutcome1 = 1 - bestMakerOddsForO2;
    bestTakerOddsForOutcome2 = 1 - bestMakerOddsForO1;

    return { bestTakerOddsForOutcome1, bestTakerOddsForOutcome2 };
  } catch (error) {
    return { bestTakerOddsForOutcome1: 0, bestTakerOddsForOutcome2: 0 };
  }
}

/**
 * Compute vig for a 2-outcome market, given two implied decimals for outcome1 and outcome2.
 * 
 * If outcome1's implied probability is p1, and outcome2's implied probability is p2,
 * the "overround" or "vig" is roughly p1 + p2 - 1. 
 * If p1 + p2 = 1, there's no vig. 
 * If p1 + p2 > 1, there's a vig of (p1+p2 - 1).
 * 
 * This is a simplistic vig check, and you can refine or match exactly how SX calculates it.
 */
function calculateVig(p1, p2) {
  // p1 + p2 might be slightly above 1
  return (p1 + p2) - 1;
}

// ===================== POSITION STORAGE =====================
// Active positions
const positions = new Map();

// Completed positions
const completedPositions = new Map();

/**
 * After building a position config, we notify the monitoring process
 * to start monitoring that market. 
 */
function startMonitoringPosition(position) {
  ensureMonitoringProcess();
  monitoringProcess.send({
    action: "start",
    marketHash: position.marketHash,
    config: position,
  });
}

/**
 * If user wants to stop monitoring a particular market
 */
function stopMonitoringPosition(marketHash) {
  if (monitoringProcess) {
    monitoringProcess.send({ action: "stop", marketHash });
  }
  positions.delete(marketHash);
}

async function viewLogs() {
    const LOG_FILE_PATH = path.resolve(__dirname, "monitoring.log");

    if (!fs.existsSync(LOG_FILE_PATH)) {
        console.log(`${CLI_THEME.icons.alert} No logs found.`);
        return;
    }

    const linesPerPage = 20; 
    const logs = fs.readFileSync(LOG_FILE_PATH, "utf-8").split("\n").reverse(); 
    let pageIndex = 0;

    while (true) {
        showHeader('📜 BOT LOGS');
        const start = pageIndex * linesPerPage;
        const end = start + linesPerPage;
        const pageLogs = logs.slice(start, end);

        if (pageLogs.length === 0) {
            console.log(`${CLI_THEME.icons.alert} No more log entries.`);
            console.log(`${CLI_THEME.icons.footer} Press 0 to return.`);
        } else {
            pageLogs.forEach(line => console.log(`${CLI_THEME.icons.section} ${line}`));
            console.log(CLI_THEME.icons.divider);
            console.log(`${CLI_THEME.icons.footer} Press Enter to load more logs. Press 0 to return.`);
        }

        const input = readlineSync.question("");
        if (input === "0") {
            console.log("Returning to main menu...");
            return;
        }

        pageIndex++;
    }
}

/**
 * If user wants to stop monitoring all markets
 */
function stopAllPositions() {
  if (monitoringProcess) {
    monitoringProcess.send({ action: "stopAll" });
  }
  positions.clear();
}

// ===================== MAIN MENU LOGIC =====================

async function mainMenu() {
    while (true) {
        showHeader('ICEBERG BOT CONTROL PANEL');
        console.log(`${CLI_THEME.icons.section} 1. 🌊 Create New Iceberg Position`);
        console.log(`${CLI_THEME.icons.section} 2. 🔍 Manage Active Positions`);
        console.log(`${CLI_THEME.icons.section} 3. 📜 View Bot Logs`);
        console.log(`${CLI_THEME.icons.section} 4. ⚠️ Exit System`);
        console.log(CLI_THEME.icons.divider);
        console.log(`${CLI_THEME.icons.footer} Press 0 to exit at any time.`);

        const choice = readlineSync.questionInt(`${CLI_THEME.colors.success}⌨  Your choice: ${CLI_THEME.colors.reset}`);

        switch (choice) {
            case 1:
                await buildPosition();
                break;
            case 2:
                await managePositions();
                break;
            case 3:
                await viewLogs();
                break;
            case 4:
                console.log("Exiting the bot. Goodbye!");
                  
                stopAllPositions();
                  
                if (monitoringProcess) {
                      monitoringProcess.on("exit", () => {
                        process.exit(0);
                      });
                    } else {
                      process.exit(0);
                    }
                  
                    return;
                  
            case 0:
                console.log("Returning to main menu...");
                continue;
            default:
                console.log(`${CLI_THEME.icons.alert} Invalid choice. Please try again.`);
        }
    }
}

/**
 * Prompt user for the details needed to build a position, then start monitoring.
 */
async function buildPosition() {
    showHeader('CREATE A NEW ICEBERG POSITION');
    console.log(`${CLI_THEME.icons.footer} Press 0 to return to the main menu at any time.`);
    // List of supported sports
    const sports = [
        { id: 1, name: "🏀 Basketball" },
        { id: 2, name: "🏒 Hockey" },
        { id: 3, name: "⚾ Baseball" },
        { id: 4, name: "⛳ Golf" },
        { id: 5, name: "⚽ Soccer" },
        { id: 6, name: "🎾 Tennis" },
        { id: 7, name: "🥋 MMA" },
        { id: 8, name: "🏈 Football" }
    ];

    sports.forEach(sport => console.log(`${CLI_THEME.icons.section} ${CLI_THEME.icons.sports}${sport.id}. ${sport.name}`));

    const sportId = readlineSync.questionInt(`${CLI_THEME.icons.footer} Select a sport by ID: `);
    const selectedSport = sports.find(s => s.id === sportId);
    if (!selectedSport) {
        console.log(`${CLI_THEME.icons.alert} Invalid selection. Returning to main menu.`);
        return;
    }

    showHeader(`Leagues in ${selectedSport.name}`);

    const allLeagues = await fetchLeagues();
    const leagues = allLeagues.filter(league => league.sportId === sportId && league.active);
    if (leagues.length === 0) {
        console.log(`${CLI_THEME.icons.alert} No active leagues available for this sport.`);
        return;
    }

    leagues.forEach((league, index) => console.log(`${CLI_THEME.icons.section} ${index + 1}. ${league.label}`));

    const leagueIndex = readlineSync.questionInt(`${CLI_THEME.icons.footer} Select a league by number: `) - 1;
    if (leagueIndex < 0 || leagueIndex >= leagues.length) {
        console.log(`${CLI_THEME.icons.alert} Invalid selection. Returning to main menu.`);
        return;
    }

    const selectedLeague = leagues[leagueIndex];

    showHeader(`Active Games in ${selectedLeague.label}`);

    const markets = await fetchActiveMarkets(selectedLeague.leagueId);
    if (markets.length === 0) {
        console.log(`${CLI_THEME.icons.alert} No active markets available for this league.`);
        return;
    }

    // ** Group markets by team matchup (removing duplicates) **
    const groupedMarkets = {};
    markets.forEach(market => {
        const matchupKey = `${market.teamOneName} vs ${market.teamTwoName}`;
        if (!groupedMarkets[matchupKey]) {
            groupedMarkets[matchupKey] = [];
        }
        groupedMarkets[matchupKey].push(market);
    });

    const matchups = Object.keys(groupedMarkets);

    // Display all matchups
    matchups.forEach((matchup, index) => {
        console.log(`${CLI_THEME.icons.section} ${index + 1}. ${matchup}`);
    });

    const gameIndex = readlineSync.questionInt(`${CLI_THEME.icons.footer} Select a game: `) - 1;
    if (gameIndex < 0 || gameIndex >= matchups.length) {
        console.log(`${CLI_THEME.icons.alert} Invalid selection. Returning to main menu.`);
        return;
    }

    const selectedMatchup = matchups[gameIndex];
    const availableMarkets = groupedMarkets[selectedMatchup];

    showHeader(`Available Outcomes for ${selectedMatchup}`);

    // Display all outcomes for this game
    availableMarkets.forEach((market, index) => {
        console.log(`${CLI_THEME.icons.section} ${index + 1}. ${market.outcomeOneName} | ${market.outcomeTwoName}`);
    });

    const marketIndex = readlineSync.questionInt(`${CLI_THEME.icons.footer} Select an outcome pair: `) - 1;
    if (marketIndex < 0 || marketIndex >= availableMarkets.length) {
        console.log(`${CLI_THEME.icons.alert} Invalid selection. Returning to main menu.`);
        return;
    }

    const selectedMarket = availableMarkets[marketIndex];

    showHeader(`Choose an Outcome`);
    console.log(`${CLI_THEME.icons.section} 1. ${selectedMarket.outcomeOneName}`);
    console.log(`${CLI_THEME.icons.section} 2. ${selectedMarket.outcomeTwoName}`);

    const outcome = readlineSync.questionInt(`${CLI_THEME.icons.footer} Select an outcome: `);
    if (outcome !== 1 && outcome !== 2) {
        console.log(`${CLI_THEME.icons.alert} Invalid selection. Returning to main menu.`);
        return;
    }

    showHeader(`Set Position Parameters`);
    const maxFill = readlineSync.questionFloat(`${CLI_THEME.icons.money} Max fill (e.g., 10000): `);
    const increments = readlineSync.questionFloat(`${CLI_THEME.icons.money} Order increment size (e.g., 1000): `);
    const edge = readlineSync.questionFloat(`${CLI_THEME.icons.money} % Edge above market (e.g., 1 for 1% better): `);
    const maxVig = readlineSync.questionFloat(`${CLI_THEME.icons.money} Max vig allowed (e.g., 0.04 = 4%): `);
    const minOrderSize = readlineSync.questionInt(
        `${CLI_THEME.icons.money} 🛡️  Minimum order size to consider (e.g., 1000, 99 to ignore small orders): `,
        {
            defaultInput: "99",
            min: 0,
            max: 9999
        }
    );

    showHeader(`Checking Market Conditions`);

    const { bestTakerOddsForOutcome1, bestTakerOddsForOutcome2 } = await fetchMarketOdds(selectedMarket.marketHash);
    const p1 = bestTakerOddsForOutcome1;
    const p2 = bestTakerOddsForOutcome2;
    const vig = calculateVig(p1, p2);

    if (vig > maxVig) {
        console.log(`${CLI_THEME.icons.alert} Current vig is ${(vig * 100).toFixed(2)}%.`);
        console.log(`${CLI_THEME.icons.alert} That exceeds your max limit of ${(maxVig * 100).toFixed(2)}%.`);
        console.log(`${CLI_THEME.icons.alert} No orders will be placed. Returning to main menu.`);
        return;
    }

    const marketDetails = {
        teamOneName: selectedMarket.teamOneName,
        teamTwoName: selectedMarket.teamTwoName,
        outcomeOneName: selectedMarket.outcomeOneName,
        outcomeTwoName: selectedMarket.outcomeTwoName
    };

    const normalizedHash = selectedMarket.marketHash.toLowerCase();

    const position = {
        marketHash: normalizedHash,
        outcome,
        maxFill,
        increments,
        edge,
        maxVig,
        minOrderSize,
        currentFill: 0,
        marketDetails
    };

    positions.set(normalizedHash, position);
    startMonitoringPosition(position);

    console.log(`\n${CLI_THEME.icons.success} ✅ Position created successfully!`);
    console.log(`${CLI_THEME.icons.success} Ignoring orders ≤ ${minOrderSize} units`);
    showFooter(`Monitoring ${selectedMarket.teamOneName} vs ${selectedMarket.teamTwoName}`);
}

/**
 * Manage positions: either edit or close them. 
 */
async function managePositions() {
    if (monitoringProcess) {
        console.log("Refreshing fill data for all monitored positions...");

        monitoringProcess.send({ action: "forceRefreshAll" });
        await new Promise((resolve) => setTimeout(resolve, 1000));
    } else {
        console.log("Monitoring process not running; cannot refresh data.");
    }

    console.log(`${CLI_THEME.icons.footer} Press 0 to return to the main menu at any time.`);
    
    if (positions.size === 0 && completedPositions.size === 0) {
        console.log(`${CLI_THEME.icons.section} 🧊 No active or completed iceberg positions found`);
        showFooter('Returning to main menu');
        return;
    }

    // 🔵 Active Positions
    const activePositionsList = Array.from(positions.values()).map(pos => {
        // Ensure currentFill is always a number
        const currentFill = pos.currentFill || 0;  
        const progress = (currentFill / pos.maxFill) * 100;

        return { pos, progress, hash: pos.marketHash };
    });

    // ✅ Completed Positions
    const completedPositionsList = Array.from(completedPositions.values());

    // Display Active Positions
    if (activePositionsList.length > 0) {
        showHeader("🔍 Active Iceberg Positions");
        activePositionsList.forEach(({ pos, progress }, idx) => {
            console.log(`
    ${CLI_THEME.icons.section} ${idx + 1}. ${pos.marketDetails.teamOneName} vs ${pos.marketDetails.teamTwoName}
    ${CLI_THEME.icons.section}    Betting: ${pos.outcome === 1 ? pos.marketDetails.outcomeOneName : pos.marketDetails.outcomeTwoName}
    ${CLI_THEME.icons.section}    ${CLI_THEME.icons.progress(progress)}
    ${CLI_THEME.icons.section}    💰 Filled: ${pos.currentFill || 0}/${pos.maxFill} 
    ${CLI_THEME.icons.section}    🎯 Edge: ${pos.edge}% | 🛡️ Vig Limit: ${(pos.maxVig * 100).toFixed(1)}%
    ${CLI_THEME.icons.section}    ⚖️  Min Order: ${pos.minOrderSize} | 🔄 Increments: ${pos.increments}`);
        });
    } else {
        console.log(`${CLI_THEME.icons.section} 🔹 No active positions.`);
    }

    // Display Completed Positions
    if (completedPositionsList.length > 0) {
        showHeader("✅ Completed Iceberg Positions");
        completedPositionsList.forEach((pos, idx) => {
            const progress = 100;
            console.log(`
    ${CLI_THEME.icons.success} ✅ ${idx + 1}. ${pos.marketDetails.teamOneName} vs ${pos.marketDetails.teamTwoName}
    ${CLI_THEME.icons.section}    Betting: ${pos.outcome === 1 ? pos.marketDetails.outcomeOneName : pos.marketDetails.outcomeTwoName}
    ${CLI_THEME.icons.section}    ${CLI_THEME.icons.progress(progress)}
    ${CLI_THEME.icons.section}    💰 Filled: ${pos.currentFill || pos.maxFill}/${pos.maxFill} (100% Completed)`);
        });
    } else {
        console.log(`${CLI_THEME.icons.section} 🔹 No fully filled positions.`);
    }

    showFooter('Select position to manage');
    
    const choice = readlineSync.questionInt("Enter position number: ");
    if (choice === 0) return;

    // Handle selection for active positions
    if (choice <= activePositionsList.length) {
        const chosen = activePositionsList[choice - 1];
        const chosenHash = chosen.hash;
        const chosenPos = positions.get(chosenHash);

        console.log("\n1. Edit Position");
        console.log("2. Close Position");
        const action = readlineSync.questionInt("Choose an action: ");

        if (action === 1) {
            const newEdge = readlineSync.questionFloat(
                `Enter new edge % (current: ${chosenPos.edge}). Press enter to skip: `,
                { defaultInput: String(chosenPos.edge) }
            );
            const newIncrements = readlineSync.questionFloat(
                `Enter new increments (current: ${chosenPos.increments}). Press enter to skip: `,
                { defaultInput: String(chosenPos.increments) }
            );
            const newMaxFill = readlineSync.questionFloat(
                `Enter new max fill (current: ${chosenPos.maxFill}). Press enter to skip: `,
                { defaultInput: String(chosenPos.maxFill) }
            );
            const newMaxVig = readlineSync.questionFloat(
                `Enter new max vig (current: ${chosenPos.maxVig}). Press enter to skip: `,
                { defaultInput: String(chosenPos.maxVig) }
            );

            chosenPos.edge = newEdge;
            chosenPos.increments = newIncrements;
            chosenPos.maxFill = newMaxFill;
            chosenPos.maxVig = newMaxVig;
            positions.set(chosenHash, chosenPos);

            if (monitoringProcess) {
                monitoringProcess.send({
                    action: "update",
                    marketHash: chosenHash,
                    config: chosenPos,
                });
            }

            console.log(`Position updated for market: ${chosenHash}`);
        } else if (action === 2) {
            stopMonitoringPosition(chosenHash);
            console.log(`Position closed for market: ${chosenHash}`);
        } else {
            console.log("Invalid action.");
        }
    }
}



// Start the CLI
mainMenu();