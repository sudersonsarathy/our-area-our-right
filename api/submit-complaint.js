// Receives a complaint submitted through file-complaint.html and queues it
// for the CM Cell bot (which runs on a separate PC, not on Vercel) by
// committing it as pending/<id>.json to this same GitHub repo via the
// Contents API. The bot does a `git pull` in its local checkout of this
// repo and picks the file up once the resident "claims" it on Telegram
// (see cm_cell_bot/web_queue.py and bot.py's CLAIM handling) - Telegram
// only lets a bot message a chat that has messaged it first, so this queue
// step alone can't file anything; it just hands off the data.
//
// Security notes:
// - This endpoint is public and unauthenticated by nature (anyone should be
//   able to submit a complaint), so two things guard against abuse:
//   1. A PIN generated here and returned ONLY in this response (never
//      stored anywhere public) must be echoed back in the Telegram CLAIM
//      message alongside the id - a bare id isn't enough to claim someone
//      else's submission.
//   2. A simple per-IP rate limit, kept in memory for this warm function
//      instance. It resets on cold start and isn't shared across scaled-out
//      instances, so it's a speed bump against a casual flood, not a
//      distributed-attack-proof limiter - that would need a shared store
//      (Redis/KV), deliberately not added here to avoid new infra for what
//      is a low-stakes civic form, not a high-value target.

const crypto = require("crypto");

const MAX_LENGTHS = {
  issueType: 100,
  issueAddress: 300,
  localBody: 150,
  duration: 150,
  description: 3000,
  complainantAddress: 300,
  reporter: 150,
  phone: 20,
};
const REQUIRED_FIELDS = Object.keys(MAX_LENGTHS);

const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX = 5;
const _rateLimitHits = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const hits = (_rateLimitHits.get(ip) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  hits.push(now);
  _rateLimitHits.set(ip, hits);
  // occasional cleanup so the map doesn't grow unbounded across a long-lived warm instance
  if (_rateLimitHits.size > 500) {
    for (const [key, timestamps] of _rateLimitHits) {
      if (timestamps.every((t) => now - t >= RATE_LIMIT_WINDOW_MS)) _rateLimitHits.delete(key);
    }
  }
  return hits.length > RATE_LIMIT_MAX;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
  if (isRateLimited(ip)) {
    res.status(429).json({ error: "Too many submissions from this network recently - please wait a while and try again." });
    return;
  }

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch (e) {
      body = {};
    }
  }
  body = body || {};

  for (const key of REQUIRED_FIELDS) {
    const value = String(body[key] ?? "").trim();
    if (!value) {
      res.status(400).json({ error: `Missing field: ${key}` });
      return;
    }
    if (value.length > MAX_LENGTHS[key]) {
      res.status(400).json({ error: `${key} is too long (max ${MAX_LENGTHS[key]} characters)` });
      return;
    }
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    res.status(500).json({ error: "Server is not configured (missing GITHUB_TOKEN)" });
    return;
  }

  const repo = process.env.GITHUB_REPO || "sudersonsarathy/our-area-our-right";
  const id = crypto.randomBytes(8).toString("hex");
  const pin = crypto.randomInt(100000, 1000000).toString();
  const path = `pending/${id}.json`;

  const payload = {
    id,
    pin,
    submittedAt: new Date().toISOString(),
    issueType: String(body.issueType).trim(),
    issueAddress: String(body.issueAddress).trim(),
    localBody: String(body.localBody).trim(),
    duration: String(body.duration).trim(),
    description: String(body.description).trim(),
    complainantAddress: String(body.complainantAddress).trim(),
    reporter: String(body.reporter).trim(),
    phone: String(body.phone).trim(),
    hasPhoto: !!body.hasPhoto,
  };

  const content = Buffer.from(JSON.stringify(payload, null, 2), "utf-8").toString("base64");

  let ghRes;
  try {
    ghRes = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "our-area-our-right-complaint-form",
        Accept: "application/vnd.github+json",
      },
      body: JSON.stringify({
        message: `New web complaint submission ${id}`,
        content,
      }),
    });
  } catch (err) {
    res.status(502).json({ error: "Could not reach GitHub to queue the submission" });
    return;
  }

  if (!ghRes.ok) {
    const detail = await ghRes.text().catch(() => "");
    res.status(502).json({ error: "Failed to queue submission", detail });
    return;
  }

  res.status(200).json({ ok: true, id, pin });
};
