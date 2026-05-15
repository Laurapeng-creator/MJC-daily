module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Transfer-Encoding', 'chunked');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).end();

  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    try {
      const { password, date } = JSON.parse(body || '{}');

      if (!password || password !== process.env.EDIT_PASSWORD) {
        return res.status(401).json({ error: '密码错误' });
      }

      const targetDate = date || new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      const targetLabel = `${new Date(targetDate).getFullYear()}年${new Date(targetDate).getMonth()+1}月${new Date(targetDate).getDate()}日`;

      res.write(JSON.stringify({ step: 'fetching_news' }) + '\n');

      // 1. Fetch news from all sources
      const sources = { weibo: 2, zhihu: 2, thepaper: 1 };
      const allItems = [];

      for (const [sourceId, limit] of Object.entries(sources)) {
        try {
          const items = await fetchNews(sourceId, limit);
          allItems.push(...items);
          res.write(JSON.stringify({ step: 'fetching_news', source: sourceId, count: items.length }) + '\n');
        } catch(e) {}
      }

      if (allItems.length === 0) {
        res.write(JSON.stringify({ success: false, error: '无热点数据' }) + '\n');
        return res.end();
      }

      res.write(JSON.stringify({ step: 'deduping', count: allItems.length }) + '\n');

      // 2. Deduplicate
      const deduped = deduplicate(allItems, 5);
      res.write(JSON.stringify({ step: 'start_ai', count: deduped.length }) + '\n');

      // 3. Generate AI (with timeout per item)
      for (let i = 0; i < deduped.length; i++) {
        try {
          deduped[i].ai = await withTimeout(generateAI(deduped[i].title), 8000);
        } catch(e) {
          deduped[i].ai = { 知识点: ['生成失败'], 怎么考: ['生成失败'], 案例积累: '' };
        }
        res.write(JSON.stringify({ step: 'ai_done', index: i+1, total: deduped.length, title: deduped[i].title.substring(0,20) }) + '\n');
        if (i < deduped.length - 1) await sleep(800);
      }

      // 4. Save to Redis
      const payload = { date: targetLabel, items: deduped, generatedAt: new Date().toISOString() };
      const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
      const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

      await fetch(`${redisUrl}/set/news:${targetDate}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${redisToken}` },
        body: JSON.stringify(JSON.stringify(payload)),
      });

      res.write(JSON.stringify({ success: true, count: deduped.length, date: targetDate }) + '\n');
      res.end();

    } catch (e) {
      try { res.write(JSON.stringify({ error: e.message }) + '\n'); } catch(e2) {}
      res.end();
    }
  });
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('超时')), ms))]);
}

function fetchNews(sourceId, limit) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const targetUrl = `https://newsnow.busiyi.world/api/s?id=${sourceId}`;
    const req = https.get(targetUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
      timeout: 5000,
    }, (pr) => {
      if (pr.statusCode >= 400) { resolve([]); return; }
      let data = '';
      pr.on('data', chunk => data += chunk);
      pr.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve((json.items || []).slice(0, limit).map((item, idx) => ({
            id: `${sourceId}-${item.id || idx}`,
            title: item.title,
            url: item.url || item.mobileUrl || '#',
            rank: idx + 1,
            platform: sourceId,
          })));
        } catch (e) { resolve([]); }
      });
    });
    req.on('error', () => resolve([]));
    req.on('timeout', () => { req.destroy(); resolve([]); });
  });
}

function deduplicate(items, targetCount) {
  const selected = [];
  const priority = { weibo: 0, zhihu: 1, thepaper: 2 };
  items.sort((a, b) => priority[a.platform] - priority[b.platform]);
  for (const item of items) {
    if (selected.length >= targetCount) break;
    const normalized = item.title.trim().toLowerCase();
    let isDupe = false;
    for (const sel of selected) {
      if (similarity(normalized, sel.title.trim().toLowerCase()) > 0.6) { isDupe = true; break; }
    }
    if (!isDupe) selected.push(item);
  }
  return selected;
}

function similarity(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const setA = new Set(a.split(''));
  const setB = new Set(b.split(''));
  const intersection = [...setA].filter(c => setB.has(c)).length;
  return intersection / (setA.size + setB.size - intersection);
}

const AI_SYSTEM_PROMPT = `你是一位新传考研辅导专家，熟悉北大新传考研出题风格与高频考点。每次收到一条新闻热点，按以下格式输出分析。

输出格式：
涉及知识点：（精准、专业、不超纲，优先使用新传核心概念，不超过5个）
怎么考：（4个论点）
一句话案例积累：（直接可用于答题）`;

const AI_USER_PROMPT = `热点：{title}

请按以下格式输出：
涉及知识点
怎么考
一句话案例积累`;

function generateAI(title) {
  return new Promise((resolve) => {
    const https = require('https');
    const payload = JSON.stringify({
      model: 'MiniMax-M2.7',
      messages: [
        { role: 'system', content: AI_SYSTEM_PROMPT },
        { role: 'user', content: AI_USER_PROMPT.replace('{title}', title) },
      ],
      max_tokens: 1000,
      temperature: 0.7,
    });

    const req = https.request({
      hostname: 'api.minimaxi.chat',
      path: '/v1/text/chatcompletion_v2',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.MINIMAX_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 7000,
    }, (pr) => {
      let data = '';
      pr.on('data', chunk => data += chunk);
      pr.on('end', () => {
        try {
          const json = JSON.parse(data);
          const content = json.choices?.[0]?.message?.content || json.output || '';
          resolve(content ? parseAI(content) : defaultAI());
        } catch (e) { resolve(defaultAI()); }
      });
    });

    req.on('error', () => resolve(defaultAI()));
    req.on('timeout', () => { req.destroy(); resolve(defaultAI()); });
    req.write(payload);
    req.end();
  });
}

function defaultAI() { return { 知识点: ['待补充'], 怎么考: ['待补充'], 案例积累: '' }; }

function parseAI(content) {
  const result = { 知识点: [], 怎么考: [], 案例积累: '' };
  const kSection = content.match(/涉及知识点[:：]?([\s\S]*?)(?=怎么考)/i);
  if (kSection) result.知识点 = kSection[1].split(/\n/).map(s => s.replace(/^[-*·\s]+/, '').trim()).filter(s => s && s.length > 1 && s.length < 30).slice(0, 5);
  const pSection = content.match(/怎么考[:：]?([\s\S]*?)(?=一句话案例积累)/i);
  if (pSection) result.怎么考 = pSection[1].split(/\n/).map(s => s.replace(/^\d+[.、：:：]\s*/, '').trim()).filter(s => s && s.length > 5).slice(0, 4);
  const cSection = content.match(/一句话案例积累[:：]?\n*([\s\S]*)$/i);
  if (cSection) result.案例积累 = cSection[1].replace(/^[-*·\s]+/, '').trim();
  if (result.知识点.length === 0) result.知识点 = ['待补充'];
  if (result.怎么考.length === 0) result.怎么考 = ['待补充'];
  return result;
}