// lib/wallet.js
// HD wallet derivation from seed phrase
// BIP44 path: m/44'/501'/index'/0'  (Solana standard)

import { Keypair } from '@solana/web3.js';
import { derivePath } from 'ed25519-hd-key';
import * as bip39 from 'bip39';

/**
 * Derive a child keypair from the master seed phrase at a given index.
 * Each session gets a unique index — stored in Redis alongside the session.
 */
export async function deriveKeypair(index) {
  const mnemonic = process.env.MASTER_SEED_PHRASE;
  if (!mnemonic) throw new Error('MASTER_SEED_PHRASE not configured');

  const seed = await bip39.mnemonicToSeed(mnemonic);
  const path = `m/44'/501'/${index}'/0'`;
  const { key } = derivePath(path, seed.toString('hex'));
  return Keypair.fromSeed(key);
}

/**
 * Derive the master keypair (index 0) — used for minting and sweeping.
 */
export async function getMasterKeypair() {
  return deriveKeypair(0);
}

/**
 * Get a session keypair — unique per mint session.
 * Index is stored in Redis so we never reuse the same address.
 */
export async function getSessionKeypair(sessionIndex) {
  // Offset by 1000 so session wallets never collide with master (index 0)
  return deriveKeypair(1000 + sessionIndex);
}
