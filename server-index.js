const express = require(“express”);
const cors = require(“cors”);

const app = express();
app.use(cors());
app.use(express.json());

const INITIAL_CASH = 100;
const CYCLE_INTERVAL_MS = 5 * 60 * 1000;

// ─── STRATEGY CONFIG ─────────────────────────────────────────────────────────
const S = {
TAKE_PROFIT_PCT:    0.06,   // Sell when up 6%
STOP_LOSS_PCT:     -0.025,  // Hard stop loss at -2.5%
TRAILING_STOP_PCT: -0.04,   // Trailing stop: sell if 4% below position peak
MAX_HOLD_HOURS:     36,     // Force-exit stale positions after 36h
MAX_POSITIONS:       20,     // Max simultaneous holdings
CASH_RESERVE_PCT:   0.08,   // Keep 8% cash buffer at all times
MOMENTUM_MIN:       0.4,    // Min % day gain to qualify as momentum buy
RSI_OVERSOLD:       32,     // Buy signal if RSI dips below this
RSI_OVERBOUGHT:     70,     // Sell signal if RSI spikes above this
PYRAMID_THRESHOLD:  0.03,   // Add to winner if up 3% (pyramid up)
MIN_TRADE_USD:       1.50,  // Skip trades below this dollar size
POSITION_SIZE_BASE: 0.18,   // Each position ~18% of portfolio by default
BREAKOUT_MULT:      1.005,  // Price must be 0.5% above 5-period MA to buy
};

// Tickers to scan — diversified across sectors and volatility profiles
const TICKERS = [
// Mega-cap tech / AI
“NVDA”, “META”, “MSFT”, “AAPL”, “AMZN”, “GOOGL”,
// High-beta tech
“AMD”, “TSLA”, “ARM”, “AVGO”,
// Crypto-adjacent / speculative
“MSTR”, “COIN”, “HOOD”, “RIOT”, “MARA”,
// Emerging tech
“PLTR”, “RKLB”, “IONQ”, “SOUN”,
// EV
“RIVN”, “NIO”, “XPEV”,
// Leveraged ETFs (high volatility, high reward)
“TQQQ”, “SOXL”, “FNGU”,
];

// ─── JSONBIN STATE ────────────────────────────────────────────────────────────
const JSONBIN_ID  = process.env.JSONBIN_ID;
const JSONBIN_KEY = process.env.JSONBIN_KEY;
const JSONBIN_URL = `https://api.jsonbin.io/v3/b/${JSONBIN_ID}`;

let memoryState = {
id: 1,
cash: INITIAL_CASH,
holdings: {},
prices: {},
priceHistory: {},   // { SYM: [p1, p2, p3, …] } last 14 closes
trades: [],
log: [],
total_value: INITIAL_CASH,
peak_value: INITIAL_CASH,
created_at: new Date().toISOString(),
last_cycle: null,
};

async function getState() {
try {
const res  = await fetch(JSONBIN_URL + “/latest”, {
headers: { “X-Master-Key”: JSONBIN_KEY },
});
const json = await res.json();
if (json.record) {
memoryState = json.record;
// Ensure new fields exist on old state objects
if (!memoryState.priceHistory) memoryState.priceHistory = {};
return memoryState;
}
} catch (e) {
console.error(“JSONBin read error:”, e.message);
}
return memoryState;
}

async function saveState(state) {
try {
memoryState = state;
await fetch(JSONBIN_URL, {
method: “PUT”,
headers: {
“Content-Type”: “application/json”,
“X-Master-Key”: JSONBIN_KEY,
},
body: JSON.stringify(state),
});
console.log(“State saved to JSONBin”);
} catch (e) {
console.error(“JSONBin save error:”, e.message);
}
}

