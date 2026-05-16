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

      const targetDate = date || new Date().toISOString().slice(0, 10);
      const targetLabel = `${new Date(targetDate).getFullYear()}年${new Date(targetDate).getMonth()+1}月${new Date(targetDate).getDate()}日`;
      const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
      const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

      // 配置项：Hobby版4条不超时，Pro可改回6
      const NEWS_PER_PLATFORM = 1;
      const sources = [['weibo',NEWS_PER_PLATFORM],['zhihu',NEWS_PER_PLATFORM],['thepaper',1],['tencent',1]];

      // 获取热点
      const allItems = [];
      for (const [sourceId, limit] of sources) {
        try { const r = await fetchNews(sourceId, limit); if (r.length > 0) allItems.push(...r); } catch(e) {}
      }

      if (allItems.length === 0) {
        res.status(200).json({ success: false, error: '无热点数据' });
        return;
      }

      // 字符相似度去重，目标4条
      const deduped = deduplicate(allItems, 4);

      // AI分析 - 分两批并行（各2条）
      const batch1 = deduped.slice(0, 2).map(item => generateAI(item.title).catch(() => null));
      const batch2 = deduped.slice(2, 4).map(item => generateAI(item.title).catch(() => null));
      const [r1, r2] = await Promise.all([Promise.all(batch1), Promise.all(batch2)]);
      const aiResults = [...r1, ...r2];

      // 过滤掉娱乐内容
      const validItems = deduped.filter((item, idx) => {
        item.ai = aiResults[idx];
        return item.ai !== null;
      });

      if (validItems.length === 0) {
        res.status(200).json({ success: false, error: '未找到符合新传考研要求的热点内容' });
        return;
      }

      const finalItems = validItems;

      // 保存到Redis
      const payload = { date: targetLabel, items: finalItems, generatedAt: new Date().toISOString() };
      await fetch(`${redisUrl}/set/news:${targetDate}?ex=2592000`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${redisToken}` },
        body: JSON.stringify(payload),
      });

      res.status(200).json({ success: true, count: finalItems.length, date: targetDate, items: finalItems, dateLabel: targetLabel });

    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
};

function fetchNews(sourceId, limit) {
  return new Promise((resolve) => {
    const req = https.get(`https://newsnow.busiyi.world/api/s?id=${sourceId}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 3000,
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
  const priority = { weibo: 0, zhihu: 1, thepaper: 2, tencent: 3 };
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
        { role: 'system', content: `你是一位新传考研辅导专家，熟悉北大新传考研出题风格与高频考点。\n分析热点事件，严格按以下JSON格式返回，不要有任何其他文字，不要有markdown代码块：\n{\n  "知识点": ["知识点1", "知识点2", "知识点3"],\n  "怎么考": ["论点1", "论点2", "论点3", "论点4"],\n  "案例积累": "观点前置的一句话案例"\n}\n\n评判标准：\n知识点：精准专业不超纲，不超过5个，优先用算法权力/数字劳动/把关机制/平台公共性等核心概念\n怎么考4个论点依次是：1.界定本质 2.结构性成因 3.深层影响 4.应对路径\n论点要有知识迁移能力，整组要有辩证张力\n案例积累格式：【核心观点】，如XX事件所示，【事件与理论的具体关联】\n\n过滤标准：纯娱乐八卦/明星私生活/体育赛事直接返回null` },
        { role: 'user', content: `请分析这个新传热点：${title}` },
      ],
      max_tokens: 1000, temperature: 0.7,
    });
    const req = https.request({
      hostname: 'api.minimaxi.chat', path: '/v1/text/chatcompletion_v2', method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.MINIMAX_API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 12000,
    }, (pr) => {
      let data = '';
      pr.on('data', chunk => data += chunk);
      pr.on('end', () => {
        try {
          const json = JSON.parse(data);
          const content = json.choices?.[0]?.message?.content || json.output || '';
          const result = parseAI(content);
          resolve(result); // parseAI returns null if should be filtered
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
  // 过滤：返回null表示跳过此条
  if (!content || content === 'null' || content.trim() === '') return null;
  try {
    const parsed = JSON.parse(content);
    if (parsed === null) return null;
    if (parsed && Array.isArray(parsed.知识点) && Array.isArray(parsed.怎么考)) {
      const hasValidContent = parsed.知识点.some(k => k && k.includes('待补充') === false && k.length > 1);
      if (!hasValidContent) return null;
      return {
        知识点: parsed.知识点.slice(0, 5),
        怎么考: parsed.怎么考.slice(0, 4),
        案例积累: parsed.案例积累 || '',
      };
    }
  } catch(e) {}
  return defaultAI();
}