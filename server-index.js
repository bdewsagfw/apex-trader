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

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const INITIAL_CASH = 100;
const CYCLE_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes

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
  await supabase.from("portfolio").upsert(state);
}

function calcTotal(cash, holdings, prices) {
  let total = cash;
  for (const [sym, { shares }] of Object.entries(holdings)) {
    if (prices[sym]) total += shares * prices[sym];
  }
  return total;
}

// ─── Core Trading Logic ──────────────────────────────────────────────────────

async function runTradingCycle() {
  console.log(`[${new Date().toISOString()}] Running trading cycle...`);

  const state = await getState();
  const { cash, holdings, prices: existingPrices, trades, log } = state;

  const portfolioSummary =
    Object.entries(holdings)
      .map(([sym, { shares, avgCost }]) => {
        const price = existingPrices[sym] || avgCost;
        const pnl = (price - avgCost) * shares;
        return `${sym}: ${shares.toFixed(4)} shares @ avg $${avgCost.toFixed(
          2
        )}, current ~$${price.toFixed(2)}, PnL $${pnl.toFixed(2)}`;
      })
      .join("\n") || "Empty";

  const recentTrades = trades
    .slice(-5)
    .map(
      (t) =>
        `${t.action} ${t.symbol} x${t.shares.toFixed(4)} @ $${t.price.toFixed(
          2
        )}`
    )
    .join(", ") || "None";

  const prompt = `You are an aggressive AI day trader managing a paper portfolio. Goal: grow $${INITIAL_CASH} to $1000 as fast as possible.

CURRENT STATE:
- Cash: $${cash.toFixed(2)}
- Total value: $${state.total_value.toFixed(2)}
- P&L: ${(((state.total_value - INITIAL_CASH) / INITIAL_CASH) * 100).toFixed(2)}%
- Holdings: ${portfolioSummary}
- Recent trades: ${recentTrades}

TASK:
1. Use web_search to get REAL current prices for 2-3 high-momentum tickers from: NVDA, TSLA, AAPL, AMD, META, MSTR, COIN, BTC, ETH, SOL, DOGE
2. Analyze momentum, news sentiment, volatility
3. Make AGGRESSIVE decisions — concentrate into winners, cut losers

Respond ONLY with this exact JSON (no markdown, no extra text):
{
  "prices": {"SYMBOL": price_number},
  "decisions": [
    {"action": "BUY" or "SELL", "symbol": "TICKER", "allocation": 0.0_to_1.0, "reason": "short reason"}
  ],
  "analysis": "1-2 sentence market read"
}

Rules:
- BUY allocation = fraction of available cash (0.8 = 80% of cash)
- SELL allocation = fraction of shares to sell (1.0 = sell all)
- Be BOLD. Concentrate. Max 3 positions at once.`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const data = await response.json();
    const textBlocks = data.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");

    let parsed;
    try {
      const jsonMatch = textBlocks.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      console.error("Failed to parse Claude response");
      return;
    }

    const newPrices = { ...existingPrices, ...parsed.prices };
    let newCash = cash;
    let newHoldings = { ...holdings };
    const newTrades = [...trades];
    const newLog = [
      ...log,
      {
        time: new Date().toISOString(),
        type: "analysis",
        message: parsed.analysis || "Market scan complete.",
      },
    ];

    for (const { action, symbol, allocation, reason } of parsed.decisions ||
      []) {
      const price = newPrices[symbol];
      if (!price || price <= 0) continue;

      if (action === "BUY" && newCash > 1) {
        const spend = newCash * Math.min(allocation, 1.0);
        if (spend < 0.5) continue;
        const shares = spend / price;
        newCash -= spend;
        const existing = newHoldings[symbol] || { shares: 0, avgCost: 0 };
        const totalShares = existing.shares + shares;
        const avgCost =
          (existing.shares * existing.avgCost + spend) / totalShares;
        newHoldings[symbol] = { shares: totalShares, avgCost };
        newTrades.push({
          action: "BUY",
          symbol,
          shares,
          price,
          time: new Date().toISOString(),
        });
        newLog.push({
          time: new Date().toISOString(),
          type: "buy",
          message: `BUY ${symbol} — ${shares.toFixed(4)} shares @ $${price.toFixed(2)} | ${reason}`,
        });
        console.log(`BUY ${symbol} x${shares.toFixed(4)} @ $${price}`);
      } else if (action === "SELL" && newHoldings[symbol]) {
        const holding = newHoldings[symbol];
        const sellShares = holding.shares * Math.min(allocation, 1.0);
        if (sellShares < 0.0001) continue;
        const proceeds = sellShares * price;
        newCash += proceeds;
        const remaining = holding.shares - sellShares;
        if (remaining < 0.0001) delete newHoldings[symbol];
        else newHoldings[symbol] = { ...holding, shares: remaining };
        newTrades.push({
          action: "SELL",
          symbol,
          shares: sellShares,
          price,
          time: new Date().toISOString(),
        });
        newLog.push({
          time: new Date().toISOString(),
          type: "sell",
          message: `SELL ${symbol} — ${sellShares.toFixed(4)} shares @ $${price.toFixed(2)} | ${reason}`,
        });
        console.log(`SELL ${symbol} x${sellShares.toFixed(4)} @ $${price}`);
      }
    }

    const newTotal = calcTotal(newCash, newHoldings, newPrices);

    await saveState({
      ...state,
      cash: newCash,
      holdings: newHoldings,
      prices: newPrices,
      trades: newTrades.slice(-200), // keep last 200 trades
      log: newLog.slice(-500),       // keep last 500 log entries
      total_value: newTotal,
      peak_value: Math.max(state.peak_value, newTotal),
      last_cycle: new Date().toISOString(),
    });

    console.log(`Cycle complete. Portfolio value: $${newTotal.toFixed(2)}`);
  } catch (err) {
    console.error("Trading cycle error:", err.message);
  }
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
  runTradingCycle(); // run immediately on start
  setInterval(runTradingCycle, CYCLE_INTERVAL_MS);
});
