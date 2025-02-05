# 🧊 Iceberg Trading Bot

## 📌 Overview
The **Iceberg Trading Bot** is an automated market-making tool for **SX Bet**.  
It allows users to **place, monitor, and adjust trading positions** dynamically while controlling order flow.  
The bot ensures **liquidity management**, **risk mitigation**, and **vig monitoring** to maintain competitive market positions.

---

## ✨ Features
✅ **Automated Order Placement** – Keeps your orders at optimal market odds.  
✅ **Vig Monitoring** – Cancels orders when market vig exceeds your set limit.  
✅ **Iceberg Order Strategy** – Splits large orders into smaller increments.  
✅ **CLI Interface** – User-friendly interactive command-line menu.  
✅ **Logging** – Detailed logs to monitor execution and performance.  

---

## 🛠️ Installation & Setup

### **1️⃣ Prerequisites**
Ensure you have the following installed:  
- **[Node.js](https://nodejs.org/)** (Latest LTS version recommended)  
- **Git** (Optional, but recommended for version control)  

### **2️⃣ Clone the Repository**  
To get started, **clone this repository** and navigate to the project folder:  

```sh
git clone https://github.com/YOUR_GITHUB_USERNAME/iceberg-bot.git
cd iceberg-bot
```

### **3️⃣ Install Dependencies**  
Run the following command to install required packages:  

```sh
npm install
```

### **4️⃣ Configure Your API Keys**  
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
node main.js
```

This will start the **interactive menu**, allowing you to create and manage positions.

### **Monitor Logs**
If you need to check system logs, use:

```sh
cat main.log  # View main script logs
cat monitoring.log  # View monitoring logs
```

---

## 📜 Usage Guide

### **1️⃣ Create an Iceberg Position**
Follow the **CLI prompts** to set:  
- The market you want to bet on  
- The max amount of your position  
- Your betting edge  
- Min order size & increments  
- Max vig allowed  

### **2️⃣ Monitor Active Positions**
The bot continuously checks:  
- **Your filled volume**  
- **Best available taker odds**  
- **Market vig conditions**  
- **Whether your orders need re-posting**  

### **3️⃣ Cancel or Update Positions**
From the **Manage Positions** menu, you can:  
- Adjust **edge, increments, max fill, or vig**  
- **Stop monitoring** a position  
- **Cancel all open orders**  

---

## 📂 File Structure

```
📁 iceberg-bot
├── 📜 README.md          # This documentation
├── 📜 .gitignore         # Ignore sensitive files
├── 📜 LICENSE            # License file
├── 📜 config.js          # Configuration file
├── 📜 main.js            # CLI and position management
├── 📜 network.js         # Handles API requests
├── 📜 logger.js          # Logging utilities
├── 📜 iceberghelpergit.js # Monitoring & execution
└── 📜 iceberggit.js       # Helper functions
```

---

## 🛠️ Troubleshooting

### **Bot is Not Posting Orders**
- Ensure your API keys are correct in `.env`.  
- Check logs for `Error fetching active orders` messages.  
- Verify **market vig** is within the allowed limit.

### **Bot is Reposting Orders Too Frequently**
- Your orders may be getting outbid quickly.  
- Increase **edge percentage** in your position settings.  

### **How to Stop the Bot**
- Use `CTRL+C` to stop execution.  
- Run `node main.js` again to restart.  

---

## ⚖️ License
This project is **MIT Licensed** – Free to use, modify, and distribute.  

---

## 📬 Support & Contributions
💡 **Found a bug or have an idea?** Open an issue or PR on **GitHub**.  
🔗 **Join the discussion**: [GitHub Issues](https://github.com/YOUR_GITHUB_USERNAME/iceberg-bot/issues)  
