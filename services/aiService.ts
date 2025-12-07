
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
        const val = prices[i] * k + emaArray[i-1] * (1 - k);
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
                temperature: 0.5, // Lower temperature for stricter rule following
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

// --- Strategy Logic Helper ---

function analyze1HTrend(candles: CandleData[]) {
    // Need at least enough candles for EMA60
    if (candles.length < 60) return { direction: 'NEUTRAL', lastCrossIndex: -1, timestamp: 0 };
    
    const closes = candles.map(c => parseFloat(c.c));
    const ema15 = calcEMAArray(closes, 15);
    const ema60 = calcEMAArray(closes, 60);
    
    // Check current state (last closed candle)
    const i = closes.length - 1;
    const isGold = ema15[i] > ema60[i];
    const isDeath = ema15[i] < ema60[i];
    
    // Check Candle Color (Close vs Open)
    const isBullCandle = parseFloat(candles[i].c) > parseFloat(candles[i].o);
    const isBearCandle = parseFloat(candles[i].c) < parseFloat(candles[i].o);
    
    // Find last cross
    let lastCrossIdx = -1;
    for (let x = i; x > 0; x--) {
        const currDiff = ema15[x] - ema60[x];
        const prevDiff = ema15[x-1] - ema60[x-1];
        if ((currDiff >= 0 && prevDiff < 0) || (currDiff < 0 && prevDiff >= 0)) {
            lastCrossIdx = x;
            break;
        }
    }
    
    // Strategy Rule: EMA15 > EMA60 + Yang Line = Upward Trend
    if (isGold && isBullCandle) return { direction: 'UP', lastCrossIndex: lastCrossIdx, timestamp: parseInt(candles[lastCrossIdx]?.ts || '0') };
    // Strategy Rule: EMA15 < EMA60 + Yin Line = Downward Trend
    if (isDeath && isBearCandle) return { direction: 'DOWN', lastCrossIndex: lastCrossIdx, timestamp: parseInt(candles[lastCrossIdx]?.ts || '0') };
    
    // Fallback based on EMA only if candle color is noise, or stick to neutral
    if (isGold) return { direction: 'UP_WEAK', lastCrossIndex: lastCrossIdx, timestamp: parseInt(candles[lastCrossIdx]?.ts || '0') };
    if (isDeath) return { direction: 'DOWN_WEAK', lastCrossIndex: lastCrossIdx, timestamp: parseInt(candles[lastCrossIdx]?.ts || '0') };
    
    return { direction: 'NEUTRAL', lastCrossIndex: -1, timestamp: 0 };
}

