const https = require('https');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).end();

  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    try {
      const { password, date } = JSON.parse(body);

      // Validate password
      if (password !== process.env.EDIT_PASSWORD) {
        return res.status(401).json({ error: '密码错误' });
      }

      const targetDate = date || new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      const targetLabel = `${new Date(targetDate).getFullYear()}年${new Date(targetDate).getMonth()+1}月${new Date(targetDate).getDate()}日`;

      // 1. Fetch news from all sources
      const sources = { weibo: 2, zhihu: 2, thepaper: 1 };
      const allItems = [];

      for (const [sourceId, limit] of Object.entries(sources)) {
        const items = await fetchNews(sourceId, limit);
        allItems.push(...items);
      }

      if (allItems.length === 0) {
        return res.status(200).json({ success: false, error: '无热点数据' });
      }

      // 2. Deduplicate by title similarity
      const deduped = deduplicate(allItems, 5);

      // 3. Generate AI for each item (with rate limit)
      for (const item of deduped) {
        item.ai = await generateAI(item.title);
        await new Promise(r => setTimeout(r, 1000));
      }

      // 4. Save to Redis
      const payload = { date: targetLabel, items: deduped, generatedAt: new Date().toISOString() };
      const saveRes = await fetch(`${process.env.UPSTASH_REDIS_REST_URL}/set/news:${targetDate}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(JSON.stringify(payload)),
      });

      if (!saveRes.ok) {
        return res.status(502).json({ error: 'Redis save failed' });
      }

      return res.status(200).json({ success: true, count: deduped.length, date: targetDate });

    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });
};

// ---- helpers ----

function fetchNews(sourceId, limit) {
  return new Promise((resolve) => {
    const targetUrl = `https://newsnow.busiyi.world/api/s?id=${sourceId}`;
    https.get(targetUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
      timeout: 8000,
    }, (pr) => {
      if (pr.statusCode >= 400) { resolve([]); return; }
      let data = '';
      pr.on('data', chunk => data += chunk);
      pr.on('end', () => {
        try {
          const json = JSON.parse(data);
          const items = (json.items || []).slice(0, limit).map((item, idx) => ({
            id: `${sourceId}-${item.id || idx}`,
            title: item.title,
            url: item.url || item.mobileUrl || '#',
            rank: idx + 1,
            platform: sourceId,
          }));
          resolve(items);
        } catch (e) { resolve([]); }
      });
    }).on('error', () => resolve([]));
  });
}

function deduplicate(items, targetCount) {
  const selected = [];
  const used = new Set();

  // Sort by platform priority: weibo > zhihu > thepaper
  const priority = { weibo: 0, zhihu: 1, thepaper: 2 };
  items.sort((a, b) => priority[a.platform] - priority[b.platform]);

  for (const item of items) {
    if (selected.length >= targetCount) break;

    const normalized = item.title.trim().toLowerCase();
    let isDupe = used.has(normalized);

    // Check similarity with already selected items
    if (!isDupe) {
      for (const sel of selected) {
        if (similarity(normalized, sel.title.trim().toLowerCase()) > 0.6) {
          isDupe = true;
          break;
        }
      }
    }

    if (!isDupe) {
      selected.push({ ...item, title: item.title });
      used.add(normalized);
    }
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

const AI_SYSTEM_PROMPT = `你是一位新传考研辅导专家，熟悉北大新传考研出题风格与高频考点。每次收到一条新闻热点，按以下格式输出分析，严格遵守评判标准。

输出格式：
涉及知识点：（精准、专业、不超纲，优先使用新传核心概念，不超过5个）
怎么考：（4个论点，按隐含逻辑展开：1.界定本质 2.结构性成因 3.深层影响 4.应对路径。需具备知识迁移能力，有辩证张力）
一句话案例积累：（格式：【核心观点】，如/以XX事件为例，【事件与理论的具体关联】，直接可用于答题）

过滤标准：纯娱乐八卦、明星私生活、体育赛事结果、与公共议题无关的社会新闻直接跳过不输出。
合格内容：涉及公共议题、政策变化、技术发展、社会结构性事件。`;

const AI_USER_PROMPT = `热点：{title}

请按以下格式输出：
涉及知识点
怎么考
一句话案例积累`;

async function generateAI(title) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      model: 'MiniMax-M2.7',
      messages: [
        { role: 'system', content: AI_SYSTEM_PROMPT },
        { role: 'user', content: AI_USER_PROMPT.replace('{title}', title) },
      ],
      max_tokens: 1500,
      temperature: 0.7,
    });

    const apiUrl = new URL('https://api.minimaxi.chat/v1/text/chatcompletion_v2');
    const options = {
      hostname: apiUrl.hostname,
      path: apiUrl.pathname,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.MINIMAX_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    };

    const req = https.request(options, (pr) => {
      let data = '';
      pr.on('data', chunk => data += chunk);
      pr.on('end', () => {
        try {
          const json = JSON.parse(data);
          const content = json.choices?.[0]?.message?.content || json.output || '';
          if (!content) { resolve({ 知识点: ['生成失败'], 怎么考: ['生成失败'], 案例积累: '' }); return; }
          resolve(parseAI(content));
        } catch (e) { resolve({ 知识点: ['生成失败'], 怎么考: ['生成失败'], 案例积累: '' }); }
      });
    });

    req.on('error', () => resolve({ 知识点: ['生成失败'], 怎么考: ['生成失败'], 案例积累: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ 知识点: ['生成失败'], 怎么考: ['生成失败'], 案例积累: '' }); });
    req.write(payload);
    req.end();
  });
}

function parseAI(content) {
  const result = { 知识点: [], 怎么考: [], 案例积累: '' };

  const kSection = content.match(/涉及知识点[:：]?([\s\S]*?)(?=怎么考)/i);
  if (kSection) {
    result.知识点 = kSection[1].split(/\n/)
      .map(s => s.replace(/^[-*·\s]+/, '').trim())
      .filter(s => s && s.length > 1 && s.length < 30)
      .slice(0, 5);
  }

  const pSection = content.match(/怎么考[:：]?([\s\S]*?)(?=一句话案例积累)/i);
  if (pSection) {
    result.怎么考 = pSection[1].split(/\n/)
      .map(s => s.replace(/^\d+[.、：:：]\s*/, '').trim())
      .filter(s => s && s.length > 5)
      .slice(0, 4);
  }

  const cSection = content.match(/一句话案例积累[:：]?\n*([\s\S]*)$/i);
  if (cSection) {
    result.案例积累 = cSection[1].replace(/^[-*·\s]+/, '').trim();
  }

  if (result.知识点.length === 0) result.知识点 = ['待补充'];
  if (result.怎么考.length === 0) result.怎么考 = ['待补充'];

  return result;
}