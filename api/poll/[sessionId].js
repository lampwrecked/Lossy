// api/poll/[sessionId].js
// GET /api/poll/:sessionId
// Called by frontend every 5 seconds while mint window is open.
// Checks USDC balance on derived address.
// On payment confirmed: uploads metadata, mints NFT, sweeps funds.

import { redis } from '../../lib/redis.js';
import { getSessionKeypair, getMasterKeypair } from '../../lib/wallet.js';
import {
  getConnection,
  getUsdcBalance,
  findUsdcSender,
  sweepUsdc,
  sweepSol,
  REQUIRED_USDC,
} from '../../lib/solana.js';
import { PublicKey } from '@solana/web3.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { sessionId } = req.query;
  if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });

  try {
    // Load session
    const session = await redis.getJson(`session:${sessionId}`);
    if (!session) return res.status(404).json({ error: 'Session not found or expired' });

    // Already done
    if (session.status === 'minted') {
      return res.status(200).json({
        status: 'minted',
        mintAddress: session.mintAddress,
        mintSignature: session.mintSignature,
        explorerUrl: `https://explorer.solana.com/address/${session.mintAddress}`,
        exchangeArtUrl: `https://exchange.art/single/${session.mintAddress}`,
      });
    }

    // Expired
    if (Date.now() > session.expiresAt) {
      return res.status(200).json({ status: 'expired' });
    }

    // Check USDC balance on derived payment address
    const connection = getConnection();
    const sessionKeypair = await getSessionKeypair(session.sessionIndex);

    // Test mode — skip payment check (add ?test=true to URL)
    const testMode = req.query.test === 'true';
    const balance = testMode ? REQUIRED_USDC : await getUsdcBalance(connection, sessionKeypair.publicKey);

    if (!testMode && balance < REQUIRED_USDC) {
      return res.status(200).json({
        status: 'pending',
        paymentAddress: session.paymentAddress,
        requiredUsdc: REQUIRED_USDC,
        receivedUsdc: balance,
        amountDisplay: '$2.25 USDC',
      });
    }

    // ── Payment confirmed — proceed with mint ──
    session.status = 'paid';

    // Find buyer's wallet from transaction history
    const buyerWallet = await findUsdcSender(connection, sessionKeypair.publicKey);
    session.buyerWallet = buyerWallet;

    // Update session status
    await redis.set(`session:${sessionId}`, session, 60 * 60); // extend TTL 1hr

    // ── Upload metadata + mint NFT ──
    try {
      const mintResult = await mintNft(session, buyerWallet);
      session.status = 'minted';
      session.mintAddress = mintResult.mintAddress;
      session.mintSignature = mintResult.signature;
      await redis.set(`session:${sessionId}`, session, 60 * 60 * 24); // keep 24hr
    } catch (mintErr) {
      console.error('Mint error:', mintErr);
      // Don't fail the response — payment was received
      // Session stays 'paid' so we can retry manually
      await redis.set(`session:${sessionId}`, session, 60 * 60 * 24);
      return res.status(200).json({
        status: 'paid',
        error: 'Mint failed after payment — contact lampwrecked',
        buyerWallet,
      });
    }

    // ── Sweep USDC + SOL back to master wallet ──
    try {
      const masterKeypair = await getMasterKeypair();
      session.sweepSignature = await sweepUsdc(connection, sessionKeypair, masterKeypair.publicKey);
      await sweepSol(connection, sessionKeypair, masterKeypair.publicKey);
      session.status = 'swept';
      await redis.set(`session:${sessionId}`, session, 60 * 60 * 24);
    } catch (sweepErr) {
      console.error('Sweep error (non-fatal):', sweepErr);
      // Sweep failure doesn't affect the buyer — NFT already minted
    }

    return res.status(200).json({
      status: 'minted',
      mintAddress: session.mintAddress,
      mintSignature: session.mintSignature,
      buyerWallet,
      explorerUrl: `https://explorer.solana.com/address/${session.mintAddress}`,
      exchangeArtUrl: `https://exchange.art/single/${session.mintAddress}`,
    });

  } catch (err) {
    console.error('Poll error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ── Internal: upload metadata to NFT.Storage + mint via Metaplex ──
async function mintNft(session, buyerWallet) {
  const { createUmi } = await import('@metaplex-foundation/umi-bundle-defaults');
  const { createNft, mplTokenMetadata } = await import('@metaplex-foundation/mpl-token-metadata');
  const {
    createSignerFromKeypair,
    signerIdentity,
    generateSigner,
    percentAmount,
    publicKey: umiPublicKey,
  } = await import('@metaplex-foundation/umi');

  const { getMasterKeypair } = await import('../../lib/wallet.js');
  const masterKeypair = await getMasterKeypair();

  // Build NFT name from metadata
  const meta = session.metadata;
  const date = new Date().toISOString().slice(0, 10);
  const modeName = meta.mode ? meta.mode.charAt(0).toUpperCase() + meta.mode.slice(1) : 'Unknown';
  // Metaplex enforces 32 char max on NFT names
  const shortDate = date.slice(2); // e.g. 26-02-24
  const shortMode = modeName.slice(0, 10); // truncate mode if needed
  const nftName = `DAD — ${shortMode} — ${shortDate}`.slice(0, 32);

  // Build attributes from questionnaire answers
  const attributes = [];
  if (meta.answers) {
    Object.entries(meta.answers).forEach(([q, a]) => {
      attributes.push({ trait_type: q, value: String(a) });
    });
  }
  if (meta.mode)    attributes.push({ trait_type: 'Mode',        value: modeName });
  if (meta.speed)   attributes.push({ trait_type: 'Speed',       value: String(meta.speed) + 'x' });
  if (meta.outputType) attributes.push({ trait_type: 'Output Type', value: session.outputType });

  // Upload metadata JSON to NFT.Storage (IPFS)
  const metadataJson = {
    name: nftName,
    description: 'Day after day, the signal persists in spite of decay. Persistence is the condition. An instrument by lampwrecked, 2026.',
    image: meta.fileUri || '',
    animation_url: session.outputType !== 'photo' ? meta.fileUri : undefined,
    external_url: 'https://exchange.art',
    attributes,
    properties: {
      files: [{ uri: meta.fileUri || '', type: session.outputType === 'photo' ? 'image/webp' : session.outputType === 'audio' ? 'audio/webm' : 'video/webm' }],
      category: session.outputType === 'photo' ? 'image' : session.outputType,
      creators: [{ address: masterKeypair.publicKey.toBase58(), share: 100 }],
    },
  };

  // Upload metadata JSON to Pinata
  const pinataJwt = (process.env.PINATA_JWT || '').trim();
  if (!pinataJwt) throw new Error('PINATA_JWT not configured');

  const metadataBlob = new Blob([JSON.stringify(metadataJson)], { type: 'application/json' });
  const metadataForm = new FormData();
  metadataForm.append('file', metadataBlob, 'metadata.json');
  metadataForm.append('pinataMetadata', JSON.stringify({ name: `day-after-day-metadata-${Date.now()}.json` }));
  metadataForm.append('pinataOptions', JSON.stringify({ cidVersion: 1 }));

  const pinRes = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${pinataJwt}` },
    body: metadataForm,
  });
  const pinData = await pinRes.json();
  if (!pinData.IpfsHash) throw new Error('Pinata metadata upload failed: ' + JSON.stringify(pinData));
  const metadataUri = `https://gateway.pinata.cloud/ipfs/${pinData.IpfsHash}`;

  // Init UMI with master keypair
  const umi = createUmi(process.env.SOLANA_RPC_URL).use(mplTokenMetadata());
  const umiKeypair = umi.eddsa.createKeypairFromSecretKey(masterKeypair.secretKey);
  const signer = createSignerFromKeypair(umi, umiKeypair);
  umi.use(signerIdentity(signer));

  // Generate mint address
  const mint = generateSigner(umi);

  // Determine token owner — buyer's wallet if found, else master wallet
  const tokenOwner = buyerWallet
    ? umiPublicKey(buyerWallet)
    : umiPublicKey(masterKeypair.publicKey.toBase58());

  // Mint NFT
  const { signature } = await createNft(umi, {
    mint,
    name: nftName,
    uri: metadataUri,
    sellerFeeBasisPoints: percentAmount(15, 2), // 15% royalties
    creators: [{
      address: umiPublicKey(process.env.PERSONAL_WALLET_PUBLIC_KEY),
      verified: false,
      share: 100,
    }],
    tokenOwner,
    isMutable: false,
  }).sendAndConfirm(umi);

  const bs58 = await import('bs58');
  const sigStr = bs58.default.encode(signature);

  return {
    mintAddress: mint.publicKey,
    signature: sigStr,
    metadataUri,
  };
}
