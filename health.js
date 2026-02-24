// api/health.js
export default async function handler(req, res) {
  const checks = {
    seedPhrase:       !!process.env.MASTER_SEED_PHRASE,
    solanaRpc:        !!process.env.SOLANA_RPC_URL,
    nftStorage:       !!process.env.NFT_STORAGE_KEY,
    personalWallet:   !!process.env.PERSONAL_WALLET_PUBLIC_KEY,
    upstashUrl:       !!process.env.dayafterday_KV_REST_API_URL,
    upstashToken:     !!process.env.dayafterday_KV_REST_API_TOKEN,
  };

  const allOk = Object.values(checks).every(Boolean);

  // Try Redis ping
  let redisPing = false;
  try {
    const { redis } = await import('../lib/redis.js');
    await redis.set('health-ping', '1', 10);
    const val = await redis.get('health-ping');
    redisPing = val === '1';
  } catch {}

  res.status(allOk ? 200 : 500).json({
    status: allOk ? 'ok' : 'degraded',
    project: 'Day After Day',
    artist: 'lampwrecked',
    year: 2026,
    checks,
    redis: redisPing ? 'connected' : 'error',
    endpoints: [
      'POST /api/upload    — upload media to IPFS',
      'POST /api/session   — create mint session + unique payment address',
      'GET  /api/poll/:id  — poll payment status, auto-mint on confirmation',
      'GET  /api/health    — this endpoint',
    ],
  });
}
