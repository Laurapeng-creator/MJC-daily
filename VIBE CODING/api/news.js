const https = require('https');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  const sourceId = req.query.id || 'weibo';
  const limit = parseInt(req.query.limit) || 5;

  const targetUrl = `https://newsnow.busiyi.world/api/s?id=${sourceId}`;

  https.get(targetUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; MJC-Daily/1.0)',
      'Accept': 'application/json',
    },
    timeout: 8000,
  }, (pr) => {
    if (pr.statusCode >= 400) {
      res.writeHead(502);
      res.end(JSON.stringify({ error: 'upstream error', status: pr.statusCode }));
      return;
    }

    let data = '';
    pr.on('data', chunk => data += chunk);
    pr.on('end', () => {
      try {
        const json = JSON.parse(data);
        if (!json.items) {
          res.writeHead(200);
          res.end(JSON.stringify({ items: [] }));
          return;
        }
        const items = json.items.slice(0, limit).map((item, idx) => ({
          id: `${sourceId}-${item.id || idx}`,
          title: item.title,
          url: item.url || item.mobileUrl || '#',
          rank: idx + 1,
          platform: sourceId,
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ items }));
      } catch (e) {
        res.writeHead(502);
        res.end(JSON.stringify({ error: 'parse error' }));
      }
    });
  }).on('error', (e) => {
    res.writeHead(502);
    res.end(JSON.stringify({ error: e.message }));
  });
};