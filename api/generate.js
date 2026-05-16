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
      const jobId = `job_${Date.now()}`;

      const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
      const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

      res.status(200).json({ status: 'processing', jobId, message: '已开始生成，请稍候' });
      processGenerate(targetDate, targetLabel, jobId, redisUrl, redisToken);

    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
};

async function processGenerate(targetDate, targetLabel, jobId, redisUrl, redisToken) {
  try {
    await saveStatus(jobId, { status: 'processing', progress: '正在获取热点数据...' });

    // 获取热点：微博2/知乎2/澎湃1/腾讯1
    const allItems = [];
    const sources = [
      ['weibo', 2], ['zhihu', 2], ['thepaper', 1], ['tencent', 1]
    ];
    for (const [sourceId, limit] of sources) {
      try {
        const r = await fetchNews(sourceId, limit);
        if (r.length > 0) allItems.push(...r);
      } catch(e) {}
    }

    if (allItems.length === 0) {
      await saveStatus(jobId, { status: 'error', error: '无热点数据' });
      return;
    }

    // 第一步：字符相似度去重（宽松），保留候选
    const afterCharDedup = deduplicate(allItems, 10);

    await saveStatus(jobId, { status: 'processing', progress: '正在进行AI分析...' });

    // 第二步：AI分析 + 过滤 + 收集有效条目
    const validItems = [];
    for (const item of afterCharDedup) {
      try {
        item.ai = await generateAI(item.title);
      } catch(e) {
        item.ai = null;
      }
      // 过滤：item.ai === null 表示娱乐内容，跳过
      if (item.ai !== null) {
        validItems.push(item);
      }
    }

    // 第三步：若有效条目超过6条，用AI做二次去重合并
    const finalItems = validItems.length > 6
      ? await aiDeduplicate(validItems)
      : validItems;

    if (finalItems.length === 0) {
      await saveStatus(jobId, { status: 'error', error: '未找到符合新传考研要求的热点内容' });
      return;
    }

    const payload = { date: targetLabel, items: finalItems, generatedAt: new Date().toISOString() };
    await fetch(`${redisUrl}/set/news:${targetDate}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${redisToken}` },
      body: JSON.stringify(payload),
    });

    await saveStatus(jobId, { status: 'done', count: finalItems.length, date: targetDate });

  } catch(e) {
    await saveStatus(jobId, { status: 'error', error: e.message });
  }
}

async function aiDeduplicate(items) {
  // 用AI判断哪些是同一事件的不同报道，合并成一条
  const titles = items.map((item, idx) => `${idx + 1}. ${item.title}`).join('\n');
  const prompt = `以下是来自不同平台的热点标题，请将属于同一事件的不同角度报道合并成一条，选用最有新传分析价值的标题。\n输出一行一个，用 | 分隔合并后的标题和原始标题，格式：合并后标题 | 原标题1 | 原标题2\n\n${titles}`;

  return new Promise((resolve) => {
    const payload = JSON.stringify({
      model: 'MiniMax-M2.7',
      messages: [
        { role: 'system', content: '你是一个新闻去重专家，负责判断哪些热点属于同一事件的不同角度报道。严格按指定格式输出，不要其他文字。' },
        { role: 'user', content: prompt },
      ],
      max_tokens: 600, temperature: 0.3,
    });
    const req = https.request({
      hostname: 'api.minimaxi.chat', path: '/v1/text/chatcompletion_v2', method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.MINIMAX_API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 15000,
    }, (pr) => {
      let data = '';
      pr.on('data', chunk => data += chunk);
      pr.on('end', () => {
        try {
          const json = JSON.parse(data);
          const content = json.choices?.[0]?.message?.content || json.output || '';
          // 按行解析AI返回的合并建议
          const lines = content.split('\n').filter(l => l.trim() && l.includes('|'));
          const mergeMap = {};
          const usedIndices = new Set();
          for (const line of lines) {
            const parts = line.split('|').map(p => p.trim());
            if (parts.length >= 2) {
              const keepTitle = parts[0];
              for (let i = 1; i < parts.length; i++) {
                const orig = parts[i];
                const idx = items.findIndex(it => it.title === orig);
                if (idx !== -1 && !usedIndices.has(idx)) {
                  mergeMap[idx] = keepTitle;
                  usedIndices.add(idx);
                }
              }
            }
          }
          // 构建去重后的列表：保留未被合并的条目，被合并的条目标记合并到哪条
          const result = [];
          const mergedInto = {};
          for (let i = 0; i < items.length; i++) {
            if (mergeMap[i] !== undefined) {
              mergedInto[i] = mergeMap[i];
            } else if (!usedIndices.has(i)) {
              result.push(items[i]);
            }
          }
          resolve(result.slice(0, 6));
        } catch (e) { resolve(items.slice(0, 6)); }
      });
    });
    req.on('error', () => resolve(items.slice(0, 6)));
    req.on('timeout', () => { req.destroy(); resolve(items.slice(0, 6)); });
    req.write(payload);
    req.end();
  });
}

