const express = require('express');
const fs = require('fs');
const path = require('path');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

const SESSION_SECRET = process.env.SESSION_SECRET || 'change-me';
const PAYPAL_EMAIL = process.env.PAYPAL_EMAIL || 'rangerbleau11@gmail.com';

const TRIAL_DAYS = Number(process.env.TRIAL_DAYS || 7);
const TRIAL_CREDITS = Number(process.env.TRIAL_CREDITS || 1000);
const MONTHLY_PRICE = Number(process.env.MONTHLY_PRICE || 29.99);
const MONTHLY_CREDITS = Number(process.env.MONTHLY_CREDITS || 5000);
const ADDON_PRICE = Number(process.env.ADDON_PRICE || 9.99);
const ADDON_CREDITS = Number(process.env.ADDON_CREDITS || 1000);
const CREDITS_PER_VIDEO = Number(process.env.CREDITS_PER_VIDEO || 1000);

const VIDEO_PROVIDER = 'mock'; // force local render
const HEYGEN_API_KEY = ''; // force off
const USE_HEYGEN = false; // hard disable



const HEYGEN_BASE = process.env.HEYGEN_BASE || 'https://api.heygen.com';

// These are configurable in case HeyGen adjusts routes on your account/version:
const HEYGEN_UPLOAD_ENDPOINT = process.env.HEYGEN_UPLOAD_ENDPOINT || '/v1/asset';
const HEYGEN_TALKING_PHOTO_ENDPOINT = process.env.HEYGEN_TALKING_PHOTO_ENDPOINT || '/v2/photo_avatar';
const HEYGEN_VIDEO_GENERATE_ENDPOINT = process.env.HEYGEN_VIDEO_GENERATE_ENDPOINT || '/v2/video/generate';
const HEYGEN_VIDEO_STATUS_ENDPOINT_TEMPLATE =
process.env.HEYGEN_VIDEO_STATUS_ENDPOINT_TEMPLATE || '/v1/video_status.get?video_id={videoId}';

const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const CREDITS_FILE = path.join(DATA_DIR, 'credits.json');
const VIDEOS_FILE = path.join(DATA_DIR, 'videos.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
for (const f of [USERS_FILE, CREDITS_FILE, VIDEOS_FILE]) {
if (!fs.existsSync(f)) fs.writeFileSync(f, '[]', 'utf8');
}

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const writeJson = (f, d) => fs.writeFileSync(f, JSON.stringify(d, null, 2), 'utf8');

function requireAuth(req, res, next) {
if (!req.session.user) return res.status(401).json({ error: 'Login required' });
next();
}

function getCredits(userId) {
return readJson(CREDITS_FILE).find((r) => r.userId === userId)?.balance || 0;
}
function setCredits(userId, balance, reason = 'update') {
const rows = readJson(CREDITS_FILE);
const i = rows.findIndex((r) => r.userId === userId);
const row = { userId, balance, reason, updatedAt: new Date().toISOString() };
if (i >= 0) rows[i] = row; else rows.push(row);
writeJson(CREDITS_FILE, rows);
}
function addCredits(userId, amount, reason = 'add') {
setCredits(userId, getCredits(userId) + amount, reason);
}
function consumeCredits(userId, amount) {
const bal = getCredits(userId);
if (bal < amount) return false;
setCredits(userId, bal - amount, 'video_generation');
return true;
}

function createVideoJob(userId, input) {
const rows = readJson(VIDEOS_FILE);
const row = {
jobId: uuidv4(),
userId,
provider: VIDEO_PROVIDER,
status: 'processing',
input,
output: null,
providerVideoId: null,
providerMeta: {},
createdAt: new Date().toISOString(),
updatedAt: new Date().toISOString()
};
rows.unshift(row);
writeJson(VIDEOS_FILE, rows);
return row;
}
function updateVideoJob(jobId, patch) {
const rows = readJson(VIDEOS_FILE);
const i = rows.findIndex((r) => r.jobId === jobId);
if (i < 0) return null;
rows[i] = { ...rows[i], ...patch, updatedAt: new Date().toISOString() };
writeJson(VIDEOS_FILE, rows);
return rows[i];
}

const storage = multer.diskStorage({
destination: (req, _file, cb) => {
const jobId = req.jobId || uuidv4();
req.jobId = jobId;
const dir = path.join(UPLOAD_DIR, 'video-jobs', jobId);
fs.mkdirSync(dir, { recursive: true });
cb(null, dir);
},
filename: (_req, file, cb) => {
const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
cb(null, `${Date.now()}-${safe}`);
}
});
const upload = multer({ storage, limits: { fileSize: 1024 * 1024 * 1024 } });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
secret: SESSION_SECRET,
resave: false,
saveUninitialized: false
}));
app.use('/uploads', express.static(UPLOAD_DIR));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/healthz', (_req, res) => {
res.json({ ok: true, provider: VIDEO_PROVIDER });
});

// ---------- Auth ----------
app.post('/api/auth/signup', async (req, res) => {
const { username, email, password } = req.body;
if (!username || !email || !password) return res.status(400).json({ error: 'Missing fields' });

const users = readJson(USERS_FILE);
if (users.some((u) => u.email.toLowerCase() === email.toLowerCase())) {
return res.status(409).json({ error: 'Email already exists' });
}

const user = {
userId: uuidv4(),
username,
email,
passwordHash: await bcrypt.hash(password, 10),
createdAt: new Date().toISOString(),
trialEndsAt: new Date(Date.now() + TRIAL_DAYS * 86400000).toISOString(),
plan: 'trial'
};
users.push(user);
writeJson(USERS_FILE, users);

addCredits(user.userId, TRIAL_CREDITS, 'trial_bonus');

req.session.user = { userId: user.userId, username, email };
res.json({ ok: true, user: req.session.user, trialCredits: TRIAL_CREDITS });
});

app.post('/api/auth/login', async (req, res) => {
const { email, password } = req.body;
const users = readJson(USERS_FILE);
const user = users.find((u) => u.email.toLowerCase() === String(email).toLowerCase());
if (!user) return res.status(401).json({ error: 'Invalid login' });

const ok = await bcrypt.compare(password, user.passwordHash);
if (!ok) return res.status(401).json({ error: 'Invalid login' });

req.session.user = { userId: user.userId, username: user.username, email: user.email };
res.json({ ok: true, user: req.session.user });
});

app.post('/api/auth/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get('/api/auth/me', (req, res) => res.json({ user: req.session.user || null }));

// ---------- Billing ----------
app.get('/api/billing', requireAuth, (req, res) => {
res.json({
monthlyPrice: MONTHLY_PRICE,
monthlyCredits: MONTHLY_CREDITS,
addOnPrice: ADDON_PRICE,
addOnCredits: ADDON_CREDITS,
creditsPerVideo: CREDITS_PER_VIDEO,
paypalEmail: PAYPAL_EMAIL,
paypalMonthlyLink: `https://www.paypal.com/cgi-bin/webscr?cmd=_xclick&business=${encodeURIComponent(PAYPAL_EMAIL)}&item_name=${encodeURIComponent('AI Music App Monthly')}&amount=${MONTHLY_PRICE.toFixed(2)}&currency_code=USD`,
paypalAddonLink: `https://www.paypal.com/cgi-bin/webscr?cmd=_xclick&business=${encodeURIComponent(PAYPAL_EMAIL)}&item_name=${encodeURIComponent('AI Music App Credits Pack')}&amount=${ADDON_PRICE.toFixed(2)}&currency_code=USD`
});
});

app.get('/api/credits', requireAuth, (req, res) => {
res.json({ balance: getCredits(req.session.user.userId) });
});

app.post('/api/credits/addon-confirm', requireAuth, (req, res) => {
addCredits(req.session.user.userId, ADDON_CREDITS, 'addon');
res.json({ ok: true, balance: getCredits(req.session.user.userId) });
});

// ---------- HeyGen helpers ----------
async function heygenFetch(endpoint, opts = {}) {
const url = `${HEYGEN_BASE}${endpoint}`;
const headers = {
'x-api-key': HEYGEN_API_KEY,
...(opts.headers || {})
};
return fetch(url, { ...opts, headers });
}

function fileToBlob(absPath, mime = 'application/octet-stream') {
const buff = fs.readFileSync(absPath);
return new Blob([buff], { type: mime });
}

function guessMime(filePath) {
const ext = path.extname(filePath).toLowerCase();
if (['.jpg', '.jpeg'].includes(ext)) return 'image/jpeg';
if (ext === '.png') return 'image/png';
if (ext === '.webp') return 'image/webp';
if (ext === '.mp3') return 'audio/mpeg';
if (ext === '.wav') return 'audio/wav';
if (ext === '.m4a') return 'audio/mp4';
return 'application/octet-stream';
}

async function heygenUploadAsset(absPath, type) {
const form = new FormData();
form.append('file', fileToBlob(absPath, guessMime(absPath)), path.basename(absPath));
form.append('type', type); // image | audio

const r = await heygenFetch(HEYGEN_UPLOAD_ENDPOINT, {
method: 'POST',
body: form
});
const j = await r.json();
if (!r.ok) throw new Error(`HeyGen upload failed: ${JSON.stringify(j)}`);

// tolerate multiple response shapes
const data = j.data || j;
return {
assetId: data.asset_id || data.id || data.audio_asset_id || data.image_asset_id || null,
url: data.url || data.asset_url || data.audio_url || data.image_url || null,
raw: j
};
}

async function heygenCreateTalkingPhoto(photoAbsPath) {
// Attempt explicit talking-photo endpoint first
try {
const form = new FormData();
form.append('file', fileToBlob(photoAbsPath, guessMime(photoAbsPath)), path.basename(photoAbsPath));

const r = await heygenFetch(HEYGEN_TALKING_PHOTO_ENDPOINT, { method: 'POST', body: form });
const j = await r.json();
if (r.ok) {
const d = j.data || j;
const talkingPhotoId = d.talking_photo_id || d.id;
if (talkingPhotoId) return { talkingPhotoId, raw: j };
}
} catch (_e) {
// fallback below
}

// Fallback: upload asset and use returned talking_photo_id if account returns it
const up = await heygenUploadAsset(photoAbsPath, 'image');
const talkingPhotoId = up.raw?.data?.talking_photo_id || up.raw?.talking_photo_id;
if (!talkingPhotoId) {
throw new Error('Could not create talking photo. Check HeyGen account permissions/endpoints.');
}
return { talkingPhotoId, raw: up.raw };
}

async function heygenGenerateVideo({ talkingPhotoId, audioAssetId, style, callbackId }) {
const payload = {
title: `User Video ${callbackId}`,
callback_id: callbackId,
video_inputs: [
{
character: {
type: 'talking_photo',
talking_photo_id: talkingPhotoId,
talking_style: 'expressive',
expression: 'default',
super_resolution: true,
matting: false,
...(style ? { prompt: style, use_avatar_iv_model: true } : {})
},
voice: {
type: 'audio',
audio_asset_id: audioAssetId
},
background: {
type: 'color',
value: '#101218'
}
}
]
};

const r = await heygenFetch(HEYGEN_VIDEO_GENERATE_ENDPOINT, {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify(payload)
});
const j = await r.json();
if (!r.ok) throw new Error(`HeyGen generate failed: ${JSON.stringify(j)}`);

const d = j.data || j;
return {
videoId: d.video_id || d.id || d.videoId,
raw: j
};
}

async function heygenCheckVideo(videoId) {
const endpoint = HEYGEN_VIDEO_STATUS_ENDPOINT_TEMPLATE.replace('{videoId}', encodeURIComponent(videoId));
const r = await heygenFetch(endpoint, { method: 'GET' });
const j = await r.json();
if (!r.ok) throw new Error(`HeyGen status failed: ${JSON.stringify(j)}`);

const d = j.data || j;
const status = (d.status || d.video_status || '').toLowerCase();
const videoUrl = d.video_url || d.url || d.videoUrl || null;
return { status, videoUrl, raw: j };
}

async function pollHeyGenUntilDone(jobId, videoId) {
const maxAttempts = 60; // ~10 min at 10s
for (let i = 0; i < maxAttempts; i += 1) {
await new Promise((r) => setTimeout(r, 10000));
try {
const s = await heygenCheckVideo(videoId);
if (['completed', 'success', 'done'].includes(s.status) && s.videoUrl) {
updateVideoJob(jobId, { status: 'completed', output: s.videoUrl, providerMeta: s.raw });
return;
}
if (['failed', 'error'].includes(s.status)) {
updateVideoJob(jobId, { status: 'failed', error: 'HeyGen render failed', providerMeta: s.raw });
return;
}
updateVideoJob(jobId, { providerMeta: s.raw });
} catch (e) {
updateVideoJob(jobId, { providerMeta: { statusCheckError: String(e.message || e) } });
}
}
updateVideoJob(jobId, { status: 'failed', error: 'HeyGen timeout' });
}

// ---------- Video generation ----------
app.post(
'/api/video-jobs',
requireAuth,
upload.fields([{ name: 'photo', maxCount: 1 }, { name: 'audio', maxCount: 1 }]),
async (req, res) => {
try {
const photo = req.files?.photo?.[0];
const audio = req.files?.audio?.[0];
const style = req.body.style || 'cinematic';

if (!photo || !audio) return res.status(400).json({ error: 'Photo and audio are required.' });
if (!consumeCredits(req.session.user.userId, CREDITS_PER_VIDEO)) {
return res.status(402).json({ error: 'Not enough credits.' });
}

const input = {
photo: `video-jobs/${req.jobId}/${photo.filename}`,
audio: `video-jobs/${req.jobId}/${audio.filename}`,
style
};
const job = createVideoJob(req.session.user.userId, input);

if (VIDEO_PROVIDER !== 'heygen' || !HEYGEN_API_KEY) {
// fallback mock
const demo = path.join(__dirname, 'public', 'demo-output.mp4');
const outDir = path.join(UPLOAD_DIR, 'video-jobs', job.jobId);
const outPath = path.join(outDir, 'output.mp4');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

setTimeout(() => {
if (fs.existsSync(demo)) {
fs.copyFileSync(demo, outPath);
updateVideoJob(job.jobId, { status: 'completed', output: `/uploads/video-jobs/${job.jobId}/output.mp4` });
} else {
updateVideoJob(job.jobId, { status: 'failed', error: 'Missing demo-output.mp4' });
}
}, 6000);

return res.json({ ok: true, jobId: job.jobId, provider: 'mock', balance: getCredits(req.session.user.userId) });
}

// real heygen path
const photoAbs = path.join(UPLOAD_DIR, input.photo);
const audioAbs = path.join(UPLOAD_DIR, input.audio);

const tp = await heygenCreateTalkingPhoto(photoAbs);
const au = await heygenUploadAsset(audioAbs, 'audio');
if (!au.assetId) throw new Error('Could not get HeyGen audio asset ID');

const gen = await heygenGenerateVideo({
talkingPhotoId: tp.talkingPhotoId,
audioAssetId: au.assetId,
style,
callbackId: job.jobId
});

if (!gen.videoId) throw new Error('No HeyGen video ID returned');

updateVideoJob(job.jobId, {
providerVideoId: gen.videoId,
providerMeta: { talkingPhoto: tp.raw, audioUpload: au.raw, generate: gen.raw }
});

pollHeyGenUntilDone(job.jobId, gen.videoId).catch((e) => {
updateVideoJob(job.jobId, { status: 'failed', error: String(e.message || e) });
});

return res.json({
ok: true,
jobId: job.jobId,
provider: 'heygen',
providerVideoId: gen.videoId,
balance: getCredits(req.session.user.userId)
});
} catch (e) {
console.error(e);
return res.status(500).json({ error: e.message || 'Video job failed' });
}
}
);

app.get('/api/video-jobs', requireAuth, (req, res) => {
const rows = readJson(VIDEOS_FILE).filter((r) => r.userId === req.session.user.userId);
res.json(rows);
});

app.get('/api/video-jobs/:jobId/download', requireAuth, (req, res) => {
const rows = readJson(VIDEOS_FILE);
const row = rows.find((r) => r.jobId === req.params.jobId && r.userId === req.session.user.userId);
if (!row) return res.status(404).json({ error: 'Not found' });
if (row.status !== 'completed' || !row.output) return res.status(409).json({ error: 'Not ready' });

// If HeyGen returns hosted URL, redirect to it
if (String(row.output).startsWith('http')) return res.redirect(row.output);

// Else local file
const local = row.output.startsWith('/uploads/')
? path.join(UPLOAD_DIR, row.output.replace('/uploads/', ''))
: path.join(UPLOAD_DIR, row.output);

if (!fs.existsSync(local)) return res.status(404).json({ error: 'Output missing' });
return res.download(local, `${row.jobId}.mp4`);
});

app.listen(PORT, () => {
console.log(`App running on http://localhost:${PORT} provider=${VIDEO_PROVIDER}`);
});