function analyze3mEntry(candles: CandleData[], trendDirection: string) {
    if (candles.length < 60) return { signal: false, sl: 0, reason: "Insufficient data" };
    
    const closes = candles.map(c => parseFloat(c.c));
    const highs = candles.map(c => parseFloat(c.h));
    const lows = candles.map(c => parseFloat(c.l));
    
    const ema15 = calcEMAArray(closes, 15);
    const ema60 = calcEMAArray(closes, 60);
    
    // Look for pattern in the recent window (e.g., last 20 candles)
    // We need to find a completed sequence.
    // Long: Death Cross Zone -> Golden Cross Trigger
    // Short: Golden Cross Zone -> Death Cross Trigger
    
    // Check if we JUST triggered (index -1 is the completed candle)
    const i = closes.length - 1;
    
    if (trendDirection.includes('UP')) {
        // Condition: Just crossed UP (Golden Cross)
        const justCrossedUp = ema15[i] > ema60[i] && ema15[i-1] <= ema60[i-1];
        
        if (justCrossedUp) {
            // Validate: Was there a Death Cross zone before?
            // Go back to find where EMA15 was < EMA60
            let minLow = lows[i]; // Start SL tracking
            let foundDeathZone = false;
            
            for (let x = i - 1; x > 0; x--) {
                if (ema15[x] < ema60[x]) {
                    foundDeathZone = true;
                    if (lows[x] < minLow) minLow = lows[x];
                } else {
                    // EMA15 > EMA60 again (Previous Golden Zone), stop search
                    if (foundDeathZone) break; 
                }
            }
            
            if (foundDeathZone) {
                return { signal: true, sl: minLow, reason: "Long Entry Pattern: Death -> Golden Cross detected" };
            }
        }
    } else if (trendDirection.includes('DOWN')) {
        // Condition: Just crossed DOWN (Death Cross)
        const justCrossedDown = ema15[i] < ema60[i] && ema15[i-1] >= ema60[i-1];
        
        if (justCrossedDown) {
            // Validate: Was there a Golden Cross zone before?
            let maxHigh = highs[i];
            let foundGoldZone = false;
            
            for (let x = i - 1; x > 0; x--) {
                if (ema15[x] > ema60[x]) {
                    foundGoldZone = true;
                    if (highs[x] > maxHigh) maxHigh = highs[x];
                } else {
                    if (foundGoldZone) break;
                }
            }
            
            if (foundGoldZone) {
                return { signal: true, sl: maxHigh, reason: "Short Entry Pattern: Golden -> Death Cross detected" };
            }
        }
    }
    
    return { signal: false, sl: 0, reason: "No valid entry pattern" };
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
  const availableEquity = parseFloat(accountData.balance.availEq);
  
  // EMA Strategy Analysis
  const trend1H = analyze1HTrend(marketData.candles1H);
  const entry3m = analyze3mEntry(marketData.candles3m, trend1H.direction);
  
  // Position Info
  const primaryPosition = accountData.positions.find(p => p.instId === INSTRUMENT_ID);
  const hasPosition = !!primaryPosition && parseFloat(primaryPosition.pos) > 0;
  
  let posAnalysis = "无持仓";
  let pyramidingSignal = false;
  let riskManagementSignal = "HOLD"; // Default
  let suggestedSL = "";
  
  if (hasPosition) {
      const p = primaryPosition!;
      const entryPrice = parseFloat(p.avgPx);
      const upl = parseFloat(p.upl);
      const sizeVal = parseFloat(p.pos) * CONTRACT_VAL_ETH * currentPrice;
      const initialMargin = sizeVal / parseFloat(p.leverage || "50"); // Estimate
      
      // Net Profit Calc
      const fees = sizeVal * TAKER_FEE_RATE * 2; // Open + Close estimate
      const netPnL = upl - fees;
      const netPnLPct = (netPnL / initialMargin) * 100; // Return on Margin
      
      posAnalysis = `
      方向: ${p.posSide}
      持仓: ${p.pos} 张
      均价: ${entryPrice}
      浮盈: ${upl} U (Net: ${netPnL.toFixed(2)} U)
      ROI: ${netPnLPct.toFixed(2)}%
      `;

      // 1. Pyramiding Logic: Add 5% for every 5% profit
      // Simple check: Is PnL > 5%? (And maybe check if we recently added? AI can handle frequency via 'confidence')
      if (netPnLPct >= 5) {
          pyramidingSignal = true;
      }

      // 2. Trailing SL Logic
      // Recent 5 candles on 3m
      const recent3m = marketData.candles3m.slice(-5);
      const recentHigh = Math.max(...recent3m.map(c => parseFloat(c.h)));
      const recentLow = Math.min(...recent3m.map(c => parseFloat(c.l)));
      
      // Check Breakeven trigger: Floating Profit > Initial Risk
      // We assume initial risk was ~1-2% of price or based on the setup SL. 
      // Simplified: If Net PnL > 0.5% of total equity (covers fees + risk), move to BE.
      
      if (p.posSide === 'long') {
          if (netPnL > 10) { // Hardcoded 10U buffer or just profit > 0
               suggestedSL = p.breakEvenPx || entryPrice.toFixed(2);
               // Trailing
               const trailPx = (recentLow * 0.9995).toFixed(2); // Slightly below low
               if (parseFloat(trailPx) > parseFloat(suggestedSL)) suggestedSL = trailPx;
               riskManagementSignal = "UPDATE_TPSL";
          }
      } else {
          if (netPnL > 10) {
              suggestedSL = p.breakEvenPx || entryPrice.toFixed(2);
               // Trailing
               const trailPx = (recentHigh * 1.0005).toFixed(2); // Slightly above high
               if (parseFloat(trailPx) < parseFloat(suggestedSL)) suggestedSL = trailPx;
               riskManagementSignal = "UPDATE_TPSL";
          }
      }
      
      // 3. Trend Reversal Check (Immediate Close)
      if (trend1H.direction === 'UP' && p.posSide === 'short') riskManagementSignal = "CLOSE";
      if (trend1H.direction === 'DOWN' && p.posSide === 'long') riskManagementSignal = "CLOSE";
  }

  // --- News ---
  const newsContext = await fetchRealTimeNews();

  // --- Prompt Construction ---
  const systemPrompt = `
你是一个严格执行 **ETH EMA 趋势追踪策略** 的交易机器人。
**严禁** 使用任何其他指标（RSI, MACD, KDJ 等），只关注 EMA15 和 EMA60。

**当前市场状态**:
- 1H 趋势 (趋势判断): ${trend1H.direction} (自 ${new Date(trend1H.timestamp).toLocaleTimeString()})
- 3m 信号 (入场时机): ${entry3m.signal ? "TRIGGERED" : "WAITING"}
- 3m 信号详情: ${entry3m.reason}
- 计算止损位 (SL): ${entry3m.sl}

**持仓状态**:
${posAnalysis}

**策略规则 (Strategy Rules)**:
1. **趋势判断 (1H)**: 
   - EMA15 > EMA60 且 K线阳线 -> 看涨。
   - EMA15 < EMA60 且 K线阴线 -> 看跌。
2. **入场逻辑 (3m)**: 
   - 必须在 1H 趋势方向上操作。
   - 看涨时: 等待 3m 图出现 [死叉 EMA15<60] -> [金叉 EMA15>60]。在金叉形成的 K 线收盘买入。
   - 看跌时: 等待 3m 图出现 [金叉 EMA15>60] -> [死叉 EMA15<60]。在死叉形成的 K 线收盘卖出。
3. **资金管理 (Rolling)**:
   - 首仓 5% 资金。
   - 每盈利 5% 加仓 5%。
4. **止损管理**:
   - 初始止损: 入场前一波反向交叉的极值 (Long用死叉期最低价, Short用金叉期最高价)。
   - 移动止损: 盈利后移至保本；随后跟随 3m K线高低点移动。
5. **反转离场**:
   - 如果 1H 趋势反转 (与持仓方向相反)，立即平仓。

**指令生成**:
- 如果当前无持仓 且 3m信号触发 -> BUY/SELL (Size: 5% Equity).
- 如果有持仓 且 趋势反转 -> CLOSE.
- 如果有持仓 且 盈利达标(ROI > 5%) -> BUY/SELL (Add Position 5%).
- 如果有持仓 且 需要移动止损 -> UPDATE_TPSL (Set new SL).
- 否则 -> HOLD.
`;

  const responseSchema = `
  {
    "stage_analysis": "EMA策略执行",
    "market_assessment": "简述1H趋势和3m信号状态...",
    "hot_events_overview": "...",
    "eth_analysis": "...", 
    "trading_decision": {
      "action": "BUY|SELL|HOLD|CLOSE|UPDATE_TPSL",
      "confidence": "0-100%",
      "position_size": "数量(张) or '5%'",
      "leverage": "50",
      "profit_target": "",
      "stop_loss": "${entry3m.signal ? entry3m.sl : suggestedSL}",
      "invalidation_condition": "1H趋势反转"
    },
    "reasoning": "严格基于EMA规则解释"
  }
  `;

  try {
    const text = await callDeepSeek(apiKey, [
        { role: "system", content: systemPrompt + "\nJSON ONLY:\n" + responseSchema },
        { role: "user", content: `账户权益: ${totalEquity}, 可用: ${availableEquity}. News: ${newsContext}` }
    ]);

    if (!text) throw new Error("AI 返回为空");

    let decision: AIDecision;
    try {
        const cleanText = text.replace(/```json/g, '').replace(/```/g, '').trim();
        decision = JSON.parse(cleanText);
    } catch (e) {
        throw new Error("AI 返回格式错误");
    }

    // --- Post-Processing ---
    decision.action = decision.trading_decision.action.toUpperCase() as any;
    
    // Auto-calculate size if "5%" is requested
    if (decision.action === 'BUY' || decision.action === 'SELL') {
        if (decision.trading_decision.position_size.includes('%') || !decision.trading_decision.position_size || decision.trading_decision.position_size === "0") {
             // 5% of Total Equity
             const amountU = totalEquity * 0.05;
             const leverage = parseFloat(decision.trading_decision.leverage) || 50;
             const positionValue = amountU * leverage;
             const contracts = positionValue / (CONTRACT_VAL_ETH * currentPrice);
             decision.size = Math.max(contracts, 0.01).toFixed(2);
        } else {
             decision.size = decision.trading_decision.position_size;
        }
        decision.leverage = (decision.trading_decision.leverage || "50").toString();
    } else {
        decision.size = "0";
        decision.leverage = "0";
    }

    return decision;

  } catch (error: any) {
    console.error("AI Decision Error:", error);
    return {
        stage_analysis: "AI Error",
        market_assessment: "Unknown",
        hot_events_overview: "N/A",
        eth_analysis: "N/A",
        trading_decision: {
            action: 'hold',
            confidence: "0%",
            position_size: "0",
            leverage: "0",
            profit_target: "0",
            stop_loss: "0",
            invalidation_condition: "Error"
        },
        reasoning: "System Error: " + error.message,
        action: 'HOLD',
        size: "0",
        leverage: "0"
    };
  }
};
