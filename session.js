// api/session.js
// POST /api/session
// Called when user opens the mint window.
// Creates a unique derived payment address for this specific output.
// Returns sessionId + payment address + amount.

import { redis } from '../lib/redis.js';
import { getMasterKeypair, getSessionKeypair } from '../lib/wallet.js';
import { getConnection, initUsdcAta, fundDerivedWallet, REQUIRED_USDC } from '../lib/solana.js';

// Session expires after 30 minutes
const SESSION_TTL = 60 * 30;

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const {
      outputType,   // 'photo' | 'audio' | 'video'
      metadata,     // { answers, mode, speed, zones, name }
    } = req.body;

    if (!outputType) return res.status(400).json({ error: 'Missing outputType' });
    if (!metadata)   return res.status(400).json({ error: 'Missing metadata' });

    // Get next session index (atomic increment — never reuses an address)
    const sessionIndex = await redis.incr('day-after-day:session-counter');

    // Derive unique keypair for this session
    const masterKeypair  = await getMasterKeypair();
    const sessionKeypair = await getSessionKeypair(sessionIndex);
    const paymentAddress = sessionKeypair.publicKey.toBase58();

    // Build session record
    const sessionId = `sess_${sessionIndex}_${Date.now()}`;
    const session = {
      sessionId,
      sessionIndex,
      paymentAddress,
      outputType,
      metadata,
      status: 'pending',        // pending → paid → minted → swept
      createdAt: Date.now(),
      expiresAt: Date.now() + SESSION_TTL * 1000,
      requiredUsdc: REQUIRED_USDC,
      buyerWallet: null,        // filled in when payment detected
      mintAddress: null,        // filled in after mint
      mintSignature: null,
      sweepSignature: null,
    };

    // Store session in Redis
    await redis.set(`session:${sessionId}`, session, SESSION_TTL);
    // Also index by payment address for fast polling lookup
    await redis.set(`address:${paymentAddress}`, sessionId, SESSION_TTL);

    // Fund the derived wallet with SOL so it can receive USDC
    // This initializes the Associated Token Account
    const connection = getConnection();
    try {
      await fundDerivedWallet(connection, masterKeypair, sessionKeypair.publicKey);
      await initUsdcAta(connection, masterKeypair, sessionKeypair);
    } catch (fundErr) {
      console.error('ATA init error:', fundErr);
      // Non-fatal — wallet may already be funded or RPC hiccup
      // Session still valid, USDC may still arrive
    }

    return res.status(200).json({
      success: true,
      sessionId,
      paymentAddress,
      requiredUsdc: REQUIRED_USDC,
      amountDisplay: '$2.25 USDC',
      expiresAt: session.expiresAt,
      network: 'solana-mainnet',
      usdcMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      note: 'Include session ID in transaction memo for fastest processing',
    });

  } catch (err) {
    console.error('Session creation error:', err);
    return res.status(500).json({ error: err.message });
  }
}
