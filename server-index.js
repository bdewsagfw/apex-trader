const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const INITIAL_CASH = 100;
const CYCLE_INTERVAL_MS = 5 * 60 * 1000;
const TICKERS = ["NVDA", "TSLA", "AAPL", "AMD", "META", "MSTR", "COIN", "AMZN", "GOOGL", "MSFT"];

// ─── Helpers ────────────────────────────────────────────────────────────────

async function getState() {
  const { data } = await supabase
    .from("portfolio")
    .select("*")
    .eq("id", 1)
    .single();

  if (!data) {
    const init = {
      id: 1,
      cash: INITIAL_CASH,
      holdings: {},
      prices: {},
      trades: [],
      log: [],
      total_value: INITIAL_CASH,
      peak_value: INITIAL_CASH,
      created_at: new Date().toISOString(),
    };
    await supabase.from("portfolio").insert(init);
    return init;
  }
  return data;
}

async function saveState(state) {
  const { data, error } = await supabase.from("portfolio").upsert(state);
  if (error) console.error("Supabase save error:", JSON.stringify(error));
  else console.log("Supabase save success");
}

function calcTotal(cash, holdings, prices) {
  let total = cash;
  for (const [sym, { shares }] of Object.entries(holdings)) {
    if (prices[sym]) total += shares * prices[sym];
  }
  return total;
}

// ─── Fetch Prices from Yahoo Finance ────────────────────────────────────────

async function fetchPrices(tickers) {
  const prices = {};
  for (const ticker of tickers) {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1m&range=1d`;
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0" },
      });
      const json = await res.json();
      const price = json?.chart?.result?.[0]?.meta?.regularMarketPrice;
      if (price) prices[ticker] = price;
    } catch (e) {
      console.error(`Failed to fetch price for ${ticker}:`, e.message);
    }
  }
  return prices;
}

// ─── Fetch Day Change % ──────────────────────────────────────────────────────

async function fetchDayChange(ticker) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=2d`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    const json = await res.json();
    const closes = json?.chart?.result?.[0]?.indicators?.quote?.[0]?.close;
    if (closes && closes.length >= 2) {
      const prev = closes[closes.length - 2];
      const curr = closes[closes.length - 1];
      return ((curr - prev) / prev) * 100;
    }
  } catch (e) {}
  return 0;
}

// ─── Core Trading Cycle ──────────────────────────────────────────────────────

async function runTradingCycle() {
  console.log(`[${new Date().toISOString()}] Running trading cycle...`);

  const state = await getState();
  let { cash, holdings, prices: existingPrices, trades, log } = state;

  // Fetch current prices
  const fetchedPrices = await fetchPrices(TICKERS);
  const newPrices = { ...existingPrices, ...fetchedPrices };

  if (Object.keys(fetchedPrices).length === 0) {
    console.error("No prices fetched, skipping cycle.");
    return;
  }

  // Fetch day changes for all tickers
  const changes = {};
  for (const ticker of TICKERS) {
    changes[ticker] = await fetchDayChange(ticker);
  }
  console.log("Day changes:", changes);

  let newCash = cash;
  let newHoldings = { ...holdings };
  const newTrades = [...trades];
  const newLog = [...log];

  // SELL any position that is currently unprofitable (current price < avg cost)
  for (const sym of Object.keys(newHoldings)) {
    const holding = newHoldings[sym];
    const price = newPrices[sym];
    if (!price) continue;

    const isUnprofitable = price < holding.avgCost;

    if (isUnprofitable) {
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

  // BUY any ticker that is up today and we don't already hold
  // Spread available cash evenly across all good opportunities
  const opportunities = TICKERS.filter(
    (t) => fetchedPrices[t] && changes[t] > 0.5 && !newHoldings[t]
  ).sort((a, b) => changes[b] - changes[a]);

  if (opportunities.length > 0 && newCash > 5) {
    // Allocate up to 80% of cash, spread across opportunities (max 5 at a time)
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

// ─── API Routes ──────────────────────────────────────────────────────────────

app.get("/state", async (req, res) => {
  const state = await getState();
  res.json(state);
});

app.post("/reset", async (req, res) => {
  await supabase.from("portfolio").delete().eq("id", 1);
  res.json({ ok: true });
});

// ─── Start ───────────────────────────────────────────────────────────────────

app.listen(3001, () => {
  console.log("Trading server running on port 3001");
  runTradingCycle();
  setInterval(runTradingCycle, CYCLE_INTERVAL_MS);
});
