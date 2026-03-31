const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const session = require('express-session');
const bcrypt = require('bcryptjs');

const app = express();
const PORT = process.env.PORT || 3000;

const SESSION_SECRET = process.env.SESSION_SECRET || 'change-this-session-secret';
const PAYPAL_EMAIL = process.env.PAYPAL_EMAIL || 'rangerbleau11@gmail.com';
const PAYPAL_SUBSCRIPTION_PRICE = Number(process.env.PAYPAL_SUBSCRIPTION_PRICE || 29.99);
const PAYPAL_CREDITS_PRICE = Number(process.env.PAYPAL_CREDITS_PRICE || 9.99);

const MUSIC_JOB_CREDIT_COST = Number(process.env.MUSIC_JOB_CREDIT_COST || 1000);
const TRIAL_DAYS = Number(process.env.TRIAL_DAYS || 7);
const TRIAL_CREDITS = Number(process.env.TRIAL_CREDITS || 1000);
const MONTHLY_CREDITS = Number(process.env.MONTHLY_CREDITS || 5000);
const ADDON_CREDITS = Number(process.env.ADDON_CREDITS || 1000);

const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SUBSCRIPTIONS_FILE = path.join(DATA_DIR, 'subscriptions.json');
const CREDITS_FILE = path.join(DATA_DIR, 'credits.json');
const MUSIC_JOBS_FILE = path.join(DATA_DIR, 'music_jobs.json');

for (const dir of [DATA_DIR, UPLOAD_DIR]) {
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
for (const file of [USERS_FILE, SUBSCRIPTIONS_FILE, CREDITS_FILE, MUSIC_JOBS_FILE]) {
if (!fs.existsSync(file)) fs.writeFileSync(file, '[]', 'utf8');
}

function readJson(filePath) {
return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}
function writeJson(filePath, data) {
fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}
function requireAuth(req, res, next) {
if (!req.session.user) return res.status(401).json({ error: 'Please log in.' });
return next();
}

function upsertSubscriptionByUser(userId, patch) {
const rows = readJson(SUBSCRIPTIONS_FILE);
const idx = rows.findIndex((r) => r.userId === userId);
const current = idx >= 0 ? rows[idx] : { userId };
const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
if (idx >= 0) rows[idx] = next;
else rows.push(next);
writeJson(SUBSCRIPTIONS_FILE, rows);
return next;
}
function getSubscription(userId) {
const rows = readJson(SUBSCRIPTIONS_FILE);
return rows.find((s) => s.userId === userId) || null;
}
function getCreditBalance(userId) {
const rows = readJson(CREDITS_FILE);
const row = rows.find((r) => r.userId === userId);
return row ? Number(row.balance || 0) : 0;
}
function addCredits(userId, amount, reason = 'manual') {
const rows = readJson(CREDITS_FILE);
const idx = rows.findIndex((r) => r.userId === userId);
const current = idx >= 0 ? Number(rows[idx].balance || 0) : 0;
const next = { userId, balance: current + amount, updatedAt: new Date().toISOString(), lastReason: reason };
if (idx >= 0) rows[idx] = next;
else rows.push(next);
writeJson(CREDITS_FILE, rows);
return next.balance;
}
function consumeCredits(userId, amount, reason = 'usage') {
const rows = readJson(CREDITS_FILE);
const idx = rows.findIndex((r) => r.userId === userId);
const current = idx >= 0 ? Number(rows[idx].balance || 0) : 0;
if (current < amount) return { ok: false, balance: current };
const next = { userId, balance: current - amount, updatedAt: new Date().toISOString(), lastReason: reason };
if (idx >= 0) rows[idx] = next;
else rows.push(next);
writeJson(CREDITS_FILE, rows);
return { ok: true, balance: next.balance };
}

function processBillingForUser(userId) {
const sub = getSubscription(userId);
if (!sub || sub.status === 'canceled') return sub;

const now = Date.now();
const trialEnd = sub.trialEndsAt ? new Date(sub.trialEndsAt).getTime() : null;
let current = { ...sub };

if (current.status === 'trialing' && trialEnd && now >= trialEnd) {
current.status = 'active';
current.currentPeriodStart = new Date(trialEnd).toISOString();
current.currentPeriodEnd = new Date(trialEnd + 30 * 24 * 60 * 60 * 1000).toISOString();
current.lastChargeAt = new Date(now).toISOString();
current.lastChargeAmount = PAYPAL_SUBSCRIPTION_PRICE;
addCredits(userId, MONTHLY_CREDITS, 'monthly_subscription_renewal');
current = upsertSubscriptionByUser(userId, current);
}

return current;
}
function hasActiveSubscription(userId) {
const sub = processBillingForUser(userId);
if (!sub) return false;
if (sub.status === 'trialing') return new Date(sub.trialEndsAt).getTime() > Date.now();
if (sub.status === 'active') return new Date(sub.currentPeriodEnd).getTime() > Date.now();
return false;
}

function updateMusicJob(jobId, patch) {
const jobs = readJson(MUSIC_JOBS_FILE);
const idx = jobs.findIndex((j) => j.jobId === jobId);
if (idx < 0) return null;
jobs[idx] = { ...jobs[idx], ...patch, updatedAt: new Date().toISOString() };
writeJson(MUSIC_JOBS_FILE, jobs);
return jobs[idx];
}
function runMockMusicVideoPipeline(jobId) {
setTimeout(() => {
try {
const outputDir = path.join(UPLOAD_DIR, 'music-jobs', jobId);
const outputFilename = 'output.mp4';
const outputPath = path.join(outputDir, outputFilename);
const fallbackSource = path.join(__dirname, 'public', 'demo-output.mp4');

if (fs.existsSync(fallbackSource)) {
fs.copyFileSync(fallbackSource, outputPath);
updateMusicJob(jobId, { status: 'completed', output: `music-jobs/${jobId}/${outputFilename}` });
} else {
updateMusicJob(jobId, { status: 'failed', error: 'Missing demo-output.mp4' });
}
} catch (err) {
console.error(err);
updateMusicJob(jobId, { status: 'failed', error: 'Render failed' });
}
}, 7000);
}

const musicJobStorage = multer.diskStorage({
destination: (req, file, cb) => {
const jobId = req.musicJobId || uuidv4();
req.musicJobId = jobId;
const dir = path.join(UPLOAD_DIR, 'music-jobs', jobId);
fs.mkdirSync(dir, { recursive: true });
cb(null, dir);
},
filename: (_req, file, cb) => {
const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
cb(null, `${Date.now()}-${safeName}`);
}
});
const uploadMusicJobAssets = multer({
storage: musicJobStorage,
limits: { files: 2, fileSize: 512 * 1024 * 1024 }
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
secret: SESSION_SECRET,
resave: false,
saveUninitialized: false,
cookie: { httpOnly: true, sameSite: 'lax', secure: false, maxAge: 1000 * 60 * 60 * 24 * 7 }
}));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/healthz', (_req, res) => {
res.json({ ok: true, service: 'lasting-tribute-music-app', ts: new Date().toISOString() });
});

