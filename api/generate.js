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

      // Fetch 1 from each source
      const allItems = [];
      for (const [sourceId, limit] of [['weibo',3],['zhihu',3],['thepaper',2]]) {
        try { const r = await fetchNews(sourceId, limit); allItems.push(...r); } catch(e) {}
      }

      if (allItems.length === 0) {
        res.status(200).json({ success: false, error: '无热点数据' });
        return;
      }

      // Deduplicate to 3
      const deduped = deduplicate(allItems, 3);

      // Generate AI
      console.log('开始生成AI分析，目标日期:', targetDate);
      for (const item of deduped) {
        try {
          console.log('正在分析:', item.title);
          item.ai = await generateAI(item.title);
          console.log('AI结果:', item.title, '->', JSON.stringify(item.ai));
        } catch(e) {
          console.log('AI异常:', item.title, e.message);
          item.ai = { 知识点: ['待补充'], 怎么考: ['待补充'], 案例积累: '' };
        }
      }
      console.log('AI分析完成');

      // Save to Redis
      const payload = { date: targetLabel, items: deduped, generatedAt: new Date().toISOString() };
      const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
      const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

      try {
        await fetch(`${redisUrl}/set/news:${targetDate}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${redisToken}` },
          body: JSON.stringify(payload),
        });
      } catch(e) {}

      // Return the full data directly so frontend can use it
      res.status(200).json({ success: true, count: deduped.length, date: targetDate, items: deduped, dateLabel: targetLabel });

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
        { role: 'system', content: `你是一位新传考研辅导专家，熟悉北大新传考研出题风格与高频考点。\n分析热点事件，严格按以下JSON格式返回，不要有任何其他文字，不要有markdown代码块：\n{\n  "知识点": ["知识点1", "知识点2", "知识点3"],\n  "怎么考": ["论点1", "论点2", "论点3", "论点4"],\n  "案例积累": "观点前置的一句话案例"\n}\n\n评判标准：\n知识点：精准专业不超纲，不超过5个，优先用算法权力/数字劳动/把关机制/平台公共性等核心概念\n怎么考4个论点依次是：1.界定本质 2.结构性成因 3.深层影响 4.应对路径\n论点要有知识迁移能力，整组要有辩证张力\n案例积累格式：【核心观点】，如XX事件所示，【事件与理论的具体关联】\n\n过滤标准：纯娱乐八卦/明星私生活/体育赛事直接返回null` },
        { role: 'user', content: `请分析这个新传热点：${title}` },
      ],
      max_tokens: 1000, temperature: 0.7,
    });
    console.log('发给MiniMax的请求:', payload);
    const req = https.request({
      hostname: 'api.minimaxi.chat', path: '/v1/text/chatcompletion_v2', method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.MINIMAX_API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 25000,
    }, (pr) => {
      let data = '';
      pr.on('data', chunk => data += chunk);
      pr.on('end', () => {
        try {
          const json = JSON.parse(data);
          console.log('MiniMax raw response:', JSON.stringify(json).slice(0, 300));
          const content = json.choices?.[0]?.message?.content || json.output || '';
          resolve(content ? parseAI(content) : defaultAI());
        } catch (e) {
          console.log('MiniMax parse error:', e.message, 'data:', data.slice(0, 200));
          resolve(defaultAI());
        }
      });
    });
    req.on('error', (e) => { console.log('MiniMax请求错误:', e.message); resolve(defaultAI()); });
    req.on('timeout', () => { console.log('MiniMax请求超时'); req.destroy(); resolve(defaultAI()); });
    req.write(payload);
    req.end();
  });
}

function defaultAI() { return { 知识点: ['待补充'], 怎么考: ['待补充'], 案例积累: '' }; }

function parseAI(content) {
  // Try to parse as JSON first (new format)
  try {
    const parsed = JSON.parse(content);
    if (parsed && Array.isArray(parsed.知识点) && Array.isArray(parsed.怎么考)) {
      return {
        知识点: parsed.知识点.slice(0, 5),
        怎么考: parsed.怎么考.slice(0, 4),
        案例积累: parsed.案例积累 || '',
      };
    }
  } catch(e) {}

  // Fallback: old text format parsing
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