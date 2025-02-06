# 🧊 Iceberg Order Betting Bot

## 📌 Overview
The **Iceberg Bot** is an automated betting tool for **SX Bet**.  

The bot allows the user to programmatically create and manage orders at a specificed edge above the current top available odds on the orderbook using an "iceberg" strategy, where large bets are split into smaller increments. It continuously monitors the order book, adjusting or canceling orders based on market conditions, vig thresholds, and order fills to ensure efficient execution without an odds feed. The bot runs through an interactive CLI, allowing users to create, manage, and monitor trading positions in real time.

---

## ✨ Features
✅ **Automated Order Updates** – Monitors the orderbook and dynamically updates your orders to always be at optimal odds.  
✅ **Vig Monitoring** – Cancels orders when market vig exceeds your set limit.  
✅ **Iceberg Orders** – Splits large orders into smaller increments. The increment is the max risk on the orderbook at one time.  
✅ **CLI Interface** – User-friendly interactive command-line menu.  
✅ **Manage Positions/Orders** – View, update, or cancel a position and it's associated orders at any time.  
✅ **Logging** – Detailed logs to monitor execution and performance.  

---

# 📊 Order Placement Logic & Key Parameters

When placing orders, the bot follows a **systematic approach** based on the user's settings. Below is a breakdown of how **Edge, Min Order Size, Max Vig, and Increments** affect order placement and adjustment.

## 1️⃣ Edge (`% Edge Above Market`)
🔹 **Definition**: The "Edge" parameter defines how much better your order price (odds) should be compared to the current best available taker odds on your desired outcome.  
🔹 **Purpose**: Ensures your orders are always competitive and never stale.

### **Example Scenario:**
- Current **best taker odds**: `0.60` (implied probability of 60%)  
- You set **Edge** = `2%`  
- The bot **adjusts** your order's odds to:  

  ```
  Desired Taker Odds = Best Taker Odds × (1 - Edge / 100)
                     = 0.60 × (1 - 0.02)
                     = 0.588 (58.8% implied probability)
  ```

✅ **Your orders will be placed at a slightly better value than the current market to attract takers while maintaining profitability.**  

---

## 2️⃣ Min Order Size to Consider (`minOrderSize`)
🔹 **Definition**: The minimum size of orders (in USDC) that the bot will consider when assessing market conditions.  
🔹 **Purpose**: Avoids reacting to insignificant or "dust" orders that could distort decision-making.  

### **Example Scenario:**
- **Market Orders Available:**
  ```
  Order 1: 50 USDC (Odds: 0.62)
  Order 2: 200 USDC (Odds: 0.60)
  Order 3: 3000 USDC (Odds: 0.59)
  ```
- Your **Min Order Size = 100**  

✅ **Order 1 (50 USDC) will be ignored**, but **Orders 2 & 3 (≥100 USDC) will be used for decision-making.**  

---

## 3️⃣ Max Vig (`MaxVig`)
🔹 **Definition**: The maximum vig (overround) allowed for the market before the bot cancels/stops placing orders.  
🔹 **Purpose**: Protects against placing orders if the vig becomes too large.  

### **How Vig Is Calculated:**
- A 2-outcome market’s **vig** is determined by:  
  ```
  Vig = (Best Taker Odds Outcome 1) + (Best Taker Odds Outcome 2) - 1
  ```
- If **Vig > MaxVig**, orders are **not placed** or **canceled**.

### **Example Scenario:**
- **Best Taker Odds:**
  ```
  Outcome 1: 0.60
  Outcome 2: 0.50
  ```
- Vig Calculation:  
  ```
  0.60 + 0.50 - 1 = 0.1 (10% vig)
  ```
- Your **MaxVig = 7% (0.07)**  

🚨 **Since the actual Vig (10%) exceeds the allowed MaxVig (7%), the bot cancels active orders and does NOT place new ones.**  

---

## 4️⃣ Increments (`increments`)
🔹 **Definition**: The size of each individual order posted at a time.  
🔹 **Purpose**: Ensures controlled exposure by spreading orders over time instead of filling all at once.  

### **Example Scenario:**
- **Your Position Settings:**
  ```
  Max Fill: 1000 USDC
  Increments: 250 USDC
  ```
- The bot will **place orders in 250-unit increments** until the total filled volume reaches 1000 USDC.

⏳ **Order Flow:**  
```
1️⃣ Bot places 250 USDC ✅
2️⃣ Another 250 USDC ✅
3️⃣ Another 250 USDC ✅
4️⃣ Final 250 USDC ✅
🔄 Stops placing orders once 1000 USDC are filled.
```

✅ **This prevents executing all trades at once, giving time for better odds to emerge.**  

---