// ─── PRICE FETCHING ───────────────────────────────────────────────────────────
async function fetchQuote(ticker) {
try {
const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=5m&range=2d`;
const res  = await fetch(url, { headers: { “User-Agent”: “Mozilla/5.0” } });
const json = await res.json();
const result = json?.chart?.result?.[0];
if (!result) return null;

```
const meta        = result.meta;
const price       = meta.regularMarketPrice;
const prevClose   = meta.chartPreviousClose || meta.previousClose;
const dayChangePct = prevClose ? ((price - prevClose) / prevClose) * 100 : 0;

// 5-period simple moving average from recent closes
const closes = result.indicators?.quote?.[0]?.close?.filter(Boolean) || [];
const last5   = closes.slice(-5);
const sma5    = last5.length ? last5.reduce((a, b) => a + b, 0) / last5.length : price;

// Volume ratio: current vs average
const volumes    = result.indicators?.quote?.[0]?.volume?.filter(Boolean) || [];
const avgVol     = volumes.length > 5
  ? volumes.slice(-20).reduce((a, b) => a + b, 0) / Math.min(volumes.length, 20)
  : 0;
const lastVol    = volumes[volumes.length - 1] || 0;
const volRatio   = avgVol > 0 ? lastVol / avgVol : 1;

return { ticker, price, prevClose, dayChangePct, sma5, volRatio, closes };
```

} catch (e) {
console.error(`Quote failed for ${ticker}:`, e.message);
return null;
}
}

async function fetchAllQuotes(tickers) {
const results = await Promise.all(tickers.map(fetchQuote));
return results.filter(Boolean);
}

// ─── TECHNICAL INDICATORS ─────────────────────────────────────────────────────

// RSI (Relative Strength Index) — 14-period
function calcRSI(closes) {
if (closes.length < 15) return 50; // neutral if not enough data
const slice = closes.slice(-15);
let gains = 0, losses = 0;
for (let i = 1; i < slice.length; i++) {
const diff = slice[i] - slice[i - 1];
if (diff >= 0) gains  += diff;
else           losses -= diff;
}
const avgGain = gains  / 14;
const avgLoss = losses / 14;
if (avgLoss === 0) return 100;
const rs = avgGain / avgLoss;
return 100 - 100 / (1 + rs);
}

// MACD signal: returns positive if bullish crossover
function calcMACD(closes) {
if (closes.length < 26) return 0;
const ema = (data, period) => {
const k = 2 / (period + 1);
let val = data[0];
for (let i = 1; i < data.length; i++) val = data[i] * k + val * (1 - k);
return val;
};
const ema12 = ema(closes.slice(-26), 12);
const ema26 = ema(closes.slice(-26), 26);
return ema12 - ema26; // positive = bullish
}

// Bollinger Band position: returns 0-1 (0=at lower band, 1=at upper band)
function bollingerPosition(closes) {
if (closes.length < 20) return 0.5;
const slice = closes.slice(-20);
const mean  = slice.reduce((a, b) => a + b, 0) / 20;
const std   = Math.sqrt(slice.reduce((s, p) => s + Math.pow(p - mean, 2), 0) / 20);
const upper = mean + 2 * std;
const lower = mean - 2 * std;
const price = slice[slice.length - 1];
return std > 0 ? (price - lower) / (upper - lower) : 0.5;
}

// Score a ticker for buy attractiveness (higher = better)
function scoreTicker(quote, priceHistory) {
const history = […(priceHistory[quote.ticker] || []), quote.price].slice(-20);
const rsi     = calcRSI(history);
const macd    = calcMACD(history);
const bbPos   = bollingerPosition(history);

let score = 0;

// Momentum: up today
if (quote.dayChangePct > S.MOMENTUM_MIN)   score += quote.dayChangePct * 2;

// RSI: prefer not overbought
if (rsi < S.RSI_OVERSOLD)                  score += 20; // oversold bounce
else if (rsi < 50)                          score += 10;
else if (rsi > S.RSI_OVERBOUGHT)            score -= 20;

// MACD bullish
if (macd > 0)                               score += 10;

// Bollinger: near lower band = potential bounce
if (bbPos < 0.2)                            score += 15;
else if (bbPos > 0.85)                      score -= 10;

// Volume spike = institutional interest
if (quote.volRatio > 1.5)                   score += 15;
else if (quote.volRatio > 1.2)              score += 7;

// Breakout above SMA5
if (quote.price > quote.sma5 * S.BREAKOUT_MULT) score += 10;

return { …quote, score, rsi, macd, bbPos };
}

// ─── SELL DECISIONS ───────────────────────────────────────────────────────────
function evaluateSells(holdings, prices, priceHistory, log) {
const sells   = [];
const newLog  = […log];
const now     = Date.now();

for (const [sym, holding] of Object.entries(holdings)) {
const price = prices[sym];
if (!price) continue;

```
const { avgCost, shares, buyTime, peakPrice = avgCost } = holding;
const pnlPct        = (price - avgCost) / avgCost;
const fromPeak      = (price - peakPrice) / peakPrice;
const hoursHeld     = (now - new Date(buyTime).getTime()) / 3600000;
const history       = [...(priceHistory[sym] || []), price].slice(-20);
const rsi           = calcRSI(history);

let reason = null;

if (pnlPct >= S.TAKE_PROFIT_PCT) {
  reason = `TAKE PROFIT +${(pnlPct * 100).toFixed(2)}%`;
} else if (pnlPct <= S.STOP_LOSS_PCT) {
  reason = `STOP LOSS ${(pnlPct * 100).toFixed(2)}%`;
} else if (fromPeak <= S.TRAILING_STOP_PCT) {
  reason = `TRAILING STOP (fell ${(fromPeak * 100).toFixed(2)}% from peak)`;
} else if (hoursHeld >= S.MAX_HOLD_HOURS) {
  reason = `MAX HOLD TIME (${hoursHeld.toFixed(0)}h) — freeing capital`;
} else if (rsi > S.RSI_OVERBOUGHT) {
  reason = `RSI OVERBOUGHT (${rsi.toFixed(0)}) — taking profits`;
}

if (reason) {
  sells.push({ sym, shares, price, avgCost, reason, pnlPct });
  newLog.push({
    time: new Date().toISOString(),
    type: "sell",
    message: `SELL ${sym} — ${shares.toFixed(4)} sh @ $${price.toFixed(2)} | ${reason}`,
  });
  console.log(`SELL signal: ${sym} — ${reason}`);
}
```

}

return { sells, newLog };
}

// ─── BUY DECISIONS ───────────────────────────────────────────────────────────
function evaluateBuys(quotes, holdings, cash, totalValue, priceHistory) {
const positionCount = Object.keys(holdings).length;
const availableSlots = S.MAX_POSITIONS - positionCount;
if (availableSlots <= 0 || cash < S.MIN_TRADE_USD) return [];

const reserveCash  = totalValue * S.CASH_RESERVE_PCT;
const deployable   = Math.max(0, cash - reserveCash);
if (deployable < S.MIN_TRADE_USD) return [];

// Score all candidates
const scored = quotes
.map(q => scoreTicker(q, priceHistory))
.filter(q => {
// Must not already hold (unless pyramiding)
if (holdings[q.ticker] && !S.PYRAMID_THRESHOLD) return false;
// Pyramid up: only add if already profitable
if (holdings[q.ticker]) {
const h = holdings[q.ticker];
const pnlPct = (q.price - h.avgCost) / h.avgCost;
return pnlPct >= S.PYRAMID_THRESHOLD;
}
return q.score > 0;
})
.sort((a, b) => b.score - a.score)
.slice(0, availableSlots);

const buys = [];
let remainingCash = deployable;

for (const q of scored) {
if (remainingCash < S.MIN_TRADE_USD) break;

```
// Kelly-inspired position sizing: bet more on higher-conviction signals
const conviction   = Math.min(q.score / 60, 1.0); // normalize 0-1
const baseSize     = S.POSITION_SIZE_BASE * totalValue;
const positionSize = Math.min(baseSize * (0.7 + conviction * 0.6), remainingCash * 0.9);
const spend        = Math.max(S.MIN_TRADE_USD, positionSize);

if (spend > remainingCash) continue;

buys.push({ sym: q.ticker, spend, price: q.price, score: q.score, rsi: q.rsi });
remainingCash -= spend;
```

}

return buys;
}

// ─── MAIN TRADING CYCLE ───────────────────────────────────────────────────────
async function runTradingCycle() {
console.log(`\n[${new Date().toISOString()}] ── Trading Cycle Start ──`);

const state = await getState();
let { cash, holdings, prices: existingPrices, priceHistory = {}, trades, log, total_value } = state;

// 1. Fetch fresh quotes for all tickers
const quotes = await fetchAllQuotes(TICKERS);
if (quotes.length === 0) {
console.error(“No quotes fetched — market may be closed or Yahoo is blocking.”);
return;
}
console.log(`Fetched ${quotes.length} quotes`);

// Build updated price map
const newPrices = { …existingPrices };
for (const q of quotes) newPrices[q.ticker] = q.price;

// Update price history (rolling 20 closes per ticker)
const newPriceHistory = { …priceHistory };
for (const q of quotes) {
const hist = newPriceHistory[q.ticker] || [];
newPriceHistory[q.ticker] = […hist, q.price].slice(-20);
}

// Update peak prices for trailing stop
const newHoldings = { …holdings };
for (const [sym, holding] of Object.entries(newHoldings)) {
const price = newPrices[sym] || holding.avgCost;
newHoldings[sym] = {
…holding,
peakPrice: Math.max(holding.peakPrice || holding.avgCost, price),
};
}

let newCash    = cash;
let newTrades  = […trades];
let newLog     = […log];

// 2. Evaluate sells first (free up capital before buying)
const { sells, newLog: logAfterSells } = evaluateSells(newHoldings, newPrices, newPriceHistory, newLog);
newLog = logAfterSells;

for (const sell of sells) {
const { sym, shares, price, avgCost, pnlPct } = sell;
const proceeds = shares * price;
const pnl      = (price - avgCost) * shares;
newCash += proceeds;
delete newHoldings[sym];
newTrades.push({
action: “SELL”, symbol: sym, shares, price, avgCost,
pnl, pnlPct: pnlPct * 100,
buyTime: holdings[sym]?.buyTime,
time: new Date().toISOString(),
});
}

// 3. Recalculate total after sells
const totalAfterSells = calcTotal(newCash, newHoldings, newPrices);

// 4. Evaluate buys
const buys = evaluateBuys(quotes, newHoldings, newCash, totalAfterSells, newPriceHistory);

for (const buy of buys) {
const { sym, spend, price, score, rsi } = buy;
const shares  = spend / price;
const buyTime = new Date().toISOString();
newCash -= spend;

```
const existing     = newHoldings[sym] || { shares: 0, avgCost: 0 };
const totalShares  = existing.shares + shares;
const avgCost      = existing.shares > 0
  ? (existing.shares * existing.avgCost + spend) / totalShares
  : price;

newHoldings[sym] = { shares: totalShares, avgCost, buyTime, peakPrice: price };
newTrades.push({
  action: "BUY", symbol: sym, shares, price, avgCost,
  pnl: 0, pnlPct: 0, buyTime, time: buyTime,
});
newLog.push({
  time: buyTime,
  type: "buy",
  message: `BUY ${sym} — ${shares.toFixed(4)} sh @ $${price.toFixed(2)} | Score:${score.toFixed(0)} RSI:${rsi.toFixed(0)} $${spend.toFixed(2)} deployed`,
});
console.log(`BUY ${sym} x${shares.toFixed(4)} @ $${price} (score ${score.toFixed(0)})`);
```

}

// 5. Summary log entry
const newTotal = calcTotal(newCash, newHoldings, newPrices);
const pnlPct   = ((newTotal - INITIAL_CASH) / INITIAL_CASH * 100).toFixed(2);
newLog.push({
time: new Date().toISOString(),
type: “info”,
message: `Scan complete. ${sells.length} sold, ${buys.length} bought. ${Object.keys(newHoldings).length} positions. Cash $${newCash.toFixed(2)} | Total $${newTotal.toFixed(2)} (${pnlPct}%)`,
});

console.log(`Cycle done: ${sells.length} sells, ${buys.length} buys | Value $${newTotal.toFixed(2)}`);

await saveState({
…state,
cash: newCash,
holdings: newHoldings,
prices: newPrices,
priceHistory: newPriceHistory,
trades: newTrades.slice(-2000),
log: newLog.slice(-2000),
total_value: newTotal,
peak_value: Math.max(state.peak_value || INITIAL_CASH, newTotal),
last_cycle: new Date().toISOString(),
});
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function calcTotal(cash, holdings, prices) {
let total = cash;
for (const [sym, { shares }] of Object.entries(holdings)) {
if (prices[sym]) total += shares * prices[sym];
}
return total;
}

// ─── API ROUTES ───────────────────────────────────────────────────────────────
app.get(”/state”, async (req, res) => {
res.json(await getState());
});

app.get(”/health”, (req, res) => {
res.json({ ok: true, time: new Date().toISOString() });
});

app.post(”/reset”, async (req, res) => {
const fresh = {
id: 1,
cash: INITIAL_CASH,
holdings: {},
prices: {},
priceHistory: {},
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

// Manual trigger for testing
app.post(”/cycle”, async (req, res) => {
runTradingCycle().catch(console.error);
res.json({ ok: true, message: “Cycle triggered” });
});

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(3001, () => {
console.log(“APEX//TRADER server running on port 3001”);
console.log(“Strategy config:”, S);
runTradingCycle();
setInterval(runTradingCycle, CYCLE_INTERVAL_MS);
});
