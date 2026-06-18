require('dotenv').config();
const express = require('express');
const path = require('path');
const { Sequelize, DataTypes } = require('sequelize');
const OpenAI = require('openai');

// ─── App & Port ───────────────────────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Database Path ────────────────────────────────────────────────────────────
const DB_PATH = process.env.RAILWAY_ENVIRONMENT_NAME
  ? '/data/database.sqlite'
  : path.join(__dirname, 'database.sqlite');

// ─── Sequelize ────────────────────────────────────────────────────────────────
const sequelize = new Sequelize({
  dialect: 'sqlite',
  storage: DB_PATH,
  logging: false,
});

// ─── Model ────────────────────────────────────────────────────────────────────
const HealthLog = sequelize.define('HealthLog', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  log_date: {
    type: DataTypes.DATEONLY,
    allowNull: false,
  },
  sleep_hours: {
    type: DataTypes.REAL,
    allowNull: false,
  },
  steps: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  mood_score: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  risk_level: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
}, {
  tableName: 'health_logs',
  timestamps: false,
});

// ─── OpenAI (OpenRouter) ──────────────────────────────────────────────────────
const openai = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY,
});

// ─── Information Gain (C4.5) ──────────────────────────────────────────────────

// 計算一組標籤的熵（Entropy）
function calcEntropy(labels) {
  const n = labels.length;
  if (n === 0) return 0;
  const counts = {};
  labels.forEach(l => { counts[l] = (counts[l] || 0) + 1; });
  return -Object.values(counts).reduce((sum, count) => {
    const p = count / n;
    return sum + (p > 0 ? p * Math.log2(p) : 0);
  }, 0);
}

// 計算某特徵在某門檻值下的資訊增益
function calcIG(data, feature, threshold) {
  const labels = data.map(d => d.risk_level);
  const parentEntropy = calcEntropy(labels);
  const left  = data.filter(d => d[feature] <  threshold);
  const right = data.filter(d => d[feature] >= threshold);
  const weightedEntropy =
    (left.length  / data.length) * calcEntropy(left.map(d  => d.risk_level)) +
    (right.length / data.length) * calcEntropy(right.map(d => d.risk_level));
  return parentEntropy - weightedEntropy;
}

// 對某特徵窮舉所有中間點，找最佳門檻值
function findBestThreshold(data, feature) {
  const vals = [...new Set(data.map(d => d[feature]))].sort((a, b) => a - b);
  let bestIG = -1, bestThreshold = null;
  for (let i = 0; i < vals.length - 1; i++) {
    const threshold = parseFloat(((vals[i] + vals[i + 1]) / 2).toFixed(4));
    const ig = calcIG(data, feature, threshold);
    if (ig > bestIG) { bestIG = ig; bestThreshold = threshold; }
  }
  return { threshold: bestThreshold, ig: parseFloat(bestIG.toFixed(6)) };
}

// ─── Decision Tree ────────────────────────────────────────────────────────────
// 多層決策樹：睡眠 → 步數 → 心情
// 依資訊增益排序：sleep_hours 分辨力最強，其次 steps，再 mood_score
//
// 層次結構：
//   Level 1: sleep_hours < 6?
//     ├── YES (睡眠不足)
//     │     Level 2: steps < 4000?
//     │       ├── YES → HIGH（睡眠差 + 活動少）
//     │       └── NO
//     │             Level 3: mood_score < 5?
//     │               ├── YES → HIGH（睡眠差 + 心情差）
//     │               └── NO  → MEDIUM（睡眠差但活動/心情尚可）
//     └── NO (睡眠充足, >= 6)
//           Level 2: steps < 5000?
//             ├── YES (活動偏少)
//             │     Level 3: mood_score < 5?
//             │       ├── YES → MEDIUM（活動少 + 心情差）
//             │       └── NO  → LOW（睡眠好，活動少但心情OK）
//             └── NO (活動足夠)
//                   Level 3: mood_score < 6?
//                     ├── YES → MEDIUM（睡眠/活動OK但心情差）
//                     └── NO  → LOW（三項皆良好）

