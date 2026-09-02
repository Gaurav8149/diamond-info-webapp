// server.js
// Node.js + Express backend for the Diamond Info app.
// Replaces the original ASP.NET MVC controllers/models:
//   - HomeController.StoneDetails  -> GET /api/stone/:certNo
//   - HomeController.ParcelDetails -> GET /api/parcel/:parcelNo
// The frontend (public/) is plain HTML + CSS + embedded JS that calls these APIs.
//
// Media can now come from MULTIPLE sources at once, merged together per lookup:
//   - Any number of local folders (e.g. C:\Media, F:\Media) via MEDIA_FOLDER_PATHS
//   - A private AWS S3 bucket via S3_BUCKET_NAME (temporary signed URLs, since
//     the bucket is private; flip S3_PUBLIC=true later if it ever becomes public)
// A certificate number or parcel number is looked up across all of them, and
// whatever matches (from any source) is combined into one response.

require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const CONFIG = {
  PORT: process.env.PORT || 3000,

  // One or more local folders, comma-separated, e.g.:
  //   MEDIA_FOLDER_PATHS=C:\Media,F:\Media
  MEDIA_FOLDER_PATHS: (process.env.MEDIA_FOLDER_PATHS || process.env.MEDIA_FOLDER_PATH || path.join(__dirname, 'sample-media'))
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => path.resolve(p)),

  IMAGE_EXTENSIONS: (process.env.IMAGE_EXTENSIONS || 'jpg,jpeg,png,bmp').split(','),
  VIDEO_EXTENSIONS: (process.env.VIDEO_EXTENSIONS || 'mp4,avi').split(','),

  // AWS S3 — leave S3_BUCKET_NAME blank to search local folders only.
  S3: {
    enabled: !!process.env.S3_BUCKET_NAME,
    bucket: process.env.S3_BUCKET_NAME,
    region: process.env.AWS_REGION || 'ap-south-1',
    // false (default) = bucket is private, app generates temporary signed URLs.
    // true = bucket/CloudFront is public, app builds a plain permanent URL instead.
    public: process.env.S3_PUBLIC === 'true',
    publicBaseUrl: process.env.S3_PUBLIC_BASE_URL || '',
    signedUrlExpirySeconds: parseInt(process.env.S3_SIGNED_URL_EXPIRY || '3600', 10),
    // Optional: narrow the search to a specific subfolder for performance,
    // e.g. S3_KEY_PREFIX=Media/  (include the trailing slash). Leave blank
    // to search the whole bucket, regardless of subfolder structure.
    keyPrefix: process.env.S3_KEY_PREFIX || '',
    // How long the in-memory list of bucket contents stays fresh before
    // re-scanning S3. Lookups between refreshes are served from memory
    // (near-instant) instead of hitting AWS on every page load.
    cacheTtlMs: parseInt(process.env.S3_CACHE_TTL_SECONDS || '300', 10) * 1000
  },

  // Optional SQL Server lookup for extra external video links (was: Staging..ExternalVideoLink)
  DB: {
    enabled: !!process.env.DB_SERVER,
    server: process.env.DB_SERVER,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    options: { encrypt: false, trustServerCertificate: true }
  }
  ,
  // Local folder listing cache TTL (milliseconds)
  LOCAL_CACHE_TTL_MS: parseInt(process.env.LOCAL_CACHE_TTL_SECONDS || '30', 10) * 1000
};

app.use(cors());
app.use(express.json());

// Serve the frontend
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Local media serving — one route handles ALL configured local folders,
// identified by index, so files with the same name in different folders
// (e.g. C:\Media vs F:\Media) never collide.
//   /media/0/2221514363_1.jpg  -> CONFIG.MEDIA_FOLDER_PATHS[0]
//   /media/1/2221514363_1.jpg  -> CONFIG.MEDIA_FOLDER_PATHS[1]
// ---------------------------------------------------------------------------
app.get('/media/:folderIndex/:filename', (req, res) => {
  const idx = parseInt(req.params.folderIndex, 10);
  const folder = CONFIG.MEDIA_FOLDER_PATHS[idx];
  if (!folder) return res.status(404).send('Unknown media folder');

  // basename() strips any path separators, preventing directory traversal
  const safeFilename = path.basename(req.params.filename);
  const filePath = path.join(folder, safeFilename);

  if (!fs.existsSync(filePath)) return res.status(404).send('File not found');
  res.sendFile(filePath);
});

// ---------------------------------------------------------------------------
// S3 client (only initialized when S3_BUCKET_NAME is set)
// ---------------------------------------------------------------------------
let s3Client = null;
let S3Commands = null;
let getSignedUrl = null;

if (CONFIG.S3.enabled) {
  const { S3Client, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');
  const { NodeHttpHandler } = require('@smithy/node-http-handler');
  ({ getSignedUrl } = require('@aws-sdk/s3-request-presigner'));
  S3Commands = { ListObjectsV2Command, GetObjectCommand };

  s3Client = new S3Client({
    region: CONFIG.S3.region,
    // Pass credentials explicitly from .env instead of letting the SDK fall
    // through its default provider chain. Without this, if the .env values
    // aren't picked up for any reason, the SDK's next step is to check for
    // "EC2 instance metadata" (a mechanism meant for servers running inside
    // AWS) — and on a regular server that check can hang for MINUTES before
    // giving up. Being explicit here skips that entirely.
    credentials: process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
      ? {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
        }
      : undefined,
    // Fail fast instead of hanging: give up on a stuck connection quickly
    // rather than waiting minutes, so a real problem shows up as a clear
    // error in the logs within seconds, not silently as "it's just slow".
    requestHandler: new NodeHttpHandler({
      connectionTimeout: 5000, // 5s to establish a connection
      requestTimeout: 20000    // 20s for the request itself (covers large file transfers)
    }),
    maxAttempts: 2
  });

  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    console.warn('WARNING: AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY not found in .env — S3 requests will likely fail or hang. Double-check your .env file is being loaded (check the working directory PM2 is running from).');
  }
}

// ---------------------------------------------------------------------------
// S3 key cache. Listing an entire bucket on every single page request is
// slow (each ListObjectsV2 call only returns up to 1000 keys, so a bucket
// with many files means many round-trips to AWS — this is what was causing
// multi-minute page loads). Instead we list the bucket once, keep the result
// in memory, and only refresh it periodically. Everyday certificate/parcel
// lookups then just filter this in-memory list, which is effectively instant.
// ---------------------------------------------------------------------------
let s3KeyCache = { keys: [], fetchedAt: 0 };
let s3RefreshInFlight = null; // avoids two simultaneous refreshes if requests overlap

// Local folder listing cache: avoid calling readdirSync on every request
// (important when folders live on slow/network disks such as F:).
const localFolderCache = new Map(); // folderPath -> { files: string[], fetchedAt: number }

function getLocalFiles(folder) {
  const now = Date.now();
  const entry = localFolderCache.get(folder);
  if (entry && (now - entry.fetchedAt) <= CONFIG.LOCAL_CACHE_TTL_MS) return entry.files;

  // Refresh cache
  try {
    const files = fs.existsSync(folder) ? fs.readdirSync(folder) : [];
    localFolderCache.set(folder, { files, fetchedAt: now });
    return files;
  } catch (err) {
    console.error('Failed to read media folder', folder, err.message);
    localFolderCache.set(folder, { files: [], fetchedAt: now });
    return [];
  }
}

async function getS3Keys() {
  const isStale = Date.now() - s3KeyCache.fetchedAt > CONFIG.S3.cacheTtlMs;
  if (!isStale) return s3KeyCache.keys;

  // If a refresh is already running (e.g. two requests arrived back-to-back
  // right as the cache expired), just wait for that one instead of starting
  // a second full bucket scan.
  if (s3RefreshInFlight) return s3RefreshInFlight;

  s3RefreshInFlight = (async () => {
    const keys = [];
    let continuationToken = undefined;
    do {
      const response = await s3Client.send(
        new S3Commands.ListObjectsV2Command({
          Bucket: CONFIG.S3.bucket,
          Prefix: CONFIG.S3.keyPrefix || undefined,
          ContinuationToken: continuationToken
        })
      );
      for (const obj of response.Contents || []) keys.push(obj.Key);
      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuationToken);

    s3KeyCache = { keys, fetchedAt: Date.now() };
    console.log(`S3 key cache refreshed: ${keys.length} objects`);
    return keys;
  })();

  try {
    return await s3RefreshInFlight;
  } finally {
    s3RefreshInFlight = null;
  }
}

