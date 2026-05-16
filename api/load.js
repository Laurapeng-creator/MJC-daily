const https = require('https');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!redisUrl || !redisToken) {
    return res.status(500).json({ error: 'Redis not configured' });
  }

  const redisRes = await fetch(`${redisUrl}/get/news:${date}`, {
    headers: { Authorization: `Bearer ${redisToken}` },
  });

  if (!redisRes.ok) {
    return res.status(502).json({ error: 'Redis read error' });
  }

  const redisData = await redisRes.json();
  if (!redisData.result || redisData.result === 'null') {
    return res.status(200).json({ date, items: [] });
  }

  try {
    const data = JSON.parse(redisData.result);
    return res.status(200).json(data);
  } catch (e) {
    return res.status(502).json({ error: 'parse error' });
  }
};