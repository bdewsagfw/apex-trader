import { useState, useEffect, useRef } from "react";

// ─── IMPORTANT: Replace this with your Railway backend URL after deploying ───
const API_URL = process.env.REACT_APP_API_URL || "http://localhost:3001";

const INITIAL_CASH = 100;

function formatUSD(n) {
  return "$" + Number(n || 0).toFixed(2);
}
function formatPct(n) {
  const sign = n >= 0 ? "+" : "";
  return sign + Number(n || 0).toFixed(2) + "%";
}

function PulsingDot({ color }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center" }}>
      <span style={{
        width: 8, height: 8, borderRadius: "50%", background: color,
        display: "inline-block", animation: "pulse 1.5s infinite",
      }} />
    </span>
  );
}

export default function TradingBot() {
  const [state, setState] = useState(null);
  const [activeTab, setActiveTab] = useState("live");
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState(null);
  const logEndRef = useRef(null);
  const pollRef = useRef(null);

  useEffect(() => {
    fetchState();
    pollRef.current = setInterval(fetchState, 15000); // poll every 15s
    return () => clearInterval(pollRef.current);
  }, []);

  useEffect(() => {
    if (logEndRef.current) logEndRef.current.scrollIntoView({ behavior: "smooth" });
  }, [state?.log]);

  async function fetchState() {
    try {
      const res = await fetch(`${API_URL}/state`);
      const data = await res.json();
      setState(data);
      setLastRefresh(new Date().toLocaleTimeString());
    } catch (err) {
      console.error("Failed to fetch state:", err);
    } finally {
      setLoading(false);
    }
  }

  async function handleReset() {
    if (!confirm("Reset portfolio back to $100? This cannot be undone.")) return;
    await fetch(`${API_URL}/reset`, { method: "POST" });
    await fetchState();
  }

  if (loading) {
    return (
      <div style={{ minHeight: "100vh", background: "#080c10", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'IBM Plex Mono', monospace", color: "#00ff88" }}>
        Connecting to trading server...
      </div>
    );
  }

  if (!state) {
    return (
      <div style={{ minHeight: "100vh", background: "#080c10", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'IBM Plex Mono', monospace", color: "#ff3366" }}>
        ⚠ Could not reach server. Check your API_URL.
      </div>
    );
  }

  const { cash = INITIAL_CASH, holdings = {}, prices = {}, trades = [], log = [], total_value = INITIAL_CASH, peak_value = INITIAL_CASH, last_cycle } = state;
  const pnl = total_value - INITIAL_CASH;
  const pnlPct = (pnl / INITIAL_CASH) * 100;
  const isUp = pnl >= 0;
  const progressToGoal = Math.min((total_value / 1000) * 100, 100);

  const accentGreen = "#00ff88";
  const accentRed = "#ff3366";
  const accentBlue = "#00aaff";
  const bg = "#080c10";
  const surface = "#0e1419";
  const border = "#1a2530";

  return (
    <div style={{ minHeight: "100vh", background: bg, color: "#e0e8f0", fontFamily: "'IBM Plex Mono', 'Courier New', monospace" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;500;600;700&display=swap');
        @keyframes pulse { 0%,100%{box-shadow:0 0 0 0 rgba(0,255,136,0.4)} 50%{box-shadow:0 0 0 8px rgba(0,255,136,0)} }
        @keyframes slideIn { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }
        .trade-row { animation: slideIn 0.3s ease; }
        .btn { cursor:pointer; border:none; font-family:inherit; font-size:13px; font-weight:600; letter-spacing:1px; padding:10px 24px; border-radius:2px; transition:all 0.15s; }
        .btn-refresh { background:${accentBlue}; color:#000; }
        .btn-refresh:hover { background:#33bbff; }
        .btn-reset { background:transparent; color:#556; border:1px solid #1a2530; }
        .btn-reset:hover { border-color:#334; color:#99a; }
        .tab { cursor:pointer; padding:8px 16px; font-size:11px; letter-spacing:1px; border-bottom:2px solid transparent; color:#556; transition:all 0.15s; }
        .tab.active { color:${accentBlue}; border-color:${accentBlue}; }
        ::-webkit-scrollbar{width:4px} ::-webkit-scrollbar-track{background:#0e1419} ::-webkit-scrollbar-thumb{background:#1a2530}
      `}</style>

      {/* Header */}
      <div style={{ background: surface, borderBottom: `1px solid ${border}`, padding: "16px 24px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: accentGreen, letterSpacing: 2 }}>APEX//TRADER</div>
          <div style={{ fontSize: 10, color: "#334", letterSpacing: 2 }}>24/7 AI TRADING BOT</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <PulsingDot color={accentGreen} />
          <span style={{ fontSize: 11, color: accentGreen, letterSpacing: 1 }}>LIVE</span>
          <span style={{ fontSize: 10, color: "#334", marginLeft: 8 }}>refreshed {lastRefresh}</span>
        </div>
      </div>

      {/* Stats */}
      <div style={{ padding: "20px 24px", display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12, maxWidth: 1100, margin: "0 auto" }}>
        {[
          { label: "PORTFOLIO VALUE", value: formatUSD(total_value), sub: formatPct(pnlPct), color: isUp ? accentGreen : accentRed },
          { label: "CASH", value: formatUSD(cash), sub: `${((cash / total_value) * 100).toFixed(0)}% liquid`, color: accentBlue },
          { label: "TOTAL P&L", value: formatUSD(pnl), sub: `peak ${formatUSD(peak_value)}`, color: isUp ? accentGreen : accentRed },
          { label: "TRADES", value: trades.length, sub: `last cycle: ${last_cycle ? new Date(last_cycle).toLocaleTimeString() : "—"}`, color: "#aab" },
        ].map((card) => (
          <div key={card.label} style={{ background: surface, border: `1px solid ${border}`, padding: "16px", borderRadius: 2 }}>
            <div style={{ fontSize: 9, color: "#445", letterSpacing: 2, marginBottom: 8 }}>{card.label}</div>
            <div style={{ fontSize: 24, fontWeight: 700, color: card.color }}>{card.value}</div>
            <div style={{ fontSize: 11, color: "#556", marginTop: 4 }}>{card.sub}</div>
          </div>
        ))}
      </div>

      {/* Goal bar */}
      <div style={{ padding: "0 24px 20px", maxWidth: 1100, margin: "0 auto" }}>
        <div style={{ background: surface, border: `1px solid ${border}`, padding: 16, borderRadius: 2 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
            <span style={{ fontSize: 10, color: "#445", letterSpacing: 2 }}>MISSION: $100 → $1000</span>
            <span style={{ fontSize: 11, color: accentGreen }}>{progressToGoal.toFixed(1)}% TO GOAL</span>
          </div>
          <div style={{ background: "#0a0f14", height: 6, borderRadius: 1, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${progressToGoal}%`, background: `linear-gradient(90deg, ${accentBlue}, ${accentGreen})`, transition: "width 0.5s ease", boxShadow: `0 0 10px ${accentGreen}44` }} />
          </div>
        </div>
      </div>

      {/* Controls */}
      <div style={{ padding: "0 24px 20px", maxWidth: 1100, margin: "0 auto", display: "flex", gap: 10 }}>
        <button className="btn btn-refresh" onClick={fetchState}>↻ REFRESH</button>
        <button className="btn btn-reset" onClick={handleReset}>↺ RESET TO $100</button>
        <span style={{ fontSize: 11, color: "#445", alignSelf: "center", marginLeft: 8 }}>Bot runs every 5 min on server — always on</span>
      </div>

      {/* Tabs */}
      <div style={{ padding: "0 24px", maxWidth: 1100, margin: "0 auto", borderBottom: `1px solid ${border}`, display: "flex" }}>
        {["live", "portfolio", "history"].map(tab => (
          <div key={tab} className={`tab ${activeTab === tab ? "active" : ""}`} onClick={() => setActiveTab(tab)}>
            {tab.toUpperCase()}
          </div>
        ))}
      </div>

      {/* Content */}
      <div style={{ padding: "20px 24px", maxWidth: 1100, margin: "0 auto" }}>
        {activeTab === "live" && (
          <div style={{ background: surface, border: `1px solid ${border}`, borderRadius: 2, padding: 16, minHeight: 300, maxHeight: 420, overflowY: "auto" }}>
            {log.length === 0
              ? <div style={{ color: "#334", fontSize: 12, textAlign: "center", marginTop: 80 }}>Waiting for first trading cycle...</div>
              : [...log].reverse().map((entry, i) => (
                <div key={i} className="trade-row" style={{ display: "flex", gap: 12, padding: "6px 0", borderBottom: "1px solid #0a0f14", fontSize: 12 }}>
                  <span style={{ color: "#334", minWidth: 70, flexShrink: 0, fontSize: 10 }}>{new Date(entry.time).toLocaleTimeString()}</span>
                  <span style={{ color: entry.type === "buy" ? accentGreen : entry.type === "sell" ? accentRed : accentBlue, minWidth: 60, flexShrink: 0, fontSize: 10, fontWeight: 600, letterSpacing: 1 }}>
                    {entry.type === "buy" ? "◆ BUY" : entry.type === "sell" ? "◇ SELL" : "● INFO"}
                  </span>
                  <span style={{ color: "#aab", lineHeight: 1.5 }}>{entry.message}</span>
                </div>
              ))
            }
            <div ref={logEndRef} />
          </div>
        )}

        {activeTab === "portfolio" && (
          <div>
            {Object.keys(holdings).length === 0
              ? <div style={{ color: "#334", fontSize: 12, textAlign: "center", marginTop: 80 }}>No open positions</div>
              : Object.entries(holdings).map(([sym, { shares, avgCost }]) => {
                const price = prices[sym] || avgCost;
                const value = shares * price;
                const pnlPos = (price - avgCost) * shares;
                const pnlPctPos = ((price - avgCost) / avgCost) * 100;
                return (
                  <div key={sym} style={{ background: surface, border: `1px solid ${border}`, borderRadius: 2, padding: 16, marginBottom: 8, display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12 }}>
                    <div>
                      <div style={{ fontSize: 16, fontWeight: 700 }}>{sym}</div>
                      <div style={{ fontSize: 10, color: "#445", marginTop: 4 }}>{Number(shares).toFixed(4)} shares</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 10, color: "#445", letterSpacing: 1 }}>CURRENT</div>
                      <div style={{ fontSize: 14, color: "#aab" }}>{formatUSD(price)}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 10, color: "#445", letterSpacing: 1 }}>VALUE</div>
                      <div style={{ fontSize: 14, color: accentBlue }}>{formatUSD(value)}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 10, color: "#445", letterSpacing: 1 }}>P&L</div>
                      <div style={{ fontSize: 14, color: pnlPos >= 0 ? accentGreen : accentRed }}>
                        {formatUSD(pnlPos)} ({formatPct(pnlPctPos)})
                      </div>
                    </div>
                  </div>
                );
              })
            }
            <div style={{ background: surface, border: `1px solid ${border}`, borderRadius: 2, padding: 12, marginTop: 8, display: "flex", justifyContent: "space-between" }}>
              <span style={{ fontSize: 11, color: "#445" }}>CASH RESERVE</span>
              <span style={{ fontSize: 14, color: accentBlue, fontWeight: 600 }}>{formatUSD(cash)}</span>
            </div>
          </div>
        )}

        {activeTab === "history" && (
          <div style={{ background: surface, border: `1px solid ${border}`, borderRadius: 2, overflow: "hidden" }}>
            <div style={{ display: "grid", gridTemplateColumns: "100px 80px 1fr 100px 100px", padding: "10px 16px", borderBottom: `1px solid ${border}`, fontSize: 9, color: "#445", letterSpacing: 1 }}>
              <span>TIME</span><span>ACTION</span><span>SYMBOL</span><span>SHARES</span><span>PRICE</span>
            </div>
            {trades.length === 0
              ? <div style={{ color: "#334", fontSize: 12, textAlign: "center", padding: 60 }}>No trades yet</div>
              : [...trades].reverse().map((t, i) => (
                <div key={i} style={{ display: "grid", gridTemplateColumns: "100px 80px 1fr 100px 100px", padding: "10px 16px", borderBottom: "1px solid #0a0f14", fontSize: 12 }}>
                  <span style={{ color: "#334", fontSize: 10 }}>{new Date(t.time).toLocaleTimeString()}</span>
                  <span style={{ color: t.action === "BUY" ? accentGreen : accentRed, fontWeight: 600, fontSize: 11 }}>{t.action}</span>
                  <span style={{ color: "#aab" }}>{t.symbol}</span>
                  <span style={{ color: "#778" }}>{Number(t.shares).toFixed(4)}</span>
                  <span style={{ color: "#aab" }}>{formatUSD(t.price)}</span>
                </div>
              ))
            }
          </div>
        )}
      </div>

      <div style={{ textAlign: "center", padding: 20, fontSize: 9, color: "#223", letterSpacing: 1 }}>
        PAPER TRADING ONLY — NOT REAL MONEY — FOR EDUCATIONAL USE
      </div>
    </div>
  );
}