async function s3FileUrl(key) {
  if (CONFIG.S3.public) {
    if (CONFIG.S3.publicBaseUrl) {
      return `${CONFIG.S3.publicBaseUrl.replace(/\/$/, '')}/${key}`;
    }
    return `https://${CONFIG.S3.bucket}.s3.${CONFIG.S3.region}.amazonaws.com/${key}`;
  }

  // Private bucket: proxy the file through our OWN server instead of handing
  // the browser a direct amazonaws.com link. This matters because some office
  // networks only allow browsing to our own domain and block general internet
  // access — a direct S3 link would silently fail to load on those machines,
  // even though the signature itself is perfectly valid. Routing through our
  // own domain means every client only ever needs to reach us, never AWS.
  return `/media-s3/${encodeURIComponent(key)}`;
}

// Streams a private S3 object through our server to the browser, so the
// browser never has to contact amazonaws.com directly.
// Accept any encoded key after /media-s3/ — this lets keys contain slashes
// and other characters that may be percent-encoded in the URL.
app.get('/media-s3/*', async (req, res) => {
  if (!CONFIG.S3.enabled) return res.status(404).send('S3 not configured');
  try {
    // Extract the encoded portion of the path after /media-s3/
    const encodedPart = req.path.substring('/media-s3/'.length);
    const key = decodeURIComponent(encodedPart);
    console.log('S3 proxy request for key:', key);
    const data = await s3Client.send(
      new S3Commands.GetObjectCommand({ Bucket: CONFIG.S3.bucket, Key: key })
    );
    if (data.ContentType) res.setHeader('Content-Type', data.ContentType);
    if (data.ContentLength) res.setHeader('Content-Length', data.ContentLength);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    data.Body.pipe(res);
  } catch (err) {
    console.error('S3 proxy fetch failed for key:', err && err instanceof Error ? err.message : err, err && err.stack ? err.stack : '');
    res.status(404).send('File not found');
  }
});

// ---------------------------------------------------------------------------
// Combined lookup: searches every local folder AND the S3 bucket (if enabled)
// for files starting with `prefix` and matching `extensions`. Returns a
// merged array of { name, url } entries from whichever source(s) had matches.
// ---------------------------------------------------------------------------
async function findAllFiles(prefix, extensions) {
  const results = [];
  const lowerPrefix = prefix.toLowerCase();

  // 1) Search every configured local folder using cached listings
  CONFIG.MEDIA_FOLDER_PATHS.forEach((folder, folderIndex) => {
    const files = getLocalFiles(folder);
    const matches = files.filter((file) => {
      const ext = path.extname(file).slice(1).toLowerCase();
      return extensions.includes(ext) && file.toLowerCase().startsWith(lowerPrefix);
    });
    matches.forEach((file) => {
      results.push({ name: file, url: `/media/${folderIndex}/${encodeURIComponent(file)}` });
    });
  });

  // 2) Search S3 (via the in-memory cache — see getS3Keys() above), if configured.
  //    We match by FILENAME (basename), not the full key, since files may live
  //    inside a subfolder rather than the bucket root.
  if (CONFIG.S3.enabled) {
    try {
      const allKeys = await getS3Keys();
      for (const key of allKeys) {
        const filename = path.basename(key);
        const ext = path.extname(filename).slice(1).toLowerCase();
        if (!extensions.includes(ext)) continue;
        if (!filename.toLowerCase().startsWith(lowerPrefix)) continue;
        results.push({ name: filename, url: await s3FileUrl(key) });
      }
    } catch (err) {
      console.error('S3 lookup failed:', err.message);
      // Don't fail the whole request just because S3 had an issue —
      // local-folder matches (if any) still get returned.
    }
  }

  return results;
}

// Best-effort external video link lookup. If no DB is configured, or the
// query fails, we just return an empty array (same graceful degradation
// as the original Response<T> / try-catch pattern in StoneModel).
async function getExternalVideoLinks(certNo) {
  if (!CONFIG.DB.enabled) return [];
  try {
    const sql = require('mssql');
    const pool = await sql.connect(CONFIG.DB);
    const result = await pool
      .request()
      .input('CertNo', sql.VarChar, certNo)
      .query(`
        SELECT EVL.VideoLink
        FROM Staging..ExternalVideoLink EVL
        LEFT OUTER JOIN MySQL..tbl_big_dia_inventory DI ON DI.ref_no = EVL.RefNo
        WHERE DI.cert_id = @CertNo
      `);
    return result.recordset.map((r) => r.VideoLink);
  } catch (err) {
    console.error('External video link lookup failed:', err.message);
    return [];
  }
}