app.post('/api/auth/signup', async (req, res) => {
try {
const { businessName, contactName, email, password, cardName, cardNumber, cardExp, cardCvc } = req.body;
if (!businessName || !contactName || !email || !password || !cardName || !cardNumber || !cardExp || !cardCvc) {
return res.status(400).json({ error: 'Missing signup fields. Card details are required for 7-day trial.' });
}

const users = readJson(USERS_FILE);
const existing = users.find((u) => u.email.toLowerCase() === email.toLowerCase());
if (existing) return res.status(409).json({ error: 'Email already registered.' });

const cleanedCard = String(cardNumber).replace(/\D/g, '');
if (cleanedCard.length < 12) return res.status(400).json({ error: 'Invalid card number.' });

const passwordHash = await bcrypt.hash(password, 10);
const user = {
userId: uuidv4(),
createdAt: new Date().toISOString(),
businessName, contactName, email, passwordHash,
billing: { cardName, cardLast4: cleanedCard.slice(-4), cardExp }
};
users.push(user);
writeJson(USERS_FILE, users);

const now = Date.now();
upsertSubscriptionByUser(user.userId, {
status: 'trialing',
plan: 'creator_monthly',
trialStartsAt: new Date(now).toISOString(),
trialEndsAt: new Date(now + TRIAL_DAYS * 24 * 60 * 60 * 1000).toISOString(),
amountAfterTrial: PAYPAL_SUBSCRIPTION_PRICE
});

addCredits(user.userId, TRIAL_CREDITS, 'trial_signup_bonus');

req.session.user = { userId: user.userId, businessName: user.businessName, contactName: user.contactName, email: user.email };
return res.json({ success: true, user: req.session.user });
} catch (err) {
console.error(err);
return res.status(500).json({ error: 'Signup failed.' });
}
});

