// Receives a complaint submitted through file-complaint.html and queues it
// for the CM Cell bot (which runs on a separate PC, not on Vercel) by
// committing it as pending/<id>.json to this same GitHub repo via the
// Contents API. The bot does a `git pull` in its local checkout of this
// repo and picks the file up once the resident "claims" it on Telegram
// (see cm_cell_bot/web_queue.py and bot.py's CLAIM handling) - Telegram
// only lets a bot message a chat that has messaged it first, so this queue
// step alone can't file anything; it just hands off the data.

const REQUIRED_FIELDS = [
  "issueType",
  "issueAddress",
  "localBody",
  "duration",
  "description",
  "complainantAddress",
  "reporter",
  "phone",
];

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
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
    if (!body[key] || !String(body[key]).trim()) {
      res.status(400).json({ error: `Missing field: ${key}` });
      return;
    }
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    res.status(500).json({ error: "Server is not configured (missing GITHUB_TOKEN)" });
    return;
  }

  const repo = process.env.GITHUB_REPO || "sudersonsarathy/our-area-our-right";
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const path = `pending/${id}.json`;

  const payload = {
    id,
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

  res.status(200).json({ ok: true, id });
};
