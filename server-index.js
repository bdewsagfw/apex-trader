const express = require(‘express’);
const cors = require(‘cors’);

const app = express();
app.use(cors());
app.use(express.json());

const INITIAL_CASH = 100;
const CYCLE_INTERVAL_MS = 5 * 60 * 1000;

const S = {
TAKE_PROFIT_PCT:    0.06,
STOP_LOSS_PCT:     -0.025,
TRAILING_STOP_PCT: -0.04,
MAX_HOLD_HOURS:     36,
MAX_POSITIONS:      20,
CASH_RESERVE_PCT:   0.08,
MOMENTUM_MIN:       0.4,
RSI_OVERSOLD:       32,
RSI_OVERBOUGHT:     70,
PYRAMID_THRESHOLD:  0.03,
MIN_TRADE_USD:      1.50,
POSITION_SIZE_BASE: 0.18,
BREAKOUT_MULT:      1.005,
};

const TICKERS = [
‘NVDA’, ‘META’, ‘MSFT’, ‘AAPL’, ‘AMZN’, ‘GOOGL’,
‘AMD’, ‘TSLA’, ‘ARM’, ‘AVGO’,
‘MSTR’, ‘COIN’, ‘HOOD’, ‘RIOT’, ‘MARA’,
‘PLTR’, ‘RKLB’, ‘IONQ’, ‘SOUN’,
‘RIVN’, ‘NIO’, ‘XPEV’,
‘TQQQ’, ‘SOXL’, ‘FNGU’,
];

const JSONBIN_ID  = process.env.JSONBIN_ID;
const JSONBIN_KEY = process.env.JSONBIN_KEY;
const JSONBIN_URL = `https://api.jsonbin.io/v3/b/${JSONBIN_ID}`;