app.post('/api/auth/login', async (req, res) => {
try {
const { email, password } = req.body;
const users = readJson(USERS_FILE);
const user = users.find((u) => u.email.toLowerCase() === String(email).toLowerCase());
if (!user) return res.status(401).json({ error: 'Invalid credentials.' });

const ok = await bcrypt.compare(password, user.passwordHash);
if (!ok) return res.status(401).json({ error: 'Invalid credentials.' });

req.session.user = { userId: user.userId, businessName: user.businessName, contactName: user.contactName, email: user.email };
processBillingForUser(user.userId);
return res.json({ success: true, user: req.session.user });
} catch (err) {
console.error(err);
return res.status(500).json({ error: 'Login failed.' });
}
});

app.post('/api/auth/logout', (req, res) => req.session.destroy(() => res.json({ success: true })));
app.get('/api/auth/me', (req, res) => {
if (req.session.user) processBillingForUser(req.session.user.userId);
res.json({ user: req.session.user || null });
});

app.get('/api/subscription/me', requireAuth, (req, res) => {
const sub = processBillingForUser(req.session.user.userId);
res.json({
subscription: sub,
active: hasActiveSubscription(req.session.user.userId),
paypal: {
email: PAYPAL_EMAIL,
subscriptionLink: `https://www.paypal.com/cgi-bin/webscr?cmd=_xclick&business=${encodeURIComponent(PAYPAL_EMAIL)}&item_name=${encodeURIComponent('AI Music Video App - Monthly Subscription')}&amount=${PAYPAL_SUBSCRIPTION_PRICE.toFixed(2)}&currency_code=USD`,
creditsLink: `https://www.paypal.com/cgi-bin/webscr?cmd=_xclick&business=${encodeURIComponent(PAYPAL_EMAIL)}&item_name=${encodeURIComponent('AI Music Video App - 1000 Credits')}&amount=${PAYPAL_CREDITS_PRICE.toFixed(2)}&currency_code=USD`
}
});
});

app.get('/api/credits/me', requireAuth, (req, res) => {
processBillingForUser(req.session.user.userId);
res.json({ balance: getCreditBalance(req.session.user.userId), costPerVideo: MUSIC_JOB_CREDIT_COST });
});

app.post('/api/credits/manual-add', requireAuth, (req, res) => {
const balance = addCredits(req.session.user.userId, ADDON_CREDITS, 'paypal_9_99_manual');
res.json({ success: true, balance, added: ADDON_CREDITS });
});

app.post('/api/music-jobs', requireAuth, uploadMusicJobAssets.fields([{ name: 'photo', maxCount: 1 }, { name: 'song', maxCount: 1 }]), (req, res) => {
try {
if (!hasActiveSubscription(req.session.user.userId)) {
return res.status(402).json({ error: 'Active trial or subscription required.' });
}

const photoFile = req.files?.photo?.[0];
const songFile = req.files?.song?.[0];
if (!photoFile || !songFile) return res.status(400).json({ error: 'photo and song are required.' });

const debit = consumeCredits(req.session.user.userId, MUSIC_JOB_CREDIT_COST, 'music_video_generation');
if (!debit.ok) return res.status(402).json({ error: `Not enough credits. ${MUSIC_JOB_CREDIT_COST} required.` });

const jobId = req.musicJobId || uuidv4();
const jobs = readJson(MUSIC_JOBS_FILE);
const job = {
jobId, userId: req.session.user.userId, createdAt: new Date().toISOString(), status: 'processing',
input: { photo: `music-jobs/${jobId}/${photoFile.filename}`, song: `music-jobs/${jobId}/${songFile.filename}` },
output: null
};
jobs.push(job);
writeJson(MUSIC_JOBS_FILE, jobs);

runMockMusicVideoPipeline(jobId);
return res.json({ success: true, job, remainingCredits: debit.balance, costPerVideo: MUSIC_JOB_CREDIT_COST });
} catch (err) {
console.error(err);
return res.status(500).json({ error: 'Failed to create music video job.' });
}
});

app.get('/api/music-jobs/me', requireAuth, (req, res) => {
const jobs = readJson(MUSIC_JOBS_FILE).filter((j) => j.userId === req.session.user.userId);
res.json(jobs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)));
});

app.get('/api/music-jobs/:jobId/download', requireAuth, (req, res) => {
const jobs = readJson(MUSIC_JOBS_FILE);
const job = jobs.find((j) => j.jobId === req.params.jobId && j.userId === req.session.user.userId);
if (!job) return res.status(404).json({ error: 'Job not found.' });
if (job.status !== 'completed' || !job.output) return res.status(409).json({ error: 'Job not ready yet.' });

const absolutePath = path.join(UPLOAD_DIR, job.output);
if (!fs.existsSync(absolutePath)) return res.status(404).json({ error: 'Output missing.' });
return res.download(absolutePath, `${job.jobId}.mp4`);
});

app.listen(PORT, () => console.log(`Music app running on http://localhost:${PORT}`));
