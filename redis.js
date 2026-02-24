// lib/redis.js
// Upstash Redis client using the Vercel-injected env vars
// Vercel injected these with the dayafterday_ prefix from Upstash

const BASE_URL  = process.env.dayafterday_KV_REST_API_URL;
const TOKEN     = process.env.dayafterday_KV_REST_API_TOKEN;

if (!BASE_URL || !TOKEN) {
  console.warn('Redis env vars missing — sessions will not persist');
}

async function redisRequest(args) {
  const res = await fetch(`${BASE_URL}/${args.map(encodeURIComponent).join('/')}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const json = await res.json();
  if (json.error) throw new Error(`Redis error: ${json.error}`);
  return json.result;
}

async function redisPost(command, ...args) {
  const res = await fetch(`${BASE_URL}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([command, ...args]),
  });
  const json = await res.json();
  if (json.error) throw new Error(`Redis error: ${json.error}`);
  return json.result;
}

export const redis = {
  async get(key) {
    return redisRequest(['GET', key]);
  },

  async set(key, value, exSeconds) {
    const val = typeof value === 'object' ? JSON.stringify(value) : String(value);
    if (exSeconds) {
      return redisPost('SET', key, val, 'EX', String(exSeconds));
    }
    return redisPost('SET', key, val);
  },

  async incr(key) {
    return redisPost('INCR', key);
  },

  async del(key) {
    return redisPost('DEL', key);
  },

  async getJson(key) {
    const raw = await redisRequest(['GET', key]);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return raw; }
  },
};