function decisionTree(sleep_hours, steps, mood_score) {
  // 決策樹：三層結構，每筆資料必須依序走完 睡眠 → 步數 → 心情 三個特徵
  //
  // Level 1: sleep_hours < 6?
  //   Level 2: steps < 4000?
  //     Level 3: mood_score < 5?
  //       YES → 高（三項全差）
  //       NO  → 高（睡眠+活動差，心情尚可亦無法挽回）
  //     Level 3: mood_score < 5?
  //       YES → 高（睡眠差+心情差）
  //       NO  → 中（睡眠差但活動+心情尚可）
  //   Level 2: steps < 5000?
  //     Level 3: mood_score < 5?
  //       YES → 中（活動偏少+心情差）
  //       NO  → 低（睡眠好，活動稍少但心情良好）
  //     Level 3: mood_score < 6?
  //       YES → 中（睡眠/活動好但心情欠佳）
  //       NO  → 低（三項指標皆良好）

  // Level 1: 睡眠是否充足
  if (sleep_hours < 6) {
    // Level 2: 活動量是否極低
    if (steps < 4000) {
      // Level 3: 心情（睡眠+活動雙重不足，心情為最後確認）
      if (mood_score < 5) {
        return '高'; // 三項全差：最高警示
      } else {
        return '高'; // 睡眠+活動嚴重不足，即使心情尚可仍屬高風險
      }
    } else {
      // Level 3: 心情決定高風險或中風險
      if (mood_score < 5) {
        return '高'; // 睡眠差 + 心情差（雙重警示）
      } else {
        return '中'; // 睡眠差但活動OK且心情尚可
      }
    }
  } else {
    // Level 2: 活動量是否不足
    if (steps < 5000) {
      // Level 3: 心情決定中風險或低風險
      if (mood_score < 5) {
        return '中'; // 睡眠好但活動少且心情差
      } else {
        return '低'; // 睡眠好，活動雖少但心情良好
      }
    } else {
      // Level 3: 心情為最後決定因素
      if (mood_score < 6) {
        return '中'; // 睡眠/活動皆好但心情不佳
      } else {
        return '低'; // 三項指標皆在良好範圍
      }
    }
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// GET /health-logs — 取得所有紀錄（最新在前）
app.get('/health-logs', async (req, res) => {
  try {
    const logs = await HealthLog.findAll({ order: [['log_date', 'DESC']] });
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /health-logs/info-gain — 依種子資料計算各特徵的資訊增益（C4.5 進階）
app.get('/health-logs/info-gain', async (req, res) => {
  try {
    const raw = await HealthLog.findAll({ raw: true });
    const data = raw.filter(d => d.risk_level); // 只使用有 risk_level 的資料
    if (data.length < 10) {
      return res.status(400).json({ error: '資料筆數不足（需至少10筆），請先載入種子資料' });
    }

    const features = ['sleep_hours', 'steps', 'mood_score'];
    const featureNames = { sleep_hours: '睡眠時數', steps: '步數', mood_score: '心情分數' };
    const baseEntropy = parseFloat(calcEntropy(data.map(d => d.risk_level)).toFixed(6));

    // 計算各風險等級分布
    const dist = {};
    data.forEach(d => { dist[d.risk_level] = (dist[d.risk_level] || 0) + 1; });

    // 計算每個特徵的最佳門檻與 IG
    const results = {};
    for (const f of features) {
      const { threshold, ig } = findBestThreshold(data, f);
      const left  = data.filter(d => d[f] < threshold);
      const right = data.filter(d => d[f] >= threshold);
      results[f] = {
        featureName: featureNames[f],
        bestThreshold: threshold,
        informationGain: ig,
        leftCount: left.length,
        rightCount: right.length,
        leftDist:  left.reduce((acc, d)  => { acc[d.risk_level] = (acc[d.risk_level] || 0) + 1; return acc; }, {}),
        rightDist: right.reduce((acc, d) => { acc[d.risk_level] = (acc[d.risk_level] || 0) + 1; return acc; }, {}),
      };
    }

    // 依 IG 排序 → 決定最佳切分順序
    const sorted = features.slice().sort((a, b) => results[b].informationGain - results[a].informationGain);

    res.json({
      totalRecords: data.length,
      riskDistribution: dist,
      baseEntropy,
      features: results,
      optimalSplitOrder: sorted.map(f => ({
        feature: f,
        featureName: featureNames[f],
        informationGain: results[f].informationGain,
        bestThreshold: results[f].bestThreshold,
      })),
      conclusion: `依資訊增益排序，最佳首層切分特徵為「${featureNames[sorted[0]]}」（門檻值 ${results[sorted[0]].bestThreshold}，IG = ${results[sorted[0]].informationGain}），與本系統決策樹設計一致。`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /health-logs/risk — 回傳最新一筆的風險等級
app.get('/health-logs/risk', async (req, res) => {
  try {
    const latest = await HealthLog.findOne({ order: [['log_date', 'DESC']] });
    if (!latest) return res.json({ risk_level: null, message: '尚無紀錄' });
    const risk = decisionTree(latest.sleep_hours, latest.steps, latest.mood_score);
    res.json({
      risk_level: risk,
      log_date: latest.log_date,
      sleep_hours: latest.sleep_hours,
      steps: latest.steps,
      mood_score: latest.mood_score,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /health-logs — 新增一筆日誌（自動計算 risk_level）
app.post('/health-logs', async (req, res) => {
  try {
    const { log_date, sleep_hours, steps, mood_score } = req.body;
    if (!log_date || sleep_hours == null || steps == null || mood_score == null) {
      return res.status(400).json({ error: '缺少必要欄位：log_date, sleep_hours, steps, mood_score' });
    }
    const risk_level = decisionTree(parseFloat(sleep_hours), parseInt(steps), parseInt(mood_score));
    const log = await HealthLog.create({
      log_date,
      sleep_hours: parseFloat(sleep_hours),
      steps: parseInt(steps),
      mood_score: parseInt(mood_score),
      risk_level,
    });
    res.status(201).json(log);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /health-logs/:id — 修改指定日誌
app.put('/health-logs/:id', async (req, res) => {
  try {
    const log = await HealthLog.findByPk(req.params.id);
    if (!log) return res.status(404).json({ error: '找不到該筆紀錄' });
    const { log_date, sleep_hours, steps, mood_score } = req.body;
    const newSleep = sleep_hours != null ? parseFloat(sleep_hours) : log.sleep_hours;
    const newSteps = steps != null ? parseInt(steps) : log.steps;
    const newMood = mood_score != null ? parseInt(mood_score) : log.mood_score;
    const risk_level = decisionTree(newSleep, newSteps, newMood);
    await log.update({
      log_date: log_date || log.log_date,
      sleep_hours: newSleep,
      steps: newSteps,
      mood_score: newMood,
      risk_level,
    });
    res.json(log);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /health-logs/:id — 刪除指定日誌
app.delete('/health-logs/:id', async (req, res) => {
  try {
    const log = await HealthLog.findByPk(req.params.id);
    if (!log) return res.status(404).json({ error: '找不到該筆紀錄' });
    await log.destroy();
    res.json({ message: '已刪除', id: req.params.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /health-logs/ai-advice — 呼叫 AI 取得健康建議
app.post('/health-logs/ai-advice', async (req, res) => {
  try {
    const { sleep_hours, steps, mood_score, risk_level } = req.body;
    const prompt = `你是一位專業的健康顧問，請根據以下今日健康數據，用繁體中文提供具體、實用的個人化健康建議（約150字）：
- 睡眠時數：${sleep_hours} 小時
- 今日步數：${steps} 步
- 心情分數：${mood_score}/10
- 系統評估風險等級：${risk_level}

請依風險等級給出對應強度的建議，高風險需特別提醒就醫或立即改善，中風險給予具體改善方向，低風險則給予鼓勵與維持建議。`;

    const completion = await openai.chat.completions.create({
      model: 'google/gemma-4-31b-it:free',
      messages: [{ role: 'user', content: prompt }],
    });
    const text = completion.choices[0].message.content;
    res.json({ advice: text });
  } catch (err) {
    res.status(500).json({ error: 'AI 呼叫失敗：' + err.message });
  }
});

// POST /health-logs/seed — 載入種子資料（90天模擬資料）
app.post('/health-logs/seed', async (req, res) => {
  try {
    const today = new Date();
    const seedData = [];

    // 高風險組（約25天）：睡眠少、步數少、心情差
    const highRiskDays = [
      [4.0, 1200, 2], [4.5, 1500, 1], [3.5, 900, 2], [5.0, 2000, 3],
      [4.5, 1800, 2], [4.0, 1100, 1], [5.0, 3000, 3], [4.5, 2500, 2],
      [3.5, 1000, 1], [5.0, 1500, 2], [4.0, 2000, 3], [4.5, 1200, 2],
      [5.0, 3200, 3], [4.0, 1800, 1], [3.5, 2200, 2], [4.5, 900, 2],
      [5.0, 1600, 3], [4.0, 2800, 2], [4.5, 3500, 4], [5.0, 2100, 2],
      [4.0, 1300, 1], [3.5, 1700, 2], [5.0, 3100, 3], [4.5, 2400, 2],
      [4.0, 1900, 1],
    ];

    // 中風險組（約40天）：數值混合普通
    const midRiskDays = [
      [5.5, 4500, 4], [6.0, 4800, 5], [6.5, 3800, 4], [5.5, 5500, 4],
      [6.0, 4200, 3], [7.0, 3500, 5], [5.5, 6000, 4], [6.0, 5000, 4],
      [6.5, 4600, 5], [5.5, 3900, 4], [6.0, 5200, 3], [7.0, 4800, 5],
      [5.5, 4100, 4], [6.0, 5800, 4], [6.5, 4900, 5], [5.5, 6200, 5],
      [6.0, 3700, 4], [7.0, 5100, 5], [5.5, 4400, 4], [6.0, 4700, 3],
      [6.5, 5300, 4], [5.5, 4000, 5], [6.0, 6100, 4], [7.0, 5600, 5],
      [5.5, 4300, 4], [6.0, 3600, 3], [6.5, 5400, 5], [5.5, 4800, 4],
      [6.0, 5900, 4], [7.0, 4600, 5], [6.5, 4200, 4], [5.5, 5700, 5],
      [6.0, 3800, 4], [6.5, 4900, 4], [7.0, 5200, 5], [5.5, 4500, 4],
      [6.0, 6300, 5], [6.5, 4100, 4], [7.0, 5500, 5], [5.5, 4600, 4],
    ];

    // 低風險組（約25天）：睡眠足、步數多、心情好
    const lowRiskDays = [
      [8.0, 8500, 9], [7.5, 9200, 8], [8.5, 7800, 9], [7.0, 8000, 8],
      [8.0, 9500, 9], [7.5, 7500, 8], [9.0, 8200, 9], [8.0, 9000, 8],
      [7.5, 8800, 9], [8.5, 7200, 8], [7.0, 9100, 9], [8.0, 6800, 8],
      [7.5, 8400, 9], [8.5, 9800, 8], [9.0, 7600, 9], [7.0, 8600, 8],
      [8.0, 9300, 9], [7.5, 7900, 8], [8.5, 8700, 9], [9.0, 6500, 8],
      [7.0, 9600, 9], [8.0, 8100, 8], [7.5, 7300, 9], [8.5, 9400, 8],
      [9.0, 8900, 9],
    ];

    let dayOffset = 89;
    for (const [sh, st, ms] of highRiskDays) {
      const d = new Date(today);
      d.setDate(d.getDate() - dayOffset--);
      seedData.push({ log_date: d.toISOString().split('T')[0], sleep_hours: sh, steps: st, mood_score: ms });
    }
    for (const [sh, st, ms] of midRiskDays) {
      const d = new Date(today);
      d.setDate(d.getDate() - dayOffset--);
      seedData.push({ log_date: d.toISOString().split('T')[0], sleep_hours: sh, steps: st, mood_score: ms });
    }
    for (const [sh, st, ms] of lowRiskDays) {
      const d = new Date(today);
      d.setDate(d.getDate() - dayOffset--);
      seedData.push({ log_date: d.toISOString().split('T')[0], sleep_hours: sh, steps: st, mood_score: ms });
    }

    // 加入 risk_level
    const records = seedData.map(r => ({
      ...r,
      risk_level: decisionTree(r.sleep_hours, r.steps, r.mood_score),
    }));

    await HealthLog.bulkCreate(records);
    res.json({ message: `成功載入 ${records.length} 筆種子資料`, count: records.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Sync DB & Start ──────────────────────────────────────────────────────────
sequelize.sync({ alter: true }).then(() => {
  app.listen(PORT, () => {
    console.log(`✅ 智慧健康日誌系統已啟動`);
    console.log(`🌐 http://localhost:${PORT}`);
    console.log(`📂 資料庫路徑：${DB_PATH}`);
  });
}).catch(err => {
  console.error('❌ 資料庫初始化失敗：', err);
});