let memoryState = {
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

async function getState() {
try {
const res  = await fetch(JSONBIN_URL + ‘/latest’, {
headers: { ‘X-Master-Key’: JSONBIN_KEY },
});
const json = await res.json();
if (json.record) {
memoryState = json.record;
if (!memoryState.priceHistory) memoryState.priceHistory = {};
return memoryState;
}
} catch (e) {
console.error(‘JSONBin read error:’, e.message);
}
return memoryState;
}

async function saveState(state) {
try {
memoryState = state;
await fetch(JSONBIN_URL, {
method: ‘PUT’,
headers: {
‘Content-Type’: ‘application/json’,
‘X-Master-Key’: JSONBIN_KEY,
},
body: JSON.stringify(state),
});
console.log(‘State saved to JSONBin’);
} catch (e) {
console.error(‘JSONBin save error:’, e.message);
}
}

async function fetchQuote(ticker) {
try {
const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=5m&range=2d`;
const res  = await fetch(url, { headers: { ‘User-Agent’: ‘Mozilla/5.0’ } });
const json = await res.json();
const result = json && json.chart && json.chart.result && json.chart.result[0];
if (!result) return null;

```
const meta         = result.meta;
const price        = meta.regularMarketPrice;
const prevClose    = meta.chartPreviousClose || meta.previousClose;
const dayChangePct = prevClose ? ((price - prevClose) / prevClose) * 100 : 0;

const closes  = (result.indicators && result.indicators.quote && result.indicators.quote[0] && result.indicators.quote[0].close || []).filter(Boolean);
const last5   = closes.slice(-5);
const sma5    = last5.length ? last5.reduce((a, b) => a + b, 0) / last5.length : price;

const volumes = (result.indicators && result.indicators.quote && result.indicators.quote[0] && result.indicators.quote[0].volume || []).filter(Boolean);
const avgVol  = volumes.length > 5 ? volumes.slice(-20).reduce((a, b) => a + b, 0) / Math.min(volumes.length, 20) : 0;
const lastVol  = volumes[volumes.length - 1] || 0;
const volRatio = avgVol > 0 ? lastVol / avgVol : 1;

return { ticker, price, prevClose, dayChangePct, sma5, volRatio, closes };
```

} catch (e) {
console.error(’Quote failed for ’ + ticker + ‘:’, e.message);
return null;
}
}

async function fetchAllQuotes(tickers) {
const results = await Promise.all(tickers.map(fetchQuote));
return results.filter(Boolean);
}

function calcRSI(closes) {
if (closes.length < 15) return 50;
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
return ema12 - ema26;
}

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

function scoreTicker(quote, priceHistory) {
const history = (priceHistory[quote.ticker] || []).concat([quote.price]).slice(-20);
const rsi     = calcRSI(history);
const macd    = calcMACD(history);
const bbPos   = bollingerPosition(history);

let score = 0;

if (quote.dayChangePct > S.MOMENTUM_MIN)        score += quote.dayChangePct * 2;
if (rsi < S.RSI_OVERSOLD)                       score += 20;
else if (rsi < 50)                               score += 10;
else if (rsi > S.RSI_OVERBOUGHT)                 score -= 20;
if (macd > 0)                                    score += 10;
if (bbPos < 0.2)                                 score += 15;
else if (bbPos > 0.85)                           score -= 10;
if (quote.volRatio > 1.5)                        score += 15;
else if (quote.volRatio > 1.2)                   score += 7;
if (quote.price > quote.sma5 * S.BREAKOUT_MULT)  score += 10;

return Object.assign({}, quote, { score, rsi, macd, bbPos });
}

function evaluateSells(holdings, prices, priceHistory, log) {
const sells  = [];
const newLog = log.slice();
const now    = Date.now();

for (const sym of Object.keys(holdings)) {
const holding = holdings[sym];
const price = prices[sym];
if (!price) continue;

```
const avgCost   = holding.avgCost;
const shares    = holding.shares;
const buyTime   = holding.buyTime;
const peakPrice = holding.peakPrice || avgCost;
const pnlPct    = (price - avgCost) / avgCost;
const fromPeak  = (price - peakPrice) / peakPrice;
const hoursHeld = (now - new Date(buyTime).getTime()) / 3600000;
const history   = (priceHistory[sym] || []).concat([price]).slice(-20);
const rsi       = calcRSI(history);

let reason = null;

if (pnlPct >= S.TAKE_PROFIT_PCT) {
  reason = 'TAKE PROFIT +' + (pnlPct * 100).toFixed(2) + '%';
} else if (pnlPct <= S.STOP_LOSS_PCT) {
  reason = 'STOP LOSS ' + (pnlPct * 100).toFixed(2) + '%';
} else if (fromPeak <= S.TRAILING_STOP_PCT) {
  reason = 'TRAILING STOP (fell ' + (fromPeak * 100).toFixed(2) + '% from peak)';
} else if (hoursHeld >= S.MAX_HOLD_HOURS) {
  reason = 'MAX HOLD TIME (' + hoursHeld.toFixed(0) + 'h)';
} else if (rsi > S.RSI_OVERBOUGHT) {
  reason = 'RSI OVERBOUGHT (' + rsi.toFixed(0) + ')';
}

if (reason) {
  sells.push({ sym, shares, price, avgCost, reason, pnlPct });
  newLog.push({
    time: new Date().toISOString(),
    type: 'sell',
    message: 'SELL ' + sym + ' — ' + shares.toFixed(4) + ' sh @ $' + price.toFixed(2) + ' | ' + reason,
  });
  console.log('SELL signal: ' + sym + ' — ' + reason);
}
```

}

return { sells, newLog };
}

function evaluateBuys(quotes, holdings, cash, totalValue, priceHistory, justSold) {
const positionCount  = Object.keys(holdings).length;
const availableSlots = S.MAX_POSITIONS - positionCount;
if (availableSlots <= 0 || cash < S.MIN_TRADE_USD) return [];

const reserveCash = totalValue * S.CASH_RESERVE_PCT;
const deployable  = Math.max(0, cash - reserveCash);
if (deployable < S.MIN_TRADE_USD) return [];

const scored = quotes
.map(q => scoreTicker(q, priceHistory))
.filter(q => {
if (justSold.has(q.ticker)) return false;
if (holdings[q.ticker]) {
const h      = holdings[q.ticker];
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
const conviction   = Math.min(q.score / 60, 1.0);
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

function calcTotal(cash, holdings, prices) {
let total = cash;
for (const sym of Object.keys(holdings)) {
if (prices[sym]) total += holdings[sym].shares * prices[sym];
}
return total;
}

async function runTradingCycle() {
console.log(’\n[’ + new Date().toISOString() + ‘] Trading Cycle Start’);

const state = await getState();
const cash           = state.cash;
const holdings       = state.holdings;
const existingPrices = state.prices;
const priceHistory   = state.priceHistory || {};
const trades         = state.trades;
const log            = state.log;

const quotes = await fetchAllQuotes(TICKERS);
if (quotes.length === 0) {
console.error(‘No quotes fetched — market may be closed.’);
return;
}
console.log(‘Fetched ’ + quotes.length + ’ quotes’);

const newPrices = Object.assign({}, existingPrices);
for (const q of quotes) newPrices[q.ticker] = q.price;

const newPriceHistory = Object.assign({}, priceHistory);
for (const q of quotes) {
const hist = newPriceHistory[q.ticker] || [];
newPriceHistory[q.ticker] = hist.concat([q.price]).slice(-20);
}

const newHoldings = Object.assign({}, holdings);
for (const sym of Object.keys(newHoldings)) {
const price = newPrices[sym] || newHoldings[sym].avgCost;
newHoldings[sym] = Object.assign({}, newHoldings[sym], {
peakPrice: Math.max(newHoldings[sym].peakPrice || newHoldings[sym].avgCost, price),
});
}

let newCash   = cash;
let newTrades = trades.slice();
let newLog    = log.slice();

const justSold = new Set();
const sellResult = evaluateSells(newHoldings, newPrices, newPriceHistory, newLog);
const sells = sellResult.sells;
newLog = sellResult.newLog;

for (const sell of sells) {
const proceeds = sell.shares * sell.price;
const pnl      = (sell.price - sell.avgCost) * sell.shares;
newCash += proceeds;
delete newHoldings[sell.sym];
justSold.add(sell.sym);
newTrades.push({
action: ‘SELL’, symbol: sell.sym, shares: sell.shares, price: sell.price, avgCost: sell.avgCost,
pnl, pnlPct: sell.pnlPct * 100,
buyTime: holdings[sell.sym] && holdings[sell.sym].buyTime,
time: new Date().toISOString(),
});
}

const totalAfterSells = calcTotal(newCash, newHoldings, newPrices);
const buys = evaluateBuys(quotes, newHoldings, newCash, totalAfterSells, newPriceHistory, justSold);

for (const buy of buys) {
const shares  = buy.spend / buy.price;
const buyTime = new Date().toISOString();
newCash -= buy.spend;

```
const existing    = newHoldings[buy.sym] || { shares: 0, avgCost: 0 };
const totalShares = existing.shares + shares;
const avgCost     = existing.shares > 0
  ? (existing.shares * existing.avgCost + buy.spend) / totalShares
  : buy.price;

newHoldings[buy.sym] = { shares: totalShares, avgCost, buyTime, peakPrice: buy.price };
newTrades.push({
  action: 'BUY', symbol: buy.sym, shares, price: buy.price, avgCost,
  pnl: 0, pnlPct: 0, buyTime, time: buyTime,
});
newLog.push({
  time: buyTime,
  type: 'buy',
  message: 'BUY ' + buy.sym + ' — ' + shares.toFixed(4) + ' sh @ $' + buy.price.toFixed(2) + ' | Score:' + buy.score.toFixed(0) + ' RSI:' + buy.rsi.toFixed(0) + ' $' + buy.spend.toFixed(2) + ' deployed',
});
console.log('BUY ' + buy.sym + ' x' + shares.toFixed(4) + ' @ ' + buy.price + ' (score ' + buy.score.toFixed(0) + ')');
```

}

const newTotal = calcTotal(newCash, newHoldings, newPrices);
const pnlPct   = ((newTotal - INITIAL_CASH) / INITIAL_CASH * 100).toFixed(2);

newLog.push({
time: new Date().toISOString(),
type: ‘info’,
message: ‘Scan complete. ’ + sells.length + ’ sold, ’ + buys.length + ’ bought. ’ + Object.keys(newHoldings).length + ’ positions. Cash $’ + newCash.toFixed(2) + ’ | Total $’ + newTotal.toFixed(2) + ’ (’ + pnlPct + ‘%)’,
});

console.log(‘Cycle done: ’ + sells.length + ’ sells, ’ + buys.length + ’ buys | Value $’ + newTotal.toFixed(2));

await saveState(Object.assign({}, state, {
cash: newCash,
holdings: newHoldings,
prices: newPrices,
priceHistory: newPriceHistory,
trades: newTrades.slice(-2000),
log: newLog.slice(-2000),
total_value: newTotal,
peak_value: Math.max(state.peak_value || INITIAL_CASH, newTotal),
last_cycle: new Date().toISOString(),
}));
}

app.get(’/state’, async (req, res) => {
res.json(await getState());
});

app.get(’/health’, (req, res) => {
res.json({ ok: true, time: new Date().toISOString() });
});

app.post(’/reset’, async (req, res) => {
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

app.post(’/cycle’, async (req, res) => {
runTradingCycle().catch(console.error);
res.json({ ok: true, message: ‘Cycle triggered’ });
});

app.listen(3001, () => {
console.log(‘APEX//TRADER server running on port 3001’);
runTradingCycle();
setInterval(runTradingCycle, CYCLE_INTERVAL_MS);
});