async function saveStatus(jobId, data) {
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  try {
    await fetch(`${redisUrl}/set/${jobId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${redisToken}` },
      body: JSON.stringify(data),
    });
  } catch(e) {}
}

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
        { role: 'system', content: `你是一位新传考研辅导专家，熟悉北大新传考研出题风格与高频考点。每次收到一条新闻热点，按以下格式输出分析，严格遵守评判标准。\n\n输出格式：\n涉及知识点\n怎么考（4个论点）\n一句话案例积累\n\n评判标准：\n涉及知识点：精准、专业、不超纲（优先使用新传核心概念，如算法权力、数字劳动、把关机制、平台公共性等），不超过5个，避免太泛（如"传播学"）或太偏（冷门学派概念）\n怎么考（4个论点）：按以下隐含逻辑依次展开：\n1.界定本质：这一现象的学术命题是什么？（抽象为理论问题）\n2.结构性成因：不复述事件，找深层驱动力（技术/制度/资本/文化）\n3.深层影响：延伸到权力、制度、用户层面\n4.应对路径：个体或社会层面如何应对\n论点要求：具备知识迁移能力，能从这一事件迁移到同类现象，不就事论事；辩证张力：整组论点需有张力，不单一；若事件整体积极，在影响或应对层追问潜在风险；若事件整体消极，在成因或应对层指出制度性意义或改革空间；辩证思考需自然融入论点，不生硬强凑\n一句话案例积累：格式：【核心观点（一句学术判断）】，如/以XX事件为例，【事件与理论的具体关联】；要求：直接可用于答题，包含事件与理论的真实连接，不仅概括事件\n\n过滤标准（以下类型直接跳过，不输出分析）：纯娱乐八卦、明星私生活、体育赛事结果、与公共议题无关的社会新闻\n合格内容：涉及公共议题、政策变化、技术发展、社会结构性事件\n\n输出示例：\n【示例1：携程被市场监管总局正式立案调查】\n热点：携程被市场监管总局正式立案调查\n涉及知识点：算法权力、平台垄断、数据治理、平台公共性、监管范式转型\n怎么考：\n1.大数据差异化定价的本质是平台将信息不对称转化为经济剥削的结构性机制，而非个案技术失误，这一逻辑同样适用于分析外卖抽佣、内容推荐降权等平台行为\n2.平台垄断的形成并非源于单一企业的主观恶意，而是网络效应与数据飞轮共同驱动的市场自然集中，这是数字经济区别于传统反垄断逻辑的结构性特征\n3.反垄断执法介入平台经济标志着平台治理从行业自律转向国家主动规制，其深层动因是平台公共性与商业性长期张力的制度性激化——当平台掌握准公共基础设施却按私人利益运营，监管介入具有必然性\n4.平台治理的根本困境在于监管工具的滞后性，现有法律框架难以追上算法迭代速度，未来的治理路径需要从事后惩罚转向算法审计与数据透明度的事前嵌入\n一句话案例积累：\n算法不是中立的技术工具，而是平台将数据优势转化为市场权力的执行机制，携程立案事件表明平台的商业理性与用户权益之间存在结构性冲突，国家监管介入是数字经济中恢复权力平衡的制度性必要而非例外\n\n【示例2：315大模型被投毒事件】\n热点：315大模型被投毒事件\n涉及知识点：信息污染、把关机制重构、算法公信力、GEO、拟态环境\n怎么考：\n1.训练数据污染区别于传统虚假信息的核心在于：它不在传播末端制造噪音，而是在信息生产源头植入系统性偏差，偏差随模型输出被无限复制，传统事实核查机制对此几乎失效\n2.GEO的兴起揭示了一个结构性转变：信息生产者的优化目标已从影响人的注意力转向影响AI的训练权重，商业利益渗透语料的动机与渗透媒体议程的动机同源，只是作用层次更深、更难被察觉\n3.当用户将AI输出视为客观事实而非经过利益过滤的内容，AI的权威感会系统性压制批判性信息核查，由此构建的拟态环境比传统媒体更难被识别和挑战，认知风险随信任转移而放大\n4.AI时代重建信息可信度需要双轨并行：技术层建立训练数据的溯源与第三方审计机制，用户层培育针对AI生成内容的批判性素养；同时需警惕监管本身被商业利益捕获的风险，制度设计的独立性同样关键\n一句话案例积累：\nAI内容的可信度危机根植于训练数据被商业利益污染的结构性问题而非单次输出偏差，315投毒事件表明拟态环境的建构权已从媒体机构转移至掌控语料的利益主体，且这一转移对普通用户几乎不可见\n\n【示例3：OpenClaw热潮】\n热点：OpenClaw热潮\n涉及知识点：AI Agent、传播主体重构、行为数据、数字劳动、数字主体性\n怎么考：\n1.AI Agent与生成式AI的根本差异不在于能力强弱，而在于角色性质——从内容输出者变为行为代理人，当AI开始替人执行决策与任务，人作为传播主体的边界被实质性重构，这一变化对理解未来人机传播关系具有范式意义\n2.用户主动拥抱Agent并让渡行为数据，并非源于无知，而是即时效率收益在感知上系统性压倒长期隐私风险的结果，平台通过降低使用门槛、强化即时反馈精心维持这一感知落差\n3.Agent采集的数据已从内容偏好升级为决策路径与行动轨迹，平台对用户的理解从他喜欢什么深入到他如何思考与行动，数据权力的渗透层次发生质变；但另一面，Agent也有潜力通过承担重复性认知劳动释放人的创造性，技术本身具有双重可能\n4.个体在Agent时代维护数字主体性的核心不是拒绝使用，而是保持元认知自觉——持续追问哪些判断可以外包给算法、哪些自主权不应让渡，这是数字素养在行为代理时代的具体要求\n一句话案例积累：\nAI Agent将人机关系从工具使用推进至行为托管，OpenClaw热潮表明平台的数据控制已从内容层下沉至行动层，传播权力的争夺重心正在从影响认知转向直接介入决策，而用户对这一转变的感知几乎滞后于其实际发生` },
        { role: 'user', content: `请分析这个新传热点：${title}` },
      ],
      max_tokens: 1200, temperature: 0.7,
    });
    const req = https.request({
      hostname: 'api.minimaxi.chat', path: '/v1/text/chatcompletion_v2', method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.MINIMAX_API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 20000,
    }, (pr) => {
      let data = '';
      pr.on('data', chunk => data += chunk);
      pr.on('end', () => {
        try {
          const json = JSON.parse(data);
          const content = json.choices?.[0]?.message?.content || json.output || '';
          const result = parseAI(content);
          resolve(result === null ? null : result);
        } catch (e) { resolve(defaultAI()); }
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
  if (!content || content === 'null' || content.trim() === '') return null;
  try {
    const parsed = JSON.parse(content);
    if (parsed === null || (typeof parsed === 'object' && parsed !== null && parsed.length === 0)) return null;
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