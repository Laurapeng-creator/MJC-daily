const https = require('https');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Connection', 'close');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).end();

  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    try {
      const { password, date } = JSON.parse(body || '{}');
      if (!password || password !== process.env.EDIT_PASSWORD) {
        res.status(401).json({ error: '密码错误' });
        return;
      }

      const targetDate = date || new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      const targetLabel = `${new Date(targetDate).getFullYear()}年${new Date(targetDate).getMonth()+1}月${new Date(targetDate).getDate()}日`;

      // Fetch 1 item from each source (fast)
      const allItems = [];
      for (const [sourceId, limit] of [['weibo',1],['zhihu',1],['thepaper',1]]) {
        try {
          const items = await fetchNews(sourceId, limit);
          allItems.push(...items);
        } catch(e) {}
      }

      if (allItems.length === 0) {
        res.status(200).json({ success: false, error: '无热点数据' });
        return;
      }

      // Deduplicate to 3
      const deduped = deduplicate(allItems, 3);

      // Generate AI (3 items × 4s = ~12s max, with res.end() first)
      for (const item of deduped) {
        try {
          item.ai = await generateAI(item.title);
        } catch(e) {
          item.ai = { 知识点: ['生成失败'], 怎么考: ['生成失败'], 案例积累: '' };
        }
      }

      // Save to Redis
      const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
      const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
      const payload = { date: targetLabel, items: deduped, generatedAt: new Date().toISOString() };

      try {
        await fetch(`${redisUrl}/set/news:${targetDate}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${redisToken}` },
          body: JSON.stringify(JSON.stringify(payload)),
        });
      } catch(e) {}

      res.status(200).json({ success: true, count: deduped.length, date: targetDate });

    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
};

function fetchNews(sourceId, limit) {
  return new Promise((resolve) => {
    const req = https.get(`https://newsnow.busiyi.world/api/s?id=${sourceId}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 4000,
    }, (pr) => {
      if (pr.statusCode >= 400) { resolve([]); return; }
      let data = '';
      pr.on('data', chunk => data += chunk);
      pr.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve((json.items || []).slice(0, limit).map((item, idx) => ({
            id: `${sourceId}-${item.id || idx}`, title: item.title,
            url: item.url || item.mobileUrl || '#', rank: idx + 1, platform: sourceId,
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
    const norm = item.title.trim().toLowerCase();
    let dupe = false;
    for (const sel of selected) {
      if (similarity(norm, sel.title.trim().toLowerCase()) > 0.6) { dupe = true; break; }
    }
    if (!dupe) selected.push(item);
  }
  return selected;
}

function similarity(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const setA = new Set(a.split('')), setB = new Set(b.split(''));
  const inter = [...setA].filter(c => setB.has(c)).length;
  return inter / (setA.size + setB.size - inter);
}

function generateAI(title) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      model: 'MiniMax-M2.7',
      messages: [
        { role: 'system', content: '你是新传考研专家。格式：涉及知识点 / 怎么考(4点) / 一句话案例积累' },
        { role: 'user', content: `热点：${title}\n\n格式：\n涉及知识点\n怎么考\n一句话案例积累` },
      ],
      max_tokens: 400, temperature: 0.7,
    });
    const req = https.request({
      hostname: 'api.minimaxi.chat', path: '/v1/text/chatcompletion_v2', method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.MINIMAX_API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 4000,
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
  const k = content.match(/涉及知识点[:：]?([\s\S]*?)(?=怎么考)/i);
  if (k) result.知识点 = k[1].split(/\n/).map(s => s.replace(/^[-*·\s]+/, '').trim()).filter(s => s && s.length > 1 && s.length < 30).slice(0, 5);
  const p = content.match(/怎么考[:：]?([\s\S]*?)(?=一句话案例积累)/i);
  if (p) result.怎么考 = p[1].split(/\n/).map(s => s.replace(/^\d+[.、：:：]\s*/, '').trim()).filter(s => s && s.length > 5).slice(0, 4);
  const c = content.match(/一句话案例积累[:：]?\n*([\s\S]*)$/i);
  if (c) result.案例积累 = c[1].replace(/^[-*·\s]+/, '').trim();
  if (result.知识点.length === 0) result.知识点 = ['待补充'];
  if (result.怎么考.length === 0) result.怎么考 = ['待补充'];
  return result;
}