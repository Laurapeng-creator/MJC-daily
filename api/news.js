module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  const sourceId = req.query.id || 'weibo';
  const limit = parseInt(req.query.limit) || 5;
  const targetUrl = `https://newsnow.busiyi.world/api/s?id=${sourceId}`;

  return new Promise((resolve) => {
    const https = require('https');
    https.get(targetUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
      timeout: 8000,
    }, (pr) => {
      if (pr.statusCode >= 400) {
        resolve(res.status(502).json({ error: 'upstream error', status: pr.statusCode }));
        return;
      }
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
          resolve(res.status(200).json({ items }));
        } catch (e) {
          resolve(res.status(502).json({ error: 'parse error' }));
        }
      });
    }).on('error', (e) => {
      resolve(res.status(502).json({ error: e.message }));
    });
  });
};