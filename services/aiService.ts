
import { AIDecision, MarketDataCollection, AccountContext, CandleData } from "../types";
import { CONTRACT_VAL_ETH, INSTRUMENT_ID, TAKER_FEE_RATE } from "../constants";

// --- Technical Indicator Helpers ---

const calcEMA = (prices: number[], period: number): number => {
  if (prices.length < period) return prices[prices.length - 1];
  const k = 2 / (period + 1);
  let ema = prices[0];
  for (let i = 1; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
};

// Calculate full array of EMA values
const calcEMAArray = (prices: number[], period: number): number[] => {
    if (prices.length === 0) return [];
    const k = 2 / (period + 1);
    let emaArray: number[] = [prices[0]];
    for (let i = 1; i < prices.length; i++) {
        // Standard EMA formula: Price(t) * k + EMA(y) * (1-k)
        // Initialize with first price (simple moving average approximation for first point or just price)
        const val = i === 0 ? prices[0] : prices[i] * k + emaArray[i-1] * (1 - k);
        emaArray.push(val);
    }
    return emaArray;
};

// --- DeepSeek API Helper ---
const DEEPSEEK_API_URL = "https://api.deepseek.com/chat/completions";

const callDeepSeek = async (apiKey: string, messages: any[]) => {
    const cleanKey = apiKey ? apiKey.trim() : "";
    if (!cleanKey) throw new Error("API Key 为空");
    // eslint-disable-next-line no-control-regex
    if (/[^\x00-\x7F]/.test(cleanKey)) {
        throw new Error("API Key 包含非法字符(中文或特殊符号)");
    }

    try {
        const response = await fetch(DEEPSEEK_API_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${cleanKey}`
            },
            body: JSON.stringify({
                model: "deepseek-chat",
                messages: messages,
                stream: false,
                temperature: 0.1, // Very low temp for strict logic
                max_tokens: 4096,
                response_format: { type: 'json_object' }
            })
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`DeepSeek API Error: ${response.status} - ${errText}`);
        }

        const json = await response.json();
        return json.choices[0].message.content;
    } catch (e: any) {
        throw new Error(e.message || "DeepSeek 请求失败");
    }
};

export const testConnection = async (apiKey: string): Promise<string> => {
  if (!apiKey) throw new Error("API Key 为空");
  try {
    const content = await callDeepSeek(apiKey, [
        { role: "user", content: "Please respond with a JSON object containing the message 'OK'." }
    ]);
    return content || "无响应内容";
  } catch (e: any) {
    throw new Error(e.message || "连接失败");
  }
};

// --- News Fetcher (Internet Search Capability) ---
const fetchRealTimeNews = async (): Promise<string> => {
    try {
        const url = "https://min-api.cryptocompare.com/data/v2/news/?lang=EN&sortOrder=latest&limit=3";
        const res = await fetch(url);
        if (!res.ok) return "暂无法连接互联网新闻源";
        
        const json = await res.json();
        if (json.Data && Array.isArray(json.Data)) {
            const items = json.Data.slice(0, 3).map((item: any) => {
                const time = new Date(item.published_on * 1000).toLocaleTimeString();
                return `- [${time}] ${item.title}`;
            });
            return items.join("\n");
        }
        return "扫描未发现即时重大新闻";
    } catch (e) {
        return "实时搜索暂时不可用 (API Connection Error)";
    }
};

// --- Strategy Logic: ETH EMA Trend Tracking ---

function analyze1HTrend(candles: CandleData[]) {
    if (candles.length < 60) return { direction: 'NEUTRAL', timestamp: 0 };
    
    const closes = candles.map(c => parseFloat(c.c));
    const opens = candles.map(c => parseFloat(c.o));
    const timestamps = candles.map(c => parseInt(c.ts));
    
    const ema15 = calcEMAArray(closes, 15);
    const ema60 = calcEMAArray(closes, 60);
    
    // Check current (latest completed) candle
    const i = closes.length - 1;
    
    // Logic 1: EMA Relationship
    const isGold = ema15[i] > ema60[i];
    const isDeath = ema15[i] < ema60[i];
    
    // Logic 2: Candle Color
    const isYang = closes[i] > opens[i]; // Bullish
    const isYin = closes[i] < opens[i];  // Bearish
    
    // 1H Trend Judgment
    if (isGold && isYang) {
        return { direction: 'UP', timestamp: timestamps[i] };
    }
    if (isDeath && isYin) {
        return { direction: 'DOWN', timestamp: timestamps[i] };
    }
    
    // Fallback: Stick to EMA if candle color is ambiguous, but strategy says "EMA + Candle Color"
    // If strict, we return Neutral. If loose, we follow EMA. 
    // The prompt says "EMA15上穿EMA60 + K线收阳线 → 上涨趋势". Strict.
    return { direction: 'NEUTRAL', timestamp: timestamps[i] };
}

function analyze3mEntry(candles: CandleData[], trendDirection: string) {
    if (candles.length < 100) return { signal: false, action: 'HOLD', sl: 0, reason: "Insufficient 3m data" };
    
    const closes = candles.map(c => parseFloat(c.c));
    const highs = candles.map(c => parseFloat(c.h));
    const lows = candles.map(c => parseFloat(c.l));
    const ema15 = calcEMAArray(closes, 15);
    const ema60 = calcEMAArray(closes, 60);
    
    const i = closes.length - 1; // Latest completed candle
    
    // Long Logic: Trend UP -> Find Death Cross -> Then Gold Cross
    if (trendDirection === 'UP') {
        // 1. Check if we JUST crossed up (Gold Cross trigger)
        // Condition: EMA15[i] > EMA60[i] AND EMA15[i-1] <= EMA60[i-1]
        const justCrossedUp = ema15[i] > ema60[i] && ema15[i-1] <= ema60[i-1];
        
        if (justCrossedUp) {
            // 2. Validate "Preceding Death Cross Sequence"
            // Look backwards from i-1. We need to find a period where EMA15 < EMA60
            let foundDeathZone = false;
            let lowestInDeathZone = lows[i]; // Start tracking SL
            
            for (let x = i - 1; x >= 0; x--) {
                if (ema15[x] < ema60[x]) {
                    foundDeathZone = true;
                    if (lows[x] < lowestInDeathZone) lowestInDeathZone = lows[x];
                } else {
                    // EMA15 > EMA60 (Previous Gold Zone). Stop if we already found our death zone.
                    if (foundDeathZone) break;
                    // If we haven't found a death zone yet and hit a gold zone immediately, 
                    // it means the cross at [i] might be noise or invalid? 
                    // Actually if [i-1] was <=, then [i-1] is the start/end of death zone.
                }
            }
            
            if (foundDeathZone) {
                return { 
                    signal: true, 
                    action: 'BUY', 
                    sl: lowestInDeathZone, 
                    reason: "1H Uptrend + 3m Death-to-Gold Cross Pattern" 
                };
            }
        }
    }
    
    // Short Logic: Trend DOWN -> Find Gold Cross -> Then Death Cross
    if (trendDirection === 'DOWN') {
        // 1. Check if we JUST crossed down (Death Cross trigger)
        const justCrossedDown = ema15[i] < ema60[i] && ema15[i-1] >= ema60[i-1];
        
        if (justCrossedDown) {
            // 2. Validate "Preceding Gold Cross Sequence"
            let foundGoldZone = false;
            let highestInGoldZone = highs[i];
            
            for (let x = i - 1; x >= 0; x--) {
                if (ema15[x] > ema60[x]) {
                    foundGoldZone = true;
                    if (highs[x] > highestInGoldZone) highestInGoldZone = highs[x];
                } else {
                    if (foundGoldZone) break;
                }
            }
            
            if (foundGoldZone) {
                return { 
                    signal: true, 
                    action: 'SELL', 
                    sl: highestInGoldZone, 
                    reason: "1H Downtrend + 3m Gold-to-Death Cross Pattern" 
                };
            }
        }
    }
    
    return { signal: false, action: 'HOLD', sl: 0, reason: "No new cross pattern" };
}

// --- Main Decision Function ---

export const getTradingDecision = async (
  apiKey: string,
  marketData: MarketDataCollection,
  accountData: AccountContext
): Promise<AIDecision> => {
  if (!apiKey) throw new Error("请输入 DeepSeek API Key");

  // --- 1. Data Prep ---
  const currentPrice = parseFloat(marketData.ticker?.last || "0");
  const totalEquity = parseFloat(accountData.balance.totalEq);
  
  // Strategy Analysis
  const trend1H = analyze1HTrend(marketData.candles1H);
  const entry3m = analyze3mEntry(marketData.candles3m, trend1H.direction);
  
  // Position Info
  const primaryPosition = accountData.positions.find(p => p.instId === INSTRUMENT_ID);
  const hasPosition = !!primaryPosition && parseFloat(primaryPosition.pos) > 0;
  
  let posAnalysis = "无持仓";
  let finalAction = "HOLD";
  let finalSize = "0";
  let finalSL = "";
  let invalidationReason = "";
  
  // --- Decision Logic ---
  
  if (hasPosition) {
      const p = primaryPosition!;
      const posSize = parseFloat(p.pos);
      const upl = parseFloat(p.upl);
      const isLong = p.posSide === 'long';
      
      posAnalysis = `${p.posSide.toUpperCase()} ${p.pos} 张, 浮盈: ${upl} U`;

      // 1. Check Trend Reversal (Immediate Close)
      if (trend1H.direction === 'UP' && !isLong) finalAction = "CLOSE";
      else if (trend1H.direction === 'DOWN' && isLong) finalAction = "CLOSE";
      
      // 2. Rolling (Pyramiding)
      // Rule: Profit 5% -> Add 5%. Interpreted as PnL >= 5% of Account Equity
      if (finalAction === "HOLD") {
          const profitThreshold = totalEquity * 0.05;
          if (upl >= profitThreshold) {
              finalAction = isLong ? "BUY" : "SELL";
              finalSize = "5%"; // Will be calc'd later
              invalidationReason = "Rolling: Profit > 5%";
          }
      }
      
      // 3. Trailing SL Logic
      // Rule: Move to BE if profitable. Then trail 3-5 candles.
      if (finalAction === "HOLD" || finalAction.includes("BUY") || finalAction.includes("SELL")) {
          // Calculate Trailing SL
          const recent3m = marketData.candles3m.slice(-5);
          let newSL = parseFloat(p.slTriggerPx || "0");
          let shouldUpdate = false;
          
          // Basic Breakeven trigger: Upl > 50% of Risk (simplified buffer) or just > 0 covers fees
          const entryPx = parseFloat(p.avgPx);
          
          if (isLong) {
              // Dynamic Trail: Lowest of last 5 candles
              const lowestRecent = Math.min(...recent3m.map(c => parseFloat(c.l)));
              const potentialSL = lowestRecent * 0.9995; // Small buffer
              
              // Only move SL UP
              if (potentialSL > newSL && potentialSL < currentPrice) {
                  newSL = potentialSL;
                  shouldUpdate = true;
              }
              // Ensure at least Breakeven if profit is decent
              if (upl > 5 && newSL < entryPx) {
                  newSL = entryPx * 1.001; // Slightly above entry
                  shouldUpdate = true;
              }
          } else {
              // Dynamic Trail: Highest of last 5 candles
              const highestRecent = Math.max(...recent3m.map(c => parseFloat(c.h)));
              const potentialSL = highestRecent * 1.0005;
              
              // Only move SL DOWN
              if ((newSL === 0 || potentialSL < newSL) && potentialSL > currentPrice) {
                  newSL = potentialSL;
                  shouldUpdate = true;
              }
              if (upl > 5 && (newSL === 0 || newSL > entryPx)) {
                  newSL = entryPx * 0.999;
                  shouldUpdate = true;
              }
          }
          
          if (shouldUpdate && finalAction === "HOLD") {
              finalAction = "UPDATE_TPSL";
              finalSL = newSL.toFixed(2);
          }
          if (shouldUpdate && (finalAction === "BUY" || finalAction === "SELL")) {
              // If adding position, we also update SL for the whole stack
              finalSL = newSL.toFixed(2);
          }
      }

  } else {
      // No Position: Check Entry
      if (entry3m.signal) {
          finalAction = entry3m.action;
          finalSize = "5%"; // Initial Size
          finalSL = entry3m.sl.toFixed(2);
      }
  }

  // --- News ---
  const newsContext = await fetchRealTimeNews();

  // --- Prompt Construction (Verification) ---
  const systemPrompt = `
你是一个严格执行 **ETH EMA 趋势追踪策略** 的交易机器人。
当前时间: ${new Date().toLocaleString()}

**策略状态**:
1. **1H 趋势**: ${trend1H.direction}
2. **3m 入场信号**: ${entry3m.signal ? entry3m.action + " triggered" : "None"} (Reason: ${entry3m.reason})
3. **计算建议**: Action=${finalAction}, SL=${finalSL || "Keep"}

**执行规则**:
- 只有当 1H 趋势明确且 3m 出现特定交叉形态(死后金/金后死)才开仓。
- 首仓 5% 权益。
- 盈利 > 5% 权益时滚仓加码 5%。
- 趋势反转立即平仓。

请基于上述计算结果生成 JSON 决策。
`;

  try {
    const text = await callDeepSeek(apiKey, [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Account: ${totalEquity} USDT. News: ${newsContext}` }
    ]);

    // We mostly trust our calculated 'finalAction' but let AI explain/confirm format
    // To ensure strictness, we overwrite the AI's action with our calculated logic if they differ,
    // or just use AI for 'reasoning' and formatting.
    // For this implementation, we will inject our strict logic into the response object.
    
    let decision: AIDecision = {
        stage_analysis: "EMA趋势追踪",
        market_assessment: `1H趋势: ${trend1H.direction}, 3m信号: ${entry3m.reason}`,
        hot_events_overview: "News processed",
        eth_analysis: `EMA15/60 State. Trend: ${trend1H.direction}`,
        trading_decision: {
            action: finalAction as any,
            confidence: "100%", // Logic driven
            position_size: finalSize,
            leverage: "50",
            profit_target: "",
            stop_loss: finalSL,
            invalidation_condition: "Trend Reversal"
        },
        reasoning: `Based on strict EMA15/60 logic. 1H is ${trend1H.direction}. 3m Signal is ${entry3m.signal}.`,
        action: finalAction as any,
        size: "0",
        leverage: "50"
    };

    // Parse AI reasoning if valid JSON
    try {
        const cleanText = text.replace(/```json/g, '').replace(/```/g, '').trim();
        const aiJson = JSON.parse(cleanText);
        decision.reasoning = aiJson.reasoning || decision.reasoning;
        decision.hot_events_overview = aiJson.hot_events_overview || "N/A";
    } catch (e) {
        // Ignore JSON parse error, use defaults
    }

    // Calc precise size for "5%"
    if (finalAction === 'BUY' || finalAction === 'SELL') {
        const amountU = totalEquity * 0.05;
        const leverage = 50;
        const positionValue = amountU * leverage;
        const contracts = positionValue / (CONTRACT_VAL_ETH * currentPrice);
        decision.size = Math.max(contracts, 0.01).toFixed(2);
    }

    return decision;

  } catch (error: any) {
    console.error("Strategy Error:", error);
    return {
        stage_analysis: "Error",
        market_assessment: "Error",
        hot_events_overview: "Error",
        eth_analysis: "Error",
        trading_decision: { action: 'hold', confidence: "0%", position_size: "0", leverage: "0", profit_target: "", stop_loss: "", invalidation_condition: "" },
        reasoning: error.message,
        action: 'HOLD',
        size: "0",
        leverage: "0"
    };
  }
};
