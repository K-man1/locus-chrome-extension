// AI evaluator — talks to the Locus Cloudflare Worker.
// Worker URL is public; it holds the upstream API key as a server secret.

import { getDeviceId, getState } from "./storage.js";

export const PROXY_URL = "https://locus-proxy.locus-proxy.workers.dev/";

const DEFAULT_REASON_PROMPT = `You are a fair focus session enforcer.

Current task: **{task}**
Blocked website: **{domain}**
User's reason: "{reason}"

Approve only if the reason is plausibly important for the current task.
Give the benefit of the doubt for clearly study-adjacent reasons. Be stricter for
sites like YouTube, Netflix, Reddit, TikTok — entertainment dressed as research.
{harshness}

Respond in EXACTLY this format, two lines:
DECISION: APPROVED or DENIED
REASON: One sentence.`;

const DEFAULT_SITE_PROMPT = `A user is focusing on this task: **{task}**

They just opened: **{domain}**{titleHint}

Is this OBVIOUSLY and CLEARLY relevant to the task? AUTO_ALLOW only when there is no reasonable doubt.

AUTO_ALLOW examples: Desmos for a math task, Khan Academy, Stack Overflow during coding, dictionary/Wikipedia.
ASK examples: YouTube, Reddit, Twitter, TikTok, Netflix, shopping, anything ambiguous.

Respond in EXACTLY this format:
DECISION: AUTO_ALLOW or ASK
REASON: One sentence.`;

const DEFAULT_TITLE_PROMPT = `A user is focusing on this task: **{task}**
Originally approved access to: **{domain}**

The current page title on that domain is: "{tabTitle}"

Is this clearly on-task, or is it drift?

OFF-TOPIC examples:
- Approved YouTube for a math tutorial, but the title is about Minecraft
- Approved Google for research, but the title shows celebrity news
- Approved a coding doc, but the title is now a sports article

Be lenient for search pages, homepages, and ambiguous titles. Be strict when
the title clearly contradicts the task. Allow brief tangents.

Respond in EXACTLY this format:
DECISION: ON_TOPIC or OFF_TOPIC
REASON: One sentence.`;

const HARSHNESS_NOTE = {
  Lenient: "Tone: lenient. Lean toward approval; deny only if clearly off-topic.",
  Standard: "",
  Strict: "Tone: strict. Require a clear, direct connection to the task. Deny on doubt."
};

async function post(prompt) {
  const deviceId = await getDeviceId();
  const resp = await fetch(PROXY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, device_id: deviceId })
  });
  if (resp.status === 429) return { ok: false, text: "", err: "rate limited — try again in a bit" };
  if (!resp.ok) return { ok: false, text: "", err: `worker error ${resp.status}` };
  const data = await resp.json().catch(() => ({}));
  return { ok: true, text: (data.text || "").trim(), err: "" };
}

function parseDecision(text, approveTokens) {
  let decision = "";
  let reason = "";
  for (const line of text.split("\n")) {
    const upper = line.toUpperCase().trim();
    if (upper.startsWith("DECISION:")) {
      decision = upper.slice("DECISION:".length).trim();
    } else if (upper.startsWith("REASON:")) {
      const idx = line.indexOf(":");
      reason = idx >= 0 ? line.slice(idx + 1).trim() : line.trim();
    }
  }
  return { approved: approveTokens.includes(decision), decision, reason: reason || "No reason given." };
}

function fillTemplate(tpl, vars) {
  let out = tpl;
  for (const [k, v] of Object.entries(vars)) {
    out = out.split("{" + k + "}").join(v);
  }
  return out;
}

async function getPromptOverrides() {
  const { prompts, harshness } = await getState();
  // Backwards-compat: rewrite stored {activity} → {task} on the fly.
  const norm = (s) => (s || "").replace(/\{activity\}/g, "{task}").replace(/\{session\}/g, "{task}");
  return {
    reason: norm(prompts?.reason).trim() || DEFAULT_REASON_PROMPT,
    site: norm(prompts?.site).trim() || DEFAULT_SITE_PROMPT,
    title: norm(prompts?.title).trim() || DEFAULT_TITLE_PROMPT,
    harshness: HARSHNESS_NOTE[harshness] || ""
  };
}

export async function evaluateReason({ domain, task, reason }) {
  const tpls = await getPromptOverrides();
  const prompt = fillTemplate(tpls.reason, {
    domain, reason, task: task || "(no specific task)", harshness: tpls.harshness
  });
  const { ok, text, err } = await post(prompt);
  if (!ok) return { approved: false, reason: `AI evaluator unreachable: ${err}` };
  return parseDecision(text, ["APPROVED"]);
}

export async function evaluateSiteRelevance({ domain, task, url }) {
  const tpls = await getPromptOverrides();
  let titleHint = "";
  if (url) {
    try {
      const u = new URL(url);
      const q = u.searchParams.get("q") || u.searchParams.get("query") || u.searchParams.get("search");
      if (q) titleHint = `\nThe user searched for: "${q}"`;
      else if (u.pathname && u.pathname.length > 1) titleHint = `\nThe URL path is: ${u.pathname}`;
    } catch {}
  }
  const prompt = fillTemplate(tpls.site, {
    domain, titleHint, task: task || "(no specific task)"
  });
  const { ok, text } = await post(prompt);
  if (!ok) return { approved: false, reason: "" };
  const { approved, reason } = parseDecision(text, ["AUTO_ALLOW"]);
  return { approved, reason };
}

export async function evaluateTitle({ domain, task, tabTitle }) {
  const tpls = await getPromptOverrides();
  const prompt = fillTemplate(tpls.title, {
    domain, tabTitle: tabTitle || "", task: task || "(no specific task)"
  });
  const { ok, text } = await post(prompt);
  if (!ok) return { onTopic: true, reason: "" }; // fail open
  const { decision, reason } = parseDecision(text, ["ON_TOPIC"]);
  return { onTopic: decision === "ON_TOPIC", reason };
}

export const PROMPT_DEFAULTS = {
  reason: DEFAULT_REASON_PROMPT,
  site: DEFAULT_SITE_PROMPT,
  title: DEFAULT_TITLE_PROMPT
};
