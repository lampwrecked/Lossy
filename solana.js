// lib/solana.js
// Solana + USDC utilities: check balance, init ATA, sweep funds

import {
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  getOrCreateAssociatedTokenAccount,
  createTransferInstruction,
  getAccount,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';

// USDC on Solana mainnet
export const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

// $2.25 USDC in raw units (6 decimals)
export const REQUIRED_USDC = 2_250_000;

// ~0.002 SOL to cover ATA init + tx fees for derived wallet
export const ATA_INIT_SOL = 0.003;

export function getConnection() {
  return new Connection(process.env.SOLANA_RPC_URL, 'confirmed');
}

/**
 * Get USDC balance of a wallet in raw units (6 decimals)
 */
export async function getUsdcBalance(connection, walletPublicKey) {
  try {
    const ata = await getAssociatedTokenAddress(USDC_MINT, walletPublicKey);
    const account = await getAccount(connection, ata);
    return Number(account.amount);
  } catch {
    return 0; // ATA doesn't exist yet = 0 balance
  }
}

/**
 * Find the sender of USDC to a given address by scanning recent tx history.
 * Returns the sender's public key string, or null if not found.
 */
export async function findUsdcSender(connection, receiverPublicKey) {
  try {
    const ata = await getAssociatedTokenAddress(USDC_MINT, receiverPublicKey);
    const sigs = await connection.getSignaturesForAddress(ata, { limit: 10 });

    for (const sigInfo of sigs) {
      const tx = await connection.getTransaction(sigInfo.signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });
      if (!tx) continue;

      const preBalances  = tx.meta?.preTokenBalances  || [];
      const postBalances = tx.meta?.postTokenBalances || [];

      // Find accounts whose USDC balance decreased (they sent)
      for (const pre of preBalances) {
        if (pre.mint !== USDC_MINT.toBase58()) continue;
        const post = postBalances.find(p => p.accountIndex === pre.accountIndex);
        const preAmt  = Number(pre.uiTokenAmount.amount);
        const postAmt = post ? Number(post.uiTokenAmount.amount) : 0;
        if (preAmt > postAmt && pre.owner !== receiverPublicKey.toBase58()) {
          return pre.owner; // This is the sender
        }
      }
    }
  } catch (err) {
    console.error('findUsdcSender error:', err);
  }
  return null;
}

/**
 * Fund a derived wallet with enough SOL to initialize its USDC ATA and pay tx fees.
 * Called when a session is created, before the user sends payment.
 */
export async function fundDerivedWallet(connection, masterKeypair, derivedPublicKey) {
  const lamports = Math.ceil(ATA_INIT_SOL * LAMPORTS_PER_SOL);

  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: masterKeypair.publicKey,
      toPubkey: derivedPublicKey,
      lamports,
    })
  );

  const sig = await sendAndConfirmTransaction(connection, tx, [masterKeypair]);
  return sig;
}

/**
 * Initialize the USDC Associated Token Account for a derived wallet.
 * This is what allows the derived wallet to receive USDC.
 */
export async function initUsdcAta(connection, masterKeypair, derivedKeypair) {
  const ata = await getOrCreateAssociatedTokenAccount(
    connection,
    masterKeypair,     // payer
    USDC_MINT,
    derivedKeypair.publicKey,
    false,
  );
  return ata.address;
}

/**
 * Sweep all USDC from derived wallet back to master wallet.
 * Called after payment confirmed and NFT minted.
 */
export async function sweepUsdc(connection, derivedKeypair, masterPublicKey) {
  const balance = await getUsdcBalance(connection, derivedKeypair.publicKey);
  if (balance === 0) return null;

  const fromAta = await getAssociatedTokenAddress(USDC_MINT, derivedKeypair.publicKey);
  const toAta   = await getAssociatedTokenAddress(USDC_MINT, masterPublicKey);

  const tx = new Transaction().add(
    createTransferInstruction(
      fromAta,
      toAta,
      derivedKeypair.publicKey,
      balance,
      [],
      TOKEN_PROGRAM_ID,
    )
  );

  const sig = await sendAndConfirmTransaction(connection, tx, [derivedKeypair]);
  return sig;
}

/**
 * Sweep remaining SOL from derived wallet back to master wallet.
 * Called after USDC sweep — cleans up dust.
 */
export async function sweepSol(connection, derivedKeypair, masterPublicKey) {
  const balance = await connection.getBalance(derivedKeypair.publicKey);
  const fee = 5000; // ~0.000005 SOL tx fee
  const toSend = balance - fee;
  if (toSend <= 0) return null;

  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: derivedKeypair.publicKey,
      toPubkey: masterPublicKey,
      lamports: toSend,
    })
  );

  const sig = await sendAndConfirmTransaction(connection, tx, [derivedKeypair]);
  return sig;
}
