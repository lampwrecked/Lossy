// api/upload.js
// POST /api/upload
// Receives the media blob (photo/audio/video) and uploads to NFT.Storage (IPFS).
// Returns the IPFS URI to be embedded in the session metadata.

export const config = {
  api: { bodyParser: false },
};

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const nftStorageKey = (process.env.NFT_STORAGE_KEY || '').trim();
    if (!nftStorageKey) throw new Error('NFT_STORAGE_KEY not configured');

    // Parse multipart form data
    const { IncomingForm } = await import('formidable');
    const form = new IncomingForm({ maxFileSize: 150 * 1024 * 1024 });

    const { files, fields } = await new Promise((resolve, reject) => {
      form.parse(req, (err, fields, files) => {
        if (err) reject(err);
        else resolve({ files, fields });
      });
    });

    const file = Array.isArray(files.file) ? files.file[0] : files.file;
    if (!file) throw new Error('No file provided');

    const fs = await import('fs');
    const fileBuffer = fs.readFileSync(file.filepath);
    const mimeType = file.mimetype || 'video/webm';
    const outputType = Array.isArray(fields.outputType)
      ? fields.outputType[0]
      : (fields.outputType || 'video');

    // Log key length to help debug without exposing value
    console.log('NFT_STORAGE_KEY length:', nftStorageKey.length, 'starts with:', nftStorageKey.slice(0, 8));

    let cid = null;
    let lastError = null;

    // Attempt 1: NFT.Storage v1 upload endpoint
    try {
      const r = await fetch('https://api.nft.storage/upload', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${nftStorageKey}`,
          'Content-Type': mimeType,
        },
        body: fileBuffer,
      });
      const d = await r.json();
      console.log('NFT.Storage response:', JSON.stringify(d).slice(0, 200));
      if (d.ok && d.value?.cid) {
        cid = d.value.cid;
      } else {
        lastError = JSON.stringify(d);
      }
    } catch (e) {
      lastError = e.message;
      console.error('NFT.Storage attempt 1 failed:', e.message);
    }

    // Attempt 2: NFT.Storage store endpoint (alternative path)
    if (!cid) {
      try {
        const formData = new FormData();
        const blob = new Blob([fileBuffer], { type: mimeType });
        formData.append('file', blob, 'output');
        const r = await fetch('https://api.nft.storage/store', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${nftStorageKey}` },
          body: formData,
        });
        const d = await r.json();
        console.log('NFT.Storage store response:', JSON.stringify(d).slice(0, 200));
        if (d.ok && d.value?.ipnft) {
          cid = d.value.ipnft;
        } else {
          lastError = JSON.stringify(d);
        }
      } catch (e) {
        lastError = e.message;
        console.error('NFT.Storage attempt 2 failed:', e.message);
      }
    }

    // Clean up temp file
    try { (await import('fs')).unlinkSync(file.filepath); } catch {}

    if (!cid) {
      throw new Error('All IPFS upload attempts failed. Last error: ' + lastError);
    }

    const fileUri = `https://nftstorage.link/ipfs/${cid}`;

    return res.status(200).json({
      success: true,
      fileUri,
      cid,
      mimeType,
      outputType,
    });

  } catch (err) {
    console.error('Upload error:', err);
    return res.status(500).json({ error: err.message });
  }
}
