
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
    const session = await redis.getJson(`session:${sessionId}`);
    if (!session) return res.status(404).json({ error: 'Session not found or expired' });

    if (session.status === 'minting') {
      return res.status(200).json({ status: 'minting', message: 'Mint in progress...' });
    }

    if (session.status === 'minted') {
      return res.status(200).json({
        status: 'minted',
        mintAddress: session.mintAddress,
        mintSignature: session.mintSignature,
        explorerUrl: `https://explorer.solana.com/address/${session.mintAddress}`,
        exchangeArtUrl: `https://exchange.art/single/${session.mintAddress}`,
      });
    }

    if (Date.now() > session.expiresAt) {
      return res.status(200).json({ status: 'expired' });
    }

    const connection = getConnection();
    const sessionKeypair = await getSessionKeypair(session.sessionIndex);
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

    session.status = 'minting';
    await redis.set(`session:${sessionId}`, session, 60 * 60);

    const buyerWallet = await findUsdcSender(connection, sessionKeypair.publicKey);
    session.buyerWallet = buyerWallet;
    await redis.set(`session:${sessionId}`, session, 60 * 60);

    try {
      const mintResult = await mintNft(session, buyerWallet);
      session.status = 'minted';
      session.mintAddress = mintResult.mintAddress;
      session.mintSignature = mintResult.signature;
      await redis.set(`session:${sessionId}`, session, 60 * 60 * 24);
    } catch (mintErr) {
      console.error('Mint error:', mintErr);
      const errMsg = mintErr.message || String(mintErr);
      const isInsufficientSol = errMsg.includes('insufficient lamports') || errMsg.includes('Insufficient lamports');

      if (isInsufficientSol) {
        const match = errMsg.match(/need (\d+)/);
        const needed = match ? (parseInt(match[1]) / 1e9).toFixed(4) : 'unknown';
        session.status = 'needs_funding';
        await redis.set(`session:${sessionId}`, session, 60 * 60 * 24);
        return res.status(200).json({
          status: 'needs_funding',
          error: `Master wallet needs more SOL (${needed} SOL required). Payment is safe.`,
          buyerWallet,
        });
      }

      session.status = 'paid';
      await redis.set(`session:${sessionId}`, session, 60 * 60 * 24);
      return res.status(200).json({
        status: 'paid',
        error: errMsg,
        errorDetail: mintErr.stack ? mintErr.stack.slice(0, 800) : undefined,
        buyerWallet,
      });
    }

    try {
      const masterKeypair = await getMasterKeypair();
      session.sweepSignature = await sweepUsdc(connection, sessionKeypair, masterKeypair.publicKey);
      await sweepSol(connection, sessionKeypair, masterKeypair.publicKey);
      session.status = 'swept';
      await redis.set(`session:${sessionId}`, session, 60 * 60 * 24);
    } catch (sweepErr) {
      console.error('Sweep error (non-fatal):', sweepErr);
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

  const meta = session.metadata;
  const date = new Date().toISOString().slice(0, 10);
  const modeName = meta.mode ? meta.mode.charAt(0).toUpperCase() + meta.mode.slice(1) : 'Unknown';
  const shortDate = date.slice(2);
  const shortMode = modeName.slice(0, 10);
  const nftName = `LOSSY -- ${shortMode} -- ${shortDate}`.slice(0, 32);

  const attributes = [];
  if (meta.answers) {
    const questionLabels = {
      volume:     'HOW IS YOUR FORM?',
      distortion: 'ARE YOU EXPERIENCING A LOSS OF SENSORY QUALITY?',
      pitch:      'WHAT IS THE LOCATION OF THE SHORT CIRCUIT?',
      glitch:     'WHAT IS YOUR SIGNAL TO NOISE RATIO?',
      reverb:     'IS IT SHARP OR DULL?',
      crush:      'WHAT IS YOUR IDEAL LIGHTING SITUATION?',
      scale:      'WHAT MEDIUM DO YOU FEEL MOST COMFORTABLE IN?',
      wobble:     'HAVE YOU EVER FORGOTTEN WHERE YOU END?',
      echo:       'HAVE YOU EVER FORGOTTEN WHEN YOU END?',
      speed:      'HOW DOES THE CANDLE BURN?',
      mode:       'WHAT IS THE FIRE?',
      launch:     'HOW DO YOU CONSUME IT?',
    };
    Object.entries(meta.answers).forEach(([q, a]) => {
      const label = questionLabels[q] || q;
      attributes.push({ trait_type: label, value: String(a) });
    });
  }
  if (meta.mode) attributes.push({ trait_type: 'Mode', value: modeName });
  if (meta.speed) attributes.push({ trait_type: 'Speed', value: String(meta.speed) + 'x' });
  if (meta.outputType) attributes.push({ trait_type: 'Output Type', value: session.outputType });
  if (meta.ghost) attributes.push({ trait_type: 'Ghost', value: meta.ghost });

  const metadataJson = {
    name: nftName,
    description: 'Lossy. An extension of Day After Day by lampwrecked. The signal persists in spite of decay.',
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

  const pinataJwt = (process.env.PINATA_JWT || '').trim();
  if (!pinataJwt) throw new Error('PINATA_JWT not configured');

  const metadataBlob = new Blob([JSON.stringify(metadataJson)], { type: 'application/json' });
  const metadataForm = new FormData();
  metadataForm.append('file', metadataBlob, 'metadata.json');
  metadataForm.append('pinataMetadata', JSON.stringify({ name: `lossy-metadata-${Date.now()}.json` }));
  metadataForm.append('pinataOptions', JSON.stringify({ cidVersion: 1 }));

  const pinRes = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${pinataJwt}` },
    body: metadataForm,
  });
  const pinData = await pinRes.json();
  if (!pinData.IpfsHash) throw new Error('Pinata metadata upload failed: ' + JSON.stringify(pinData));
  const metadataUri = `https://gateway.pinata.cloud/ipfs/${pinData.IpfsHash}`;

  const umi = createUmi(process.env.SOLANA_RPC_URL).use(mplTokenMetadata());
  const umiKeypair = umi.eddsa.createKeypairFromSecretKey(masterKeypair.secretKey);
  const signer = createSignerFromKeypair(umi, umiKeypair);
  umi.use(signerIdentity(signer));

  const mint = generateSigner(umi);

  const tokenOwner = buyerWallet
    ? umiPublicKey(buyerWallet)
    : umiPublicKey(masterKeypair.publicKey.toBase58());

  const collectionMintAddr = process.env.COLLECTION_MINT;
  const collectionConfig = collectionMintAddr ? {
    collection: { key: umiPublicKey(collectionMintAddr), verified: false },
  } : {};

  const { signature } = await createNft(umi, {
    mint,
    name: nftName,
    symbol: 'LOSSY',
    uri: metadataUri,
    sellerFeeBasisPoints: percentAmount(15, 2),
    creators: [{
      address: umiPublicKey(process.env.PERSONAL_WALLET_PUBLIC_KEY || 'FrstHD18pJsFRatk2hnfv4EztP1p87mJ1SL6QyXCcQju'),
      verified: false,
      share: 100,
    }],
    tokenOwner,
    isMutable: false,
    ...collectionConfig,
  }).sendAndConfirm(umi);

  const bs58 = await import('bs58');
  const sigStr = bs58.default.encode(signature);

  return {
    mintAddress: mint.publicKey,
    signature: sigStr,
    metadataUri,
  };
}
