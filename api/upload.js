// api/upload.js
// POST /api/upload
// Receives the media blob (photo/audio/video) and uploads to NFT.Storage (IPFS).
// Returns the IPFS URI to be embedded in the session metadata.
// Called BEFORE /api/session — frontend uploads file first, gets URI, then creates session.

export const config = {
  api: { bodyParser: false },
};

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const nftStorageKey = process.env.NFT_STORAGE_KEY;
    if (!nftStorageKey) throw new Error('NFT_STORAGE_KEY not configured');

    // Parse multipart form data
    const { IncomingForm } = await import('formidable');
    const form = new IncomingForm({ maxFileSize: 150 * 1024 * 1024 }); // 150MB

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
    const outputType = Array.isArray(fields.outputType) ? fields.outputType[0] : (fields.outputType || 'video');

    // Upload raw file to NFT.Storage
    const uploadRes = await fetch('https://api.nft.storage/upload', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${nftStorageKey}`,
        'Content-Type': mimeType,
      },
      body: fileBuffer,
    });

    const uploadData = await uploadRes.json();
    if (!uploadData.ok) {
      throw new Error('NFT.Storage upload failed: ' + JSON.stringify(uploadData.error));
    }

    const cid = uploadData.value.cid;
    const fileUri = `https://ipfs.io/ipfs/${cid}`;

    // Clean up temp file
    try { fs.unlinkSync(file.filepath); } catch {}

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