// ---------------------------------------------------------------------------
// API: Stone Details  (was /stonedetails/{CertNo})
// ---------------------------------------------------------------------------
app.get('/api/stone/:certNo', async (req, res) => {
  const certNo = req.params.certNo;

  try {
    console.time(`findImages:${certNo}`);
    const imageEntries = await findAllFiles(certNo, CONFIG.IMAGE_EXTENSIONS);
    console.timeEnd(`findImages:${certNo}`);

    console.time(`findVideos:${certNo}`);
    const videoEntries = await findAllFiles(certNo, CONFIG.VIDEO_EXTENSIONS);
    console.timeEnd(`findVideos:${certNo}`);

    console.log(`findAllFiles results for ${certNo}: images=${imageEntries.length} videos=${videoEntries.length}`);

    const certEntries = imageEntries.filter((e) => e.name.toLowerCase().includes('certificate'));
    const galleryEntries = imageEntries.filter((e) => !e.name.toLowerCase().includes('certificate'));

    const certificateImage = certEntries.length ? certEntries[0].url : null;
    const images = galleryEntries.map((e) => e.url);
    const localVideos = videoEntries.map((e) => e.url);

    // Plus any external video links from the DB
    const externalVideos = await getExternalVideoLinks(certNo);

    res.json({
      certNo,
      certificateImage,
      images,
      videos: [...externalVideos, ...localVideos],
      whatsappLink: `https://wa.me/?text=${encodeURIComponent(
        `${req.protocol}://${req.get('host')}/stonedetails/${certNo}`
      )}`
    });
  } catch (err) {
    console.error('Error in /api/stone/:certNo', err);
    res.status(500).json({ error: 'Failed to load stone details' });
  }
});

// ---------------------------------------------------------------------------
// API: Parcel Details  (was /parcel/{parcelNo})
// ---------------------------------------------------------------------------
const PARCEL_PATTERNS = ['_bg', '_Fluo', '_Mix', '_Phospho'];

app.get('/api/parcel/:parcelNo', async (req, res) => {
  const parcelNo = req.params.parcelNo;

  try {
    const imageEntries = await findAllFiles(parcelNo, CONFIG.IMAGE_EXTENSIONS);
    const matched = imageEntries.filter((e) => PARCEL_PATTERNS.some((p) => e.name.includes(p)));

    const images = matched.map((e) => ({ filename: e.name, url: e.url }));

    res.json({
      parcelNo,
      images,
      whatsappLink: `https://wa.me/?text=${encodeURIComponent(
        `${req.protocol}://${req.get('host')}/parcel/${parcelNo}`
      )}`
    });
  } catch (err) {
    console.error('Error in /api/parcel/:parcelNo', err);
    res.status(500).json({ error: 'Failed to load parcel details' });
  }
});

// Friendly HTML routes matching the real production URLs:
//   https://details.getdiamondinfo.com/stonedetails/250000150485
//   https://details.getdiamondinfo.com/parcel/2501001
app.get('/stonedetails/:certNo', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'stone.html'));
});
app.get('/parcel/:parcelNo', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'parcel.html'));
});

app.listen(CONFIG.PORT, () => {
  console.log(`Diamond Info app running at http://localhost:${CONFIG.PORT}`);
  console.log(`Local media folders: ${CONFIG.MEDIA_FOLDER_PATHS.join(', ')}`);
  console.log(`S3: ${CONFIG.S3.enabled ? `bucket "${CONFIG.S3.bucket}" (${CONFIG.S3.region}), ${CONFIG.S3.public ? 'public URLs' : 'private, proxied through this server'}` : 'disabled'}`);
  console.log(`Database lookups: ${CONFIG.DB.enabled ? 'enabled' : 'disabled (no DB_SERVER set)'}`);

  if (CONFIG.S3.enabled) {
    console.log('Warming S3 key cache in the background...');
    getS3Keys().catch((err) => console.error('Initial S3 cache warm-up failed:', err.message));
  }
});