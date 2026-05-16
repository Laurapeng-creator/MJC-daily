module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const jobId = req.query.job;
  if (!jobId) return res.status(400).json({ error: 'no job id' });

  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  const r = await fetch(`${redisUrl}/get/${jobId}`, {
    headers: { Authorization: `Bearer ${redisToken}` },
  });
  const data = await r.json();
  const status = data.result ? JSON.parse(data.result) : { status: 'not_found' };
  res.status(200).json(status);
};