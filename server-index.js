const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const INITIAL_CASH = 100;
const CYCLE_INTERVAL_MS = 5 * 60 * 1000;
const TICKERS = [
  // Mega cap tech
  "NVDA", "TSLA", "META", "AAPL", "AMZN", "GOOGL", "MSFT",
  // AI & semiconductors
  "AMD", "ARM", "INTC", "SMCI", "AVGO", "QCOM", "MU",
  // Crypto-adjacent
  "MSTR", "COIN", "HOOD", "RIOT", "MARA",
  // High volatility growth
  "PLTR", "RKLB", "IONQ", "RGTI", "QUBT", "SOUN",
  // EV & speculative
  "RIVN", "LCID", "NIO", "XPEV", "SOFI",
  // Leveraged ETFs
  "SQQQ", "TQQQ", "UVXY"
];

const JSONBIN_ID = process.env.JSONBIN_ID;
const JSONBIN_KEY = process.env.JSONBIN_KEY;
const JSONBIN_URL = `https://api.jsonbin.io/v3/b/${JSONBIN_ID}`;

// ─── Fallback In-Memory State ─────────────────────────────────────────────────

let memoryState = {
  id: 1,
  cash: INITIAL_CASH,
  holdings: {},
  prices: {},
  trades: [],
  log: [],
  total_value: INITIAL_CASH,
  peak_value: INITIAL_CASH,
  created_at: new Date().toISOString(),
  last_cycle: null,
};

// ─── JSONBin Helpers ──────────────────────────────────────────────────────────

async function getState() {
  try {
    const res = await fetch(JSONBIN_URL + "/latest", {
      headers: { "X-Master-Key": JSONBIN_KEY },
    });
    const json = await res.json();
    if (json.record) {
      memoryState = json.record;
      return json.record;
    }
  } catch (e) {
    console.error("JSONBin read error:", e.message);
  }
  return memoryState;
}

async function saveState(state) {
  try {
    memoryState = state;
    const res = await fetch(JSONBIN_URL, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-Master-Key": JSONBIN_KEY,
      },
      body: JSON.stringify(state),
    });
    const json = await res.json();
    if (json.record) {
      console.log("JSONBin save success");
    } else {
      console.error("JSONBin save error:", JSON.stringify(json));
    }
  } catch (e) {
    console.error("JSONBin save error:", e.message);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function calcTotal(cash, holdings, prices) {
  let total = cash;
  for (const [sym, { shares }] of Object.entries(holdings)) {
    if (prices[sym]) total += shares * prices[sym];
  }
  return total;
}

// ─── Parallel Price Fetching ──────────────────────────────────────────────────

async function fetchPriceForTicker(ticker) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1m&range=1d`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    const json = await res.json();
    const price = json?.chart?.result?.[0]?.meta?.regularMarketPrice;
    return price ? { ticker, price } : null;
  } catch (e) {
    console.error(`Price fetch failed for ${ticker}:`, e.message);
    return null;
  }
}

async function fetchDayChangeForTicker(ticker) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=2d`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    const json = await res.json();
    const closes = json?.chart?.result?.[0]?.indicators?.quote?.[0]?.close;
    if (closes && closes.length >= 2) {
      const prev = closes[closes.length - 2];
      const curr = closes[closes.length - 1];
      return { ticker, change: ((curr - prev) / prev) * 100 };
    }
  } catch (e) {}
  return { ticker, change: 0 };
}

async function fetchAllPricesAndChanges(tickers) {
  const [priceResults, changeResults] = await Promise.all([
    Promise.all(tickers.map(fetchPriceForTicker)),
    Promise.all(tickers.map(fetchDayChangeForTicker)),
  ]);

  const prices = {};
  for (const result of priceResults) {
    if (result) prices[result.ticker] = result.price;
  }

  const changes = {};
  for (const result of changeResults) {
    changes[result.ticker] = result.change;
  }

  return { prices, changes };
}

// ─── Core Trading Cycle ───────────────────────────────────────────────────────

async function runTradingCycle() {
  console.log(`[${new Date().toISOString()}] Running trading cycle...`);

  const state = await getState();
  let { cash, holdings, prices: existingPrices, trades, log } = state;

  // Fetch all prices and changes in parallel
  const { prices: fetchedPrices, changes } = await fetchAllPricesAndChanges(TICKERS);
  const newPrices = { ...existingPrices, ...fetchedPrices };

  if (Object.keys(fetchedPrices).length === 0) {
    console.error("No prices fetched, skipping cycle.");
    return;
  }

  console.log("Day changes:", changes);

  let newCash = cash;
  let newHoldings = { ...holdings };
  const newTrades = [...trades];
  const newLog = [...log];

  // SELL unprofitable positions
  for (const sym of Object.keys(newHoldings)) {
    const holding = newHoldings[sym];
    const price = newPrices[sym];
    if (!price) continue;

    if (price < holding.avgCost) {
      const proceeds = holding.shares * price;
      newCash += proceeds;
      const pnl = (price - holding.avgCost) * holding.shares;
      delete newHoldings[sym];
      newTrades.push({ action: "SELL", symbol: sym, shares: holding.shares, price, time: new Date().toISOString() });
      newLog.push({
        time: new Date().toISOString(),
        type: "sell",
        message: `SELL ${sym} — ${holding.shares.toFixed(4)} shares @ $${price.toFixed(2)} | unprofitable, P&L $${pnl.toFixed(2)}`,
      });
      console.log(`SELL ${sym} (unprofitable, P&L $${pnl.toFixed(2)})`);
    }
  }

  // BUY tickers up today
  const opportunities = TICKERS.filter(
    (t) => fetchedPrices[t] && changes[t] > 0.5 && !newHoldings[t]
  ).sort((a, b) => changes[b] - changes[a]);

  if (opportunities.length > 0 && newCash > 5) {
    const maxNew = Math.min(opportunities.length, 5);
    const allocPerTicker = (newCash * 0.8) / maxNew;

    for (let i = 0; i < maxNew; i++) {
      const sym = opportunities[i];
      const price = newPrices[sym];
      if (!price || allocPerTicker < 1) continue;

      const shares = allocPerTicker / price;
      newCash -= allocPerTicker;
      newHoldings[sym] = { shares, avgCost: price };
      newTrades.push({ action: "BUY", symbol: sym, shares, price, time: new Date().toISOString() });
      newLog.push({
        time: new Date().toISOString(),
        type: "buy",
        message: `BUY ${sym} — ${shares.toFixed(4)} shares @ $${price.toFixed(2)} | up ${changes[sym].toFixed(2)}% today`,
      });
      console.log(`BUY ${sym} x${shares.toFixed(4)} @ $${price}`);
    }
  }

  newLog.push({
    time: new Date().toISOString(),
    type: "info",
    message: `Scan complete. ${Object.keys(newHoldings).length} positions held. Cash: $${newCash.toFixed(2)}`,
  });

  const newTotal = calcTotal(newCash, newHoldings, newPrices);

  await saveState({
    ...state,
    cash: newCash,
    holdings: newHoldings,
    prices: newPrices,
    trades: newTrades.slice(-200),
    log: newLog.slice(-500),
    total_value: newTotal,
    peak_value: Math.max(state.peak_value, newTotal),
    last_cycle: new Date().toISOString(),
  });

  console.log(`Cycle complete. Portfolio value: $${newTotal.toFixed(2)}`);
}

// ─── API Routes ───────────────────────────────────────────────────────────────

app.get("/state", async (req, res) => {
  const state = await getState();
  res.json(state);
});

app.post("/reset", async (req, res) => {
  const fresh = {
    id: 1,
    cash: INITIAL_CASH,
    holdings: {},
    prices: {},
    trades: [],
    log: [],
    total_value: INITIAL_CASH,
    peak_value: INITIAL_CASH,
    created_at: new Date().toISOString(),
    last_cycle: null,
  };
  await saveState(fresh);
  res.json({ ok: true });
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(3001, () => {
  console.log("Trading server running on port 3001");
  runTradingCycle();
  setInterval(runTradingCycle, CYCLE_INTERVAL_MS);
});
