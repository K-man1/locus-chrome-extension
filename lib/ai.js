// AI evaluator — talks to the Locus Cloudflare Worker.
// Worker URL is public; it holds the upstream API key as a server secret.

import { getDeviceId } from "./storage.js";

const PROXY_URL = "https://locus-proxy.locus-proxy.workers.dev/";

const REASON_PROMPT = `You are a fair focus session enforcer.

Session: **{session}**
Blocked website: **{domain}**
User's reason: "{reason}"

Approve only if the reason is plausibly important for the current session.
Give the benefit of the doubt for clearly study-adjacent reasons. Be stricter for
sites like YouTube, Netflix, Reddit, TikTok — entertainment dressed as research.

Respond in EXACTLY this format, two lines:
DECISION: APPROVED or DENIED
REASON: One sentence.`;

const SITE_RELEVANCE_PROMPT = `A user is in a focus session: **{session}**

They just opened: **{domain}**{titleHint}

Is this OBVIOUSLY and CLEARLY relevant to the session? AUTO_ALLOW only when there is no reasonable doubt.

AUTO_ALLOW examples: Desmos during Math, Khan Academy, Stack Overflow during coding, dictionary/Wikipedia.
ASK examples: YouTube, Reddit, Twitter, TikTok, Netflix, shopping, anything ambiguous.

Respond in EXACTLY this format:
DECISION: AUTO_ALLOW or ASK
REASON: One sentence.`;

async function post(prompt) {
  const deviceId = await getDeviceId();
  const resp = await fetch(PROXY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, device_id: deviceId })
  });
  if (resp.status === 429) {
    return { ok: false, text: "", err: "rate limited — try again in a bit" };
  }
  if (!resp.ok) {
    return { ok: false, text: "", err: `worker error ${resp.status}` };
  }
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
  return { approved: approveTokens.includes(decision), reason: reason || "No reason given." };
}

export async function evaluateReason({ domain, session, reason }) {
  const prompt = REASON_PROMPT
    .replace("{session}", session)
    .replace("{domain}", domain)
    .replace("{reason}", reason);
  const { ok, text, err } = await post(prompt);
  if (!ok) return { approved: false, reason: `AI evaluator unreachable: ${err}` };
  return parseDecision(text, ["APPROVED"]);
}

export async function evaluateSiteRelevance({ domain, session, title }) {
  const titleHint = title ? `\nThe page title is: "${title}"` : "";
  const prompt = SITE_RELEVANCE_PROMPT
    .replace("{session}", session)
    .replace("{domain}", domain)
    .replace("{titleHint}", titleHint);
  const { ok, text } = await post(prompt);
  if (!ok) return { approved: false, reason: "" }; // fail closed → ask
  const { approved, reason } = parseDecision(text, ["AUTO_ALLOW"]);
  return { approved, reason };
}