## ⏳ Order Placement Summary Flow  
1️⃣ **Bot checks the market** for valid orders (above `minOrderSize`).  
2️⃣ **Calculates vig** to ensure it is within `MaxVig`.  
3️⃣ **Finds best taker odds** and applies `Edge`.  
4️⃣ **Determines order size** based on `increments`.  
5️⃣ **Places orders** at the calculated best value.  
6️⃣ **Cancels orders** if market conditions change and no longer meet criteria.  

---

## ✅ Final Example of Order Execution  
### **Scenario:**  
- **You set**: `Edge = 2%`, `Min Order Size = 100`, `MaxVig = 2%`, `Increments = 500`.  
- **Market Data**:  
  ```
  Best Taker Odds Outcome 1: 0.60
  Best Taker Odds Outcome 2: 0.43
  ```
- **Bot Calculation:**  
  ```
  Desired Taker Odds = 0.60 × (1 - 0.02) = 0.588
  Vig = (0.60 + 0.43 - 1) = 0.03 (3%)
  ```
- **Action Taken**:  
  - 🚫 **No orders placed (Vig is too high)**  
  - If vig were **≤ 2%**, the bot would **post 500-unit orders at 0.588 odds**.  

---

## 🛠️ Installation & Setup

### **1️⃣ Prerequisites**
Ensure you have the following installed:  
- **[Node.js](https://nodejs.org/)** (Latest LTS version recommended)  
- **Git** (Optional, but recommended for version control)  

### **2️⃣ Clone the Repository**  
To get started, **clone this repository** and navigate to the project folder:  

```sh
git clone https://github.com/YOUR_GITHUB_USERNAME/iceberg.git
cd iceberg
```

### **3️⃣ Install Dependencies**  
Run the following command to install required packages:  

```sh
npm install
```

### **4️⃣ Configure Your API Key, Private Key, & Wallet Address **  
1. **Create a `.env` file** in the root directory.  
2. Add your **SX Bet API credentials** inside `.env`:

```ini
PRIVATE_KEY=your_private_key_here
USER_ADDRESS=your_wallet_address_here
SX_BET_API_KEY=your_sx_bet_api_key_here
```

> **⚠️ Keep your `.env` file private!** Never share or commit it to GitHub.

---

## 🚀 Running the Bot  

### **Start the CLI Interface**
To launch the bot, run:  

```sh
node iceberg.js
```

This will start the **interactive menu**, allowing you to create and manage positions.

### **Monitor Logs**
The bot keeps a detailed log when monitoring a position. To view logs, use:

```sh
cat monitoring.log  # View monitoring logs
```

---

## 📜 Usage Guide

### **1️⃣ Build a Position**
Follow the **CLI prompts** to set:  
- The market you want to bet on
- The maximum stake you want on the bet (maximum fill in USDC)
- Increments for an individual order (size of the individual order posted)
- Your betting edge (
- Min order size to consider
- Max vig allowed

### **2️⃣ Manage Active Positions**
The bot continuously checks:  
- **Your filled volume**  
- **Best available taker odds**  
- **Market vig conditions**
- **Whether your orders need re-posting**  

From the **Manage Positions** menu, you can:  
- **Edit** a position -> change the **max fill, increments to post, edge, max vig, minimum order size to consider**  
- **Cancel** a position -> cancels active orders on the specified market, and stops monitoring

### **3️⃣ Exit (Kill Switch)**
- From the main menu, selecting the option to exit will kill all your existing orders, and stop monitoring for updates.

---

## 📂 File Structure

```
📁 iceberg-bot
├── 📜 README.md          # Documentation & setup guide
├── 📜 .gitignore         # Ignore sensitive files & unnecessary directories
├── 📜 LICENSE            # License file
├── 📜 config.js          # Configuration settings (API URLs, default parameters)
├── 📜 iceberg.js         # Main CLI for managing positions & interacting with the bot
├── 📜 network.js         # Handles API requests (order placement, cancellations, market data)
├── 📜 logger.js          # Centralized logging utility (used in monitor.js)
├── 📜 monitor.js         # Market monitoring, order validation, and execution logic
├── 📜 package.json       # Node.js project metadata & dependencies
├── 📜 package-lock.json  # Ensures consistent dependency installation
└── 📂 node_modules/      # Installed dependencies (not included in Git)
```

---

## 🛠️ Troubleshooting

### **Bot is Not Posting Orders**
- Ensure your API keys are correct in `.env`.  
- Check logs for `Error` messages.  
- Verify **market vig** is within the allowed limit, and that there are active orders which meet your threshold. 

### **How to Stop the Bot**
- Use `CTRL+C` to stop execution.  
- Run `node iceberg.js` again to restart.  

---

## ⚖️ License
This project is **MIT Licensed** – Free to use, modify, and distribute.  

---

## 📬 Support & Contributions
💡 **Found a bug or have an idea?** Open an issue or PR on **GitHub**.  
🔗 **Join the discussion**: [GitHub Issues](https://github.com/YOUR_GITHUB_USERNAME/iceberg-bot/issues)  
