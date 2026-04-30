/* =========================================================================
   THE MORNING TAPE — LAB MODULE (v2)
   Sub-tabs: Backtest | Sentiment | Risk & MC | Comparison
   Depends on window.MT (set by index.html) for API keys.
   ========================================================================= */
(function () {
  'use strict';

  // -------------------- ASSET UNIVERSE (20 selectable) --------------------
  const ASSETS = {
    'SPY':   { kind: 'equity', stooq: 'spy.us',   label: 'S&P 500 ETF' },
    'QQQ':   { kind: 'equity', stooq: 'qqq.us',   label: 'Nasdaq 100 ETF' },
    'NVDA':  { kind: 'equity', stooq: 'nvda.us',  label: 'NVIDIA' },
    'AAPL':  { kind: 'equity', stooq: 'aapl.us',  label: 'Apple' },
    'MSFT':  { kind: 'equity', stooq: 'msft.us',  label: 'Microsoft' },
    'META':  { kind: 'equity', stooq: 'meta.us',  label: 'Meta' },
    'AMZN':  { kind: 'equity', stooq: 'amzn.us',  label: 'Amazon' },
    'GOOGL': { kind: 'equity', stooq: 'googl.us', label: 'Alphabet' },
    'TSLA':  { kind: 'equity', stooq: 'tsla.us',  label: 'Tesla' },
    'SMH':   { kind: 'equity', stooq: 'smh.us',   label: 'Semiconductor ETF' },
    'MSTR':  { kind: 'equity', stooq: 'mstr.us',  label: 'MicroStrategy' },
    'COIN':  { kind: 'equity', stooq: 'coin.us',  label: 'Coinbase' },
    'JEPQ':  { kind: 'equity', stooq: 'jepq.us',  label: 'JPM Nasdaq Premium' },
    'SCHD':  { kind: 'equity', stooq: 'schd.us',  label: 'Schwab Dividend' },
    'GLD':   { kind: 'equity', stooq: 'gld.us',   label: 'Gold ETF' },
    'TLT':   { kind: 'equity', stooq: 'tlt.us',   label: '20Y Treasury ETF' },
    'BTC':   { kind: 'crypto', cc: 'BTC',  label: 'Bitcoin' },
    'ETH':   { kind: 'crypto', cc: 'ETH',  label: 'Ethereum' },
    'SOL':   { kind: 'crypto', cc: 'SOL',  label: 'Solana' },
    'LINK':  { kind: 'crypto', cc: 'LINK', label: 'Chainlink' },
  };

  const LOOKBACK_DAYS = { '1Y': 365, '2Y': 730, '3Y': 1095, '5Y': 1825 };

  // -------------------- CACHE --------------------
  const cache = new Map();
  const TTL = 1000 * 60 * 60 * 4;
  const cacheGet = k => {
    const h = cache.get(k);
    if (!h) return null;
    if (Date.now() - h.ts > TTL) { cache.delete(k); return null; }
    return h.data;
  };
  const cacheSet = (k, d) => cache.set(k, { ts: Date.now(), data: d });

  // -------------------- DATA FETCH --------------------
  async function fetchEquity(symbol, days) {
    const key = `eq-${symbol}-${days}`;
    const hit = cacheGet(key); if (hit) return hit;

    // Strategy: try Yahoo Finance first (most reliable, longest history) via CORS proxies,
    // then fall back to Stooq via the same proxy chain.
    const period2 = Math.floor(Date.now() / 1000);
    const period1 = period2 - days * 86400;
    const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?period1=${period1}&period2=${period2}&interval=1d`;
    const stooqUrl = `https://stooq.com/q/d/l/?s=${ASSETS[symbol].stooq}&i=d`;

    const proxies = [
      u => u, // direct
      u => `https://corsproxy.io/?${encodeURIComponent(u)}`,
      u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
      u => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`,
    ];

    // Try Yahoo via each proxy
    for (const wrap of proxies) {
      try {
        const r = await fetch(wrap(yahooUrl));
        if (!r.ok) continue;
        const j = await r.json();
        const result = j?.chart?.result?.[0];
        if (!result) continue;
        const timestamps = result.timestamp;
        const closes = result.indicators?.quote?.[0]?.close;
        if (!timestamps || !closes || timestamps.length < 10) continue;
        // Filter out null closes (Yahoo sometimes returns nulls for halt days)
        const dates = [], cleanCloses = [];
        for (let i = 0; i < timestamps.length; i++) {
          if (closes[i] != null) {
            dates.push(new Date(timestamps[i] * 1000).toISOString().slice(0, 10));
            cleanCloses.push(closes[i]);
          }
        }
        if (cleanCloses.length < 10) continue;
        const data = { dates, closes: cleanCloses };
        cacheSet(key, data); return data;
      } catch (e) { /* try next proxy */ }
    }

    // Fall back to Stooq via each proxy
    for (const wrap of proxies) {
      try {
        const r = await fetch(wrap(stooqUrl));
        if (!r.ok) continue;
        const csv = await r.text();
        if (!csv || csv.length < 100 || !csv.toLowerCase().includes('date')) continue;
        const lines = csv.trim().split('\n');
        if (lines.length < 2) continue;
        const head = lines[0].toLowerCase().split(',');
        const di = head.indexOf('date'), ci = head.indexOf('close');
        if (di < 0 || ci < 0) continue;
        const rows = lines.slice(1).map(l => l.split(','))
          .filter(c => c[ci] && !isNaN(+c[ci]));
        rows.sort((a, b) => a[di].localeCompare(b[di]));
        const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
        const f = rows.filter(r => r[di] >= cutoff);
        if (f.length < 10) continue;
        const data = { dates: f.map(r => r[di]), closes: f.map(r => +r[ci]) };
        cacheSet(key, data); return data;
      } catch (e) { /* try next proxy */ }
    }

    throw new Error(`All equity sources failed for ${symbol}`);
  }

  async function fetchCrypto(symbol, days) {
    const key = `cr-${symbol}-${days}`;
    const hit = cacheGet(key); if (hit) return hit;
    const ccKey = window.MT?.keys?.cryptoCompare;
    if (ccKey) {
      const limit = Math.min(days, 2000);
      const url = `https://min-api.cryptocompare.com/data/v2/histoday?fsym=${ASSETS[symbol].cc}&tsym=USD&limit=${limit}&api_key=${ccKey}`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`CC failed ${symbol}`);
      const j = await r.json();
      if (!j.Data?.Data) throw new Error(`Bad CC ${symbol}`);
      const rows = j.Data.Data.filter(d => d.close > 0);
      const data = {
        dates: rows.map(d => new Date(d.time * 1000).toISOString().slice(0, 10)),
        closes: rows.map(d => d.close),
      };
      cacheSet(key, data); return data;
    }
    const cgIds = { BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', LINK: 'chainlink' };
    const cgDays = Math.min(days, 365);
    const url = `https://api.coingecko.com/api/v3/coins/${cgIds[ASSETS[symbol].cc]}/market_chart?vs_currency=usd&days=${cgDays}&interval=daily`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`CG failed ${symbol}`);
    const j = await r.json();
    const data = {
      dates: j.prices.map(p => new Date(p[0]).toISOString().slice(0, 10)),
      closes: j.prices.map(p => p[1]),
    };
    cacheSet(key, data); return data;
  }

  const fetchHistory = (sym, days) =>
    ASSETS[sym].kind === 'crypto' ? fetchCrypto(sym, days) : fetchEquity(sym, days);

  // -------------------- ALIGNMENT --------------------
  // Aligns multiple series to common date set (intersection)
  function alignSeries(seriesMap) {
    const symbols = Object.keys(seriesMap);
    if (symbols.length === 0) return { dates: [], data: {} };
    const dateSets = symbols.map(s => new Set(seriesMap[s].dates));
    const common = seriesMap[symbols[0]].dates.filter(d => dateSets.every(set => set.has(d)));
    const out = { dates: common, data: {} };
    for (const s of symbols) {
      const lookup = {};
      seriesMap[s].dates.forEach((d, i) => lookup[d] = seriesMap[s].closes[i]);
      out.data[s] = common.map(d => lookup[d]);
    }
    return out;
  }

  // -------------------- MATH HELPERS --------------------
  const pctReturns = closes => {
    const r = [];
    for (let i = 1; i < closes.length; i++) r.push(closes[i] / closes[i-1] - 1);
    return r;
  };
  const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
  const stdev = a => {
    const m = mean(a);
    return Math.sqrt(a.reduce((s, v) => s + (v-m)**2, 0) / (a.length - 1));
  };
  const correlation = (a, b) => {
    const ma = mean(a), mb = mean(b);
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < a.length; i++) {
      num += (a[i]-ma) * (b[i]-mb);
      da += (a[i]-ma)**2;
      db += (b[i]-mb)**2;
    }
    return num / Math.sqrt(da * db);
  };
  const fmt$ = v => '$' + v.toLocaleString(undefined, { maximumFractionDigits: 0 });
  const fmtPct = v => (v >= 0 ? '+' : '') + (v * 100).toFixed(2) + '%';

  // -------------------- UI SHELL --------------------
  function renderShell(root) {
    root.innerHTML = `
      <div class="lab-wrap">
        <div class="lab-subtabs">
          <button class="lab-subtab active" data-sub="backtest">Backtest</button>
          <button class="lab-subtab" data-sub="sentiment">Sentiment</button>
          <button class="lab-subtab" data-sub="risk">Risk &amp; MC</button>
          <button class="lab-subtab" data-sub="compare">Comparison</button>
        </div>
        <div id="lab-panel-backtest" class="lab-panel active"></div>
        <div id="lab-panel-sentiment" class="lab-panel"></div>
        <div id="lab-panel-risk" class="lab-panel"></div>
        <div id="lab-panel-compare" class="lab-panel"></div>
      </div>
    `;
    root.querySelectorAll('.lab-subtab').forEach(btn => {
      btn.addEventListener('click', () => {
        root.querySelectorAll('.lab-subtab').forEach(b => b.classList.remove('active'));
        root.querySelectorAll('.lab-panel').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        const sub = btn.dataset.sub;
        document.getElementById(`lab-panel-${sub}`).classList.add('active');
        if (sub === 'backtest') initBacktest();
        if (sub === 'sentiment') initSentiment();
        if (sub === 'risk') initRisk();
        if (sub === 'compare') initCompare();
      });
    });
    initBacktest(); // default
  }

  // -------------------- ASSET PICKER --------------------
  function buildAssetPicker(selected) {
    const eqList = Object.keys(ASSETS).filter(s => ASSETS[s].kind === 'equity');
    const crList = Object.keys(ASSETS).filter(s => ASSETS[s].kind === 'crypto');
    const chip = s => `<label class="asset-chip ${selected.includes(s) ? 'on' : ''}">
      <input type="checkbox" value="${s}" ${selected.includes(s) ? 'checked' : ''}>
      <span>${s}</span></label>`;
    return `
      <div class="asset-picker">
        <div class="ap-group"><div class="ap-label">Equities</div><div class="ap-chips">${eqList.map(chip).join('')}</div></div>
        <div class="ap-group"><div class="ap-label">Crypto</div><div class="ap-chips">${crList.map(chip).join('')}</div></div>
      </div>
    `;
  }
  function bindPicker(panel) {
    panel.querySelectorAll('.asset-chip input').forEach(cb => {
      cb.addEventListener('change', () => {
        cb.parentElement.classList.toggle('on', cb.checked);
      });
    });
  }
  const getPicked = panel => Array.from(panel.querySelectorAll('.asset-chip input:checked')).map(c => c.value);

  // ============================================================
  //  TAB 1: BACKTEST
  // ============================================================
  let backtestInited = false;
  function initBacktest() {
    if (backtestInited) return;
    backtestInited = true;
    const panel = document.getElementById('lab-panel-backtest');
    panel.innerHTML = `
      <div class="lab-controls">
        <div class="ctrl-row">
          <div class="ctrl"><label>Mode</label>
            <select id="bt-mode">
              <option value="lump">Lump Sum</option>
              <option value="dca">Dollar-Cost Average</option>
            </select>
          </div>
          <div class="ctrl"><label>Lookback</label>
            <select id="bt-lookback">
              <option value="1Y">1 Year</option>
              <option value="2Y">2 Years</option>
              <option value="3Y">3 Years</option>
              <option value="5Y" selected>5 Years</option>
            </select>
          </div>
          <div class="ctrl"><label id="bt-amt-lbl">Lump Sum ($)</label>
            <input type="number" id="bt-amount" value="10000" min="100" step="100">
          </div>
          <div class="ctrl ctrl-dca" style="display:none"><label>DCA Frequency</label>
            <select id="bt-freq">
              <option value="weekly">Weekly</option>
              <option value="biweekly">Bi-weekly</option>
              <option value="monthly" selected>Monthly</option>
            </select>
          </div>
          <button class="run-btn" id="bt-run">Run Backtest</button>
        </div>
        ${buildAssetPicker(['SPY','QQQ','BTC','ETH'])}
      </div>
      <div id="bt-results"></div>
    `;
    bindPicker(panel);
    panel.querySelector('#bt-mode').addEventListener('change', e => {
      const isDca = e.target.value === 'dca';
      panel.querySelector('.ctrl-dca').style.display = isDca ? '' : 'none';
      panel.querySelector('#bt-amt-lbl').textContent = isDca ? 'Per Period ($)' : 'Lump Sum ($)';
      panel.querySelector('#bt-amount').value = isDca ? 500 : 10000;
    });
    panel.querySelector('#bt-run').addEventListener('click', runBacktest);
  }

  async function runBacktest() {
    const panel = document.getElementById('lab-panel-backtest');
    const out = panel.querySelector('#bt-results');
    const picked = getPicked(panel);
    if (picked.length === 0) { out.innerHTML = '<div class="lab-msg">Select at least one asset.</div>'; return; }
    if (picked.length > 8) { out.innerHTML = '<div class="lab-msg">Limit 8 assets per run.</div>'; return; }

    const mode = panel.querySelector('#bt-mode').value;
    const lookback = panel.querySelector('#bt-lookback').value;
    const days = LOOKBACK_DAYS[lookback];
    const amount = +panel.querySelector('#bt-amount').value;
    const freq = panel.querySelector('#bt-freq').value;

    out.innerHTML = '<div class="lab-msg">Loading data…</div>';
    let series;
    try {
      const fetched = {};
      await Promise.all(picked.map(async s => { fetched[s] = await fetchHistory(s, days); }));
      series = alignSeries(fetched);
    } catch (e) {
      out.innerHTML = `<div class="lab-msg err">Data error: ${e.message}</div>`;
      return;
    }
    if (series.dates.length < 30) {
      out.innerHTML = '<div class="lab-msg err">Insufficient overlapping data.</div>';
      return;
    }

    // Run the simulation per asset
    const results = picked.map(sym => {
      const closes = series.data[sym];
      const startPrice = closes[0];
      const endPrice = closes[closes.length - 1];
      let invested = 0, shares = 0;
      const equity = [];
      if (mode === 'lump') {
        invested = amount;
        shares = amount / startPrice;
        for (let i = 0; i < closes.length; i++) equity.push(shares * closes[i]);
      } else {
        const stride = freq === 'weekly' ? 5 : freq === 'biweekly' ? 10 : 21;
        for (let i = 0; i < closes.length; i++) {
          if (i % stride === 0) { shares += amount / closes[i]; invested += amount; }
          equity.push(shares * closes[i]);
        }
      }
      const finalVal = equity[equity.length - 1];
      const totalRet = (finalVal - invested) / invested;
      const yrs = series.dates.length / 252;
      const cagr = mode === 'lump'
        ? Math.pow(finalVal / invested, 1 / yrs) - 1
        : null;
      // Max drawdown
      let peak = equity[0], maxDD = 0;
      for (const v of equity) { if (v > peak) peak = v; const dd = (v - peak) / peak; if (dd < maxDD) maxDD = dd; }
      // Volatility
      const rets = pctReturns(closes);
      const vol = stdev(rets) * Math.sqrt(252);
      return { sym, invested, finalVal, totalRet, cagr, maxDD, vol, equity };
    });

    renderBacktestResults(out, results, series.dates, mode);
  }

  function renderBacktestResults(out, results, dates, mode) {
    const rows = results.map(r => `
      <tr>
        <td class="sym">${r.sym}</td>
        <td>${fmt$(r.invested)}</td>
        <td>${fmt$(r.finalVal)}</td>
        <td class="${r.totalRet>=0?'pos':'neg'}">${fmtPct(r.totalRet)}</td>
        <td>${r.cagr !== null ? fmtPct(r.cagr) : '—'}</td>
        <td class="neg">${fmtPct(r.maxDD)}</td>
        <td>${(r.vol*100).toFixed(1)}%</td>
      </tr>`).join('');
    out.innerHTML = `
      <div class="lab-card">
        <div class="lab-card-title">Results</div>
        <table class="lab-table">
          <thead><tr><th>Asset</th><th>Invested</th><th>Final</th><th>Total Return</th><th>CAGR</th><th>Max DD</th><th>Vol (ann)</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <div class="lab-note">${mode === 'dca' ? 'DCA: equal contributions at each interval. CAGR omitted (ambiguous for varying cost basis).' : 'Lump sum: full amount deployed day one.'}</div>
      </div>
      <div class="lab-card">
        <div class="lab-card-title">Equity Curves</div>
        <canvas id="bt-chart" height="320"></canvas>
      </div>
    `;
    drawEquityCurves(out.querySelector('#bt-chart'), results, dates);
    // Stash for potential MC reuse
    window.MT_LAB_LASTRUN = { results, dates };
  }

  function drawEquityCurves(canvas, results, dates) {
    const ctx = canvas.getContext('2d');
    const W = canvas.width = canvas.clientWidth;
    const H = canvas.height = 320;
    const pad = { l: 60, r: 80, t: 20, b: 40 };
    const plotW = W - pad.l - pad.r, plotH = H - pad.t - pad.b;
    const allVals = results.flatMap(r => r.equity);
    const minV = Math.min(...allVals), maxV = Math.max(...allVals);
    const colors = ['#d4a017','#7fa3c7','#c97a7a','#8aa17f','#b58fc7','#d49a59','#6db3a6','#9c8b6b'];
    ctx.clearRect(0,0,W,H);
    // Axes
    ctx.strokeStyle = '#3a342a'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad.l, pad.t); ctx.lineTo(pad.l, H-pad.b); ctx.lineTo(W-pad.r, H-pad.b); ctx.stroke();
    // Y labels
    ctx.fillStyle = '#a89878'; ctx.font = '11px JetBrains Mono, monospace'; ctx.textAlign = 'right';
    for (let i = 0; i <= 4; i++) {
      const v = minV + (maxV - minV) * (i/4);
      const y = H - pad.b - (i/4) * plotH;
      ctx.fillText(fmt$(v), pad.l - 6, y + 4);
      ctx.strokeStyle = '#2a2620'; ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W-pad.r, y); ctx.stroke();
    }
    // X labels
    ctx.textAlign = 'center';
    [0, 0.25, 0.5, 0.75, 1].forEach(t => {
      const i = Math.floor(t * (dates.length - 1));
      const x = pad.l + t * plotW;
      ctx.fillText(dates[i].slice(0,7), x, H - pad.b + 18);
    });
    // Lines
    results.forEach((r, idx) => {
      ctx.strokeStyle = colors[idx % colors.length];
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      r.equity.forEach((v, i) => {
        const x = pad.l + (i / (r.equity.length - 1)) * plotW;
        const y = H - pad.b - ((v - minV) / (maxV - minV)) * plotH;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.stroke();
      // Legend
      const ly = pad.t + idx * 18;
      ctx.fillStyle = colors[idx % colors.length];
      ctx.fillRect(W - pad.r + 8, ly, 12, 3);
      ctx.fillStyle = '#d4c5a0'; ctx.textAlign = 'left';
      ctx.fillText(r.sym, W - pad.r + 24, ly + 5);
    });
  }

  // ============================================================
  //  TAB 2: SENTIMENT
  // ============================================================
  let sentimentInited = false;
  async function initSentiment() {
    if (sentimentInited) return;
    sentimentInited = true;
    const panel = document.getElementById('lab-panel-sentiment');
    panel.innerHTML = `
      <div class="lab-card"><div class="lab-card-title">Crypto Fear &amp; Greed Index</div>
        <div id="fg-current" class="fg-display">Loading…</div>
        <canvas id="fg-chart" height="200"></canvas>
      </div>
      <div class="lab-card"><div class="lab-card-title">BTC Dominance (90d)</div>
        <div id="dom-current" class="fg-display">Loading…</div>
        <canvas id="dom-chart" height="200"></canvas>
      </div>
    `;
    loadFearGreed();
    loadBtcDominance();
  }

  async function loadFearGreed() {
    try {
      const r = await fetch('https://api.alternative.me/fng/?limit=90');
      const j = await r.json();
      const data = j.data.reverse(); // oldest first
      const cur = data[data.length - 1];
      const valEl = document.getElementById('fg-current');
      valEl.innerHTML = `<div class="big-num">${cur.value}</div><div class="big-label">${cur.value_classification}</div>`;
      valEl.className = 'fg-display ' + fgClass(+cur.value);
      drawSentimentChart(document.getElementById('fg-chart'),
        data.map(d => new Date(+d.timestamp*1000).toISOString().slice(0,10)),
        data.map(d => +d.value), 0, 100, true);
    } catch (e) {
      document.getElementById('fg-current').textContent = 'Failed to load Fear & Greed.';
    }
  }
  function fgClass(v) {
    if (v < 25) return 'fear';
    if (v < 45) return 'mild-fear';
    if (v < 55) return 'neutral';
    if (v < 75) return 'mild-greed';
    return 'greed';
  }

  async function loadBtcDominance() {
    try {
      // CoinGecko global doesn't give history; approximate via BTC mcap / total mcap from histo BTC and ETH+top coins is heavy.
      // Cleaner: use CoinGecko global current + CryptoCompare for BTC mcap history vs total — also incomplete.
      // Pragmatic: pull current global dominance, plus 90d BTC mcap from CC and 90d total from CC top-10 sum.
      const ccKey = window.MT?.keys?.cryptoCompare;
      const top = ['BTC','ETH','USDT','BNB','SOL','XRP','USDC','ADA','DOGE','TRX'];
      const dailyTotals = new Array(91).fill(0);
      const btcSeries = new Array(91).fill(0);
      let dates = [];
      for (const sym of top) {
        const url = `https://min-api.cryptocompare.com/data/v2/histoday?fsym=${sym}&tsym=USD&limit=90${ccKey ? '&api_key='+ccKey : ''}`;
        const r = await fetch(url);
        const j = await r.json();
        if (!j.Data?.Data) continue;
        const rows = j.Data.Data;
        if (dates.length === 0) dates = rows.map(d => new Date(d.time*1000).toISOString().slice(0,10));
        // Approximate mcap with close * circulating supply — CC doesn't give supply per day cheaply.
        // Fallback: weight by current mcap from CoinGecko, scale historic prices.
      }
      // Simpler reliable path: just plot BTC price ratio vs (BTC+ETH) over 90d as a *proxy* for dominance trend.
      const btcUrl = `https://min-api.cryptocompare.com/data/v2/histoday?fsym=BTC&tsym=USD&limit=90${ccKey ? '&api_key='+ccKey : ''}`;
      const ethUrl = `https://min-api.cryptocompare.com/data/v2/histoday?fsym=ETH&tsym=USD&limit=90${ccKey ? '&api_key='+ccKey : ''}`;
      const [bR, eR] = await Promise.all([fetch(btcUrl).then(r=>r.json()), fetch(ethUrl).then(r=>r.json())]);
      const bRows = bR.Data.Data, eRows = eR.Data.Data;
      // Get current global dominance for absolute calibration
      const gR = await fetch('https://api.coingecko.com/api/v3/global');
      const gJ = await gR.json();
      const curDom = gJ.data.market_cap_percentage.btc;
      // Compute BTC/(BTC+ETH) ratio history, then linearly scale so the latest value equals curDom * (some factor).
      const ratio = bRows.map((b, i) => {
        const bp = b.close, ep = eRows[i]?.close || 1;
        return bp / (bp + ep * 12); // 12x rough mcap weighting (BTC supply ~19.8M, ETH ~120M => ~6x; adjust for price ratio)
      });
      // Scale so last value = curDom/100
      const scale = (curDom / 100) / ratio[ratio.length - 1];
      const scaled = ratio.map(v => v * scale * 100);
      const dts = bRows.map(d => new Date(d.time*1000).toISOString().slice(0,10));
      const cur = scaled[scaled.length - 1];
      document.getElementById('dom-current').innerHTML =
        `<div class="big-num">${cur.toFixed(1)}%</div><div class="big-label">BTC Market Dominance</div>
         <div class="lab-note">Approximation. Current value calibrated to CoinGecko global; history is BTC/(BTC+ETH) trend scaled.</div>`;
      drawSentimentChart(document.getElementById('dom-chart'), dts, scaled,
        Math.min(...scaled)-2, Math.max(...scaled)+2, false);
    } catch (e) {
      document.getElementById('dom-current').textContent = 'Failed to load dominance.';
    }
  }

  function drawSentimentChart(canvas, dates, values, ymin, ymax, banded) {
    const ctx = canvas.getContext('2d');
    const W = canvas.width = canvas.clientWidth;
    const H = canvas.height = 200;
    const pad = { l: 50, r: 20, t: 15, b: 30 };
    const pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;
    ctx.clearRect(0,0,W,H);
    if (banded) {
      const bands = [
        [0, 25, '#3a1f1f'], [25, 45, '#3a2f1f'], [45, 55, '#2a2a1f'],
        [55, 75, '#1f3a2a'], [75, 100, '#1f3a1f'],
      ];
      bands.forEach(([lo, hi, c]) => {
        const y1 = pad.t + ph * (1 - hi/100);
        const y2 = pad.t + ph * (1 - lo/100);
        ctx.fillStyle = c; ctx.fillRect(pad.l, y1, pw, y2 - y1);
      });
    }
    ctx.strokeStyle = '#3a342a';
    ctx.beginPath(); ctx.moveTo(pad.l, pad.t); ctx.lineTo(pad.l, H-pad.b); ctx.lineTo(W-pad.r, H-pad.b); ctx.stroke();
    ctx.fillStyle = '#a89878'; ctx.font = '11px JetBrains Mono'; ctx.textAlign = 'right';
    for (let i = 0; i <= 4; i++) {
      const v = ymin + (ymax-ymin)*(i/4);
      const y = H-pad.b - (i/4)*ph;
      ctx.fillText(v.toFixed(0), pad.l-6, y+4);
    }
    ctx.textAlign = 'center';
    [0, 0.5, 1].forEach(t => {
      const i = Math.floor(t * (dates.length-1));
      ctx.fillText(dates[i].slice(5), pad.l + t*pw, H-pad.b+16);
    });
    ctx.strokeStyle = '#d4a017'; ctx.lineWidth = 2;
    ctx.beginPath();
    values.forEach((v, i) => {
      const x = pad.l + (i/(values.length-1))*pw;
      const y = H-pad.b - ((v-ymin)/(ymax-ymin))*ph;
      i === 0 ? ctx.moveTo(x,y) : ctx.lineTo(x,y);
    });
    ctx.stroke();
  }

  // ============================================================
  //  TAB 3: RISK & MONTE CARLO
  // ============================================================
  let riskInited = false;
  function initRisk() {
    if (riskInited) return;
    riskInited = true;
    const panel = document.getElementById('lab-panel-risk');
    panel.innerHTML = `
      <div class="lab-controls">
        <div class="ctrl-row">
          <div class="ctrl"><label>Lookback Window</label>
            <input type="range" id="risk-window" min="30" max="365" step="15" value="90">
            <span id="risk-window-val" class="ctrl-val">90 days</span>
          </div>
          <div class="ctrl"><label>MC Simulations</label>
            <select id="mc-sims"><option value="500">500</option><option value="1000" selected>1000</option><option value="5000">5000</option></select>
          </div>
          <div class="ctrl"><label>MC Horizon (days)</label>
            <select id="mc-horizon"><option value="30">30</option><option value="90" selected>90</option><option value="180">180</option><option value="365">365</option></select>
          </div>
          <div class="ctrl"><label>Starting Value ($)</label>
            <input type="number" id="mc-start" value="10000" min="100" step="100">
          </div>
          <button class="run-btn" id="risk-run">Run Risk Analysis</button>
        </div>
        ${buildAssetPicker(['SPY','QQQ','BTC','ETH','NVDA'])}
      </div>
      <div id="risk-results"></div>
    `;
    bindPicker(panel);
    panel.querySelector('#risk-window').addEventListener('input', e => {
      panel.querySelector('#risk-window-val').textContent = e.target.value + ' days';
    });
    panel.querySelector('#risk-run').addEventListener('click', runRisk);
  }

  async function runRisk() {
    const panel = document.getElementById('lab-panel-risk');
    const out = panel.querySelector('#risk-results');
    const picked = getPicked(panel);
    if (picked.length < 2) { out.innerHTML = '<div class="lab-msg">Pick at least 2 assets.</div>'; return; }
    const window_ = +panel.querySelector('#risk-window').value;
    const sims = +panel.querySelector('#mc-sims').value;
    const horizon = +panel.querySelector('#mc-horizon').value;
    const startVal = +panel.querySelector('#mc-start').value;
    out.innerHTML = '<div class="lab-msg">Loading data…</div>';

    let aligned;
    try {
      const fetched = {};
      await Promise.all(picked.map(async s => { fetched[s] = await fetchHistory(s, window_); }));
      aligned = alignSeries(fetched);
    } catch (e) {
      out.innerHTML = `<div class="lab-msg err">Data error: ${e.message}</div>`;
      return;
    }
    if (aligned.dates.length < 20) {
      out.innerHTML = '<div class="lab-msg err">Insufficient data in window.</div>'; return;
    }

    // Correlation matrix
    const returns = {};
    picked.forEach(s => returns[s] = pctReturns(aligned.data[s]));
    const matrix = picked.map(a => picked.map(b => correlation(returns[a], returns[b])));

    // Equal-weight portfolio for MC
    const portRets = [];
    const n = returns[picked[0]].length;
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (const s of picked) r += returns[s][i];
      portRets.push(r / picked.length);
    }
    // Bootstrap MC
    const finals = [];
    const paths = [];
    for (let s = 0; s < sims; s++) {
      let v = startVal;
      const path = [v];
      for (let d = 0; d < horizon; d++) {
        const r = portRets[Math.floor(Math.random() * portRets.length)];
        v *= (1 + r);
        path.push(v);
      }
      finals.push(v);
      if (s < 100) paths.push(path); // sample paths to plot
    }
    finals.sort((a,b)=>a-b);
    const pct = p => finals[Math.floor(finals.length * p)];
    const stats = {
      mean: mean(finals), median: pct(0.5),
      p5: pct(0.05), p25: pct(0.25), p75: pct(0.75), p95: pct(0.95),
      lossProb: finals.filter(v => v < startVal).length / finals.length,
      double: finals.filter(v => v >= startVal*2).length / finals.length,
    };

    renderRisk(out, picked, matrix, stats, paths, startVal, horizon);
  }

  function renderRisk(out, syms, matrix, stats, paths, startVal, horizon) {
    out.innerHTML = `
      <div class="lab-card">
        <div class="lab-card-title">Correlation Matrix</div>
        <div id="corr-heatmap"></div>
      </div>
      <div class="lab-card">
        <div class="lab-card-title">Monte Carlo — Equal-Weight Portfolio</div>
        <div class="mc-stats">
          <div><span class="mc-lbl">Median</span><span class="mc-val">${fmt$(stats.median)}</span></div>
          <div><span class="mc-lbl">Mean</span><span class="mc-val">${fmt$(stats.mean)}</span></div>
          <div><span class="mc-lbl">5th %ile</span><span class="mc-val neg">${fmt$(stats.p5)}</span></div>
          <div><span class="mc-lbl">95th %ile</span><span class="mc-val pos">${fmt$(stats.p95)}</span></div>
          <div><span class="mc-lbl">P(loss)</span><span class="mc-val">${(stats.lossProb*100).toFixed(1)}%</span></div>
          <div><span class="mc-lbl">P(2x)</span><span class="mc-val">${(stats.double*100).toFixed(1)}%</span></div>
        </div>
        <canvas id="mc-chart" height="320"></canvas>
        <div class="lab-note">Bootstrap from observed daily returns over selected window. Equal-weight rebalanced implicitly. ${horizon}-day horizon, start ${fmt$(startVal)}.</div>
      </div>
    `;
    drawHeatmap(out.querySelector('#corr-heatmap'), syms, matrix);
    drawMCFan(out.querySelector('#mc-chart'), paths, startVal, horizon);
  }

  function drawHeatmap(host, syms, matrix) {
    const cell = 44;
    const W = cell * (syms.length + 1);
    const H = cell * (syms.length + 1);
    host.innerHTML = `<canvas width="${W}" height="${H}"></canvas>`;
    const ctx = host.querySelector('canvas').getContext('2d');
    ctx.font = '11px JetBrains Mono';
    for (let i = 0; i < syms.length; i++) {
      ctx.fillStyle = '#d4c5a0'; ctx.textAlign = 'center';
      ctx.fillText(syms[i], (i+1)*cell + cell/2, cell - 14);
      ctx.textAlign = 'right';
      ctx.fillText(syms[i], cell - 6, (i+1)*cell + cell/2 + 4);
    }
    for (let i = 0; i < syms.length; i++) {
      for (let j = 0; j < syms.length; j++) {
        const v = matrix[i][j];
        // Color: green (+) to red (-)
        const r = v < 0 ? Math.floor(60 + Math.abs(v)*180) : Math.floor(40 + (1-v)*30);
        const g = v > 0 ? Math.floor(60 + v*120) : Math.floor(40 + (1+v)*20);
        const b = 30;
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillRect((j+1)*cell + 1, (i+1)*cell + 1, cell - 2, cell - 2);
        ctx.fillStyle = '#f0e6c8';
        ctx.textAlign = 'center';
        ctx.fillText(v.toFixed(2), (j+1)*cell + cell/2, (i+1)*cell + cell/2 + 4);
      }
    }
  }

  function drawMCFan(canvas, paths, startVal, horizon) {
    const W = canvas.width = canvas.clientWidth;
    const H = canvas.height = 320;
    const pad = { l: 70, r: 20, t: 20, b: 35 };
    const pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0,0,W,H);
    const allVals = paths.flat();
    const minV = Math.min(...allVals), maxV = Math.max(...allVals);
    ctx.strokeStyle = '#3a342a';
    ctx.beginPath(); ctx.moveTo(pad.l, pad.t); ctx.lineTo(pad.l, H-pad.b); ctx.lineTo(W-pad.r, H-pad.b); ctx.stroke();
    ctx.fillStyle = '#a89878'; ctx.font = '11px JetBrains Mono'; ctx.textAlign = 'right';
    for (let i = 0; i <= 4; i++) {
      const v = minV + (maxV-minV)*(i/4);
      const y = H-pad.b - (i/4)*ph;
      ctx.fillText(fmt$(v), pad.l-6, y+4);
      ctx.strokeStyle = '#2a2620';
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W-pad.r, y); ctx.stroke();
    }
    ctx.textAlign = 'center';
    [0, 0.25, 0.5, 0.75, 1].forEach(t => {
      ctx.fillStyle = '#a89878';
      ctx.fillText(`Day ${Math.floor(t*horizon)}`, pad.l + t*pw, H-pad.b+16);
    });
    paths.forEach(path => {
      ctx.strokeStyle = 'rgba(212,160,23,0.08)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      path.forEach((v, i) => {
        const x = pad.l + (i/(path.length-1))*pw;
        const y = H-pad.b - ((v-minV)/(maxV-minV))*ph;
        i === 0 ? ctx.moveTo(x,y) : ctx.lineTo(x,y);
      });
      ctx.stroke();
    });
    // Start line
    const sy = H-pad.b - ((startVal-minV)/(maxV-minV))*ph;
    ctx.strokeStyle = '#c97a7a'; ctx.lineWidth = 1.5; ctx.setLineDash([4,4]);
    ctx.beginPath(); ctx.moveTo(pad.l, sy); ctx.lineTo(W-pad.r, sy); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#c97a7a'; ctx.textAlign = 'left';
    ctx.fillText('Start', W-pad.r-30, sy-4);
  }

  // ============================================================
  //  TAB 4: COMPARISON (normalized)
  // ============================================================
  let compareInited = false;
  function initCompare() {
    if (compareInited) return;
    compareInited = true;
    const panel = document.getElementById('lab-panel-compare');
    panel.innerHTML = `
      <div class="lab-controls">
        <div class="ctrl-row">
          <div class="ctrl"><label>Lookback</label>
            <select id="cmp-lookback">
              <option value="1Y">1 Year</option>
              <option value="2Y">2 Years</option>
              <option value="3Y">3 Years</option>
              <option value="5Y" selected>5 Years</option>
            </select>
          </div>
          <button class="run-btn" id="cmp-run">Compare</button>
        </div>
        ${buildAssetPicker(['SPY','QQQ','NVDA','BTC','ETH'])}
      </div>
      <div id="cmp-results"></div>
    `;
    bindPicker(panel);
    panel.querySelector('#cmp-run').addEventListener('click', runCompare);
  }

  async function runCompare() {
    const panel = document.getElementById('lab-panel-compare');
    const out = panel.querySelector('#cmp-results');
    const picked = getPicked(panel);
    if (picked.length === 0) { out.innerHTML = '<div class="lab-msg">Pick at least one asset.</div>'; return; }
    const days = LOOKBACK_DAYS[panel.querySelector('#cmp-lookback').value];
    out.innerHTML = '<div class="lab-msg">Loading…</div>';
    let aligned;
    try {
      const fetched = {};
      await Promise.all(picked.map(async s => { fetched[s] = await fetchHistory(s, days); }));
      aligned = alignSeries(fetched);
    } catch (e) {
      out.innerHTML = `<div class="lab-msg err">${e.message}</div>`; return;
    }
    // Normalize to 100
    const normalized = {};
    picked.forEach(s => {
      const c = aligned.data[s], base = c[0];
      normalized[s] = c.map(v => (v / base) * 100);
    });
    out.innerHTML = `
      <div class="lab-card">
        <div class="lab-card-title">Normalized Performance (Start = 100)</div>
        <canvas id="cmp-chart" height="380"></canvas>
        <div id="cmp-table"></div>
      </div>
    `;
    drawNormalized(out.querySelector('#cmp-chart'), aligned.dates, normalized);
    // Summary table
    const rows = picked.map(s => {
      const v = normalized[s];
      const ret = (v[v.length-1] - 100) / 100;
      const peak = Math.max(...v), trough = Math.min(...v);
      const dd = (Math.min(...v.map((x, i) => x / Math.max(...v.slice(0, i+1)) - 1)));
      return `<tr><td class="sym">${s}</td>
        <td class="${ret>=0?'pos':'neg'}">${fmtPct(ret)}</td>
        <td>${peak.toFixed(1)}</td><td>${trough.toFixed(1)}</td>
        <td class="neg">${fmtPct(dd)}</td></tr>`;
    }).join('');
    out.querySelector('#cmp-table').innerHTML = `
      <table class="lab-table" style="margin-top:16px">
        <thead><tr><th>Asset</th><th>Total Return</th><th>Peak</th><th>Trough</th><th>Max DD</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  function drawNormalized(canvas, dates, series) {
    const W = canvas.width = canvas.clientWidth;
    const H = canvas.height = 380;
    const pad = { l: 60, r: 80, t: 20, b: 40 };
    const pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0,0,W,H);
    const all = Object.values(series).flat();
    const minV = Math.min(...all), maxV = Math.max(...all);
    const colors = ['#d4a017','#7fa3c7','#c97a7a','#8aa17f','#b58fc7','#d49a59','#6db3a6','#9c8b6b'];
    ctx.strokeStyle = '#3a342a';
    ctx.beginPath(); ctx.moveTo(pad.l,pad.t); ctx.lineTo(pad.l,H-pad.b); ctx.lineTo(W-pad.r,H-pad.b); ctx.stroke();
    ctx.font = '11px JetBrains Mono'; ctx.fillStyle = '#a89878'; ctx.textAlign = 'right';
    for (let i = 0; i <= 5; i++) {
      const v = minV + (maxV-minV)*(i/5);
      const y = H-pad.b - (i/5)*ph;
      ctx.fillText(v.toFixed(0), pad.l-6, y+4);
      ctx.strokeStyle = '#2a2620';
      ctx.beginPath(); ctx.moveTo(pad.l,y); ctx.lineTo(W-pad.r,y); ctx.stroke();
    }
    // 100 baseline
    const baseY = H-pad.b - ((100-minV)/(maxV-minV))*ph;
    ctx.strokeStyle = '#5a4f3a'; ctx.setLineDash([3,3]);
    ctx.beginPath(); ctx.moveTo(pad.l,baseY); ctx.lineTo(W-pad.r,baseY); ctx.stroke();
    ctx.setLineDash([]);
    ctx.textAlign = 'center';
    [0, 0.25, 0.5, 0.75, 1].forEach(t => {
      const i = Math.floor(t*(dates.length-1));
      ctx.fillText(dates[i].slice(0,7), pad.l + t*pw, H-pad.b+18);
    });
    Object.keys(series).forEach((s, idx) => {
      ctx.strokeStyle = colors[idx % colors.length];
      ctx.lineWidth = 1.8; ctx.beginPath();
      series[s].forEach((v, i) => {
        const x = pad.l + (i/(series[s].length-1))*pw;
        const y = H-pad.b - ((v-minV)/(maxV-minV))*ph;
        i === 0 ? ctx.moveTo(x,y) : ctx.lineTo(x,y);
      });
      ctx.stroke();
      const ly = pad.t + idx*18;
      ctx.fillStyle = colors[idx % colors.length];
      ctx.fillRect(W-pad.r+8, ly, 12, 3);
      ctx.fillStyle = '#d4c5a0'; ctx.textAlign = 'left';
      ctx.fillText(s, W-pad.r+24, ly+5);
    });
  }

  // -------------------- PUBLIC API --------------------
  window.MT_LAB = {
    mount: function (rootEl) { renderShell(rootEl); }
  };
})();
