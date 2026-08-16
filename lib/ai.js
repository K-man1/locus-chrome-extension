// AI evaluator — talks directly to the Hack Club AI gateway (OpenAI-compatible,
// OpenRouter passthrough). No proxy, no fallback.
//
// NOTE: the key is read from lib/secrets.local.js, which is gitignored. It still
// gets embedded in the built extension, so anyone who installs it can read it.
// That is intentional for this build — it just doesn't belong in a public repo.
// Setup: cp lib/secrets.example.js lib/secrets.local.js

import { getState } from "./storage.js";
import { resolveSettings } from "./lockdown.js";
import { AI_KEY } from "./secrets.local.js";

const AI_URL = "https://ai.hackclub.com/proxy/v1/chat/completions";
// Cheap and fast, but actually reads the task text. 4o-mini was here and failed
// the basic case: task "programming ww2explained.com and Paperfill app", page
// titled "Paperfill — Your Handwriting" → it said ASK.
const AI_MODEL = "google/gemini-3.5-flash-lite";
const DEFAULT_REASON_PROMPT = `You are a fair but firm focus session enforcer.

Current task: **{task}**
Blocked website: **{domain}**{titleHint}
User's reason: "{reason}"

Decide whether visiting THIS specific page genuinely serves the current task.

Weigh all the evidence together — the page title, the search query, the URL, the
user's reason, and the task. A site's category is a prior, not a verdict: YouTube,
Reddit, search engines and the like host plenty of legitimate study material. If
the specific page and the user's reason line up with the task, APPROVE it even on
an "entertainment" site — a course lecture on YouTube for a course task is on-task.

Topical overlap is enough. The page need not repeat the task's wording; if it
covers a concept, subtopic or skill the task plainly involves, it serves the task
(precalculus covers trig, sine waves and graphing; a coding task covers its
language, libraries and error messages). When a search query is given, judge the
query itself — a short or generic query is still evidence of intent.

Deny when the page or query clearly points somewhere else (entertainment dressed
up as research), or when the reason is vague AND nothing else on the page ties it
to the task. Do not deny solely because the query is broad or the domain is a
common procrastination site.
{harshness}

Respond in EXACTLY this format, two lines:
DECISION: APPROVED or DENIED
REASON: One sentence.`;

const DEFAULT_SITE_PROMPT = `A user is focusing on this task: **{task}**

They just opened: **{domain}**{titleHint}

Decide AUTO_ALLOW (let them straight through) or ASK (make them justify it).

Judge the CONTENT signal, not the domain:
- If a search query is given, the query IS the content — judge the query against
  the task and ignore which search engine it went through. A search engine is a
  tool, not a distraction; only what was searched decides. A short or generic
  query is still a signal: "sin graph" during a precalculus task is on-task.
- If a page title is given, judge what the page actually is. A clearly on-task
  video or thread should AUTO_ALLOW even on YouTube or Reddit.
- With neither a title nor a query (a bare homepage), there is no content signal
  to go on — ASK.

Topical overlap is enough. The page does not have to be a named "resource" or
"tool", and does not have to repeat the task's wording. If it covers a concept,
subtopic, or skill the task plainly involves, it serves the task: precalculus
covers trig, sine waves and graphing; a history essay covers its people and
events; a coding task covers its language, libraries and error messages.

ASK only when there is no content signal at all, or the signal clearly points
elsewhere. Do not ASK merely because the domain is a common procrastination site,
or because the query is short, vague, or general.

AUTO_ALLOW examples: Desmos for a math task, Khan Academy, Stack Overflow during
coding, dictionary/Wikipedia, a video whose title matches the task, a search
whose query names any subtopic of the task.
ASK examples: a bare YouTube/Reddit/Twitter/TikTok/Netflix homepage with no title
or query, shopping, a search for "nba scores" during a precalculus task.

Respond in EXACTLY this format:
DECISION: AUTO_ALLOW or ASK
REASON: One sentence.`;

const DEFAULT_TITLE_PROMPT = `A user is focusing on this task: **{task}**
Originally approved access to: **{domain}**
Reason for approval: "{approvalReason}"{contextNote}

The current page title on that domain is: "{tabTitle}"

Judge drift from the TITLE. Does what this title describes still serve the task
(or the original reason for approval)?

OFF-TOPIC examples:
- Approved YouTube for a math tutorial, but the title is about Minecraft
- Approved Google for research, but the title shows celebrity news
- Approved a coding doc, but the title is now a sports article

Be lenient for search pages, homepages, and ambiguous titles. Be strict only when
the title clearly contradicts the task. Topical overlap counts — a title naming
any concept or subtopic the task involves is ON_TOPIC, even if it does not repeat
the task's wording.

If the current page still relates to the original reason for approval, allow it.

Respond in EXACTLY this format:
DECISION: ON_TOPIC or OFF_TOPIC
REASON: One sentence.`;

const HARSHNESS_NOTE = {
  Lenient: "Tone: lenient. Lean toward approval; deny only if clearly off-topic.",
  Standard: "",
  Strict: "Tone: strict. Require a clear, direct connection to the task. Deny on doubt."
};

async function post(prompt) {
  let resp;
  try {
    resp = await fetch(AI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${AI_KEY}`
      },
      body: JSON.stringify({
        model: AI_MODEL,
        messages: [{ role: "user", content: prompt }]
      })
    });
  } catch {
    return { ok: false, text: "", err: "network error" };
  }
  if (resp.status === 429) return { ok: false, text: "", err: "rate limited — try again in a bit" };
  if (!resp.ok) return { ok: false, text: "", err: `AI error ${resp.status}` };
  const data = await resp.json().catch(() => ({}));
  const text = (data?.choices?.[0]?.message?.content || "").trim();
  return { ok: true, text, err: "" };
}

function parseDecision(text, approveTokens) {
  let decision = "";
  let reason = "";
  for (const line of text.split("\n")) {
    const upper = line.toUpperCase().trim();
    if (upper.startsWith("DECISION:")) {
      // Models like to answer "**AUTO_ALLOW**" or "APPROVED — it's a lecture".
      // Strip anything that isn't part of a decision token, then take the first
      // word, so decoration can't push us into the deny branch.
      decision = upper.slice("DECISION:".length)
        .replace(/[^A-Z_ ]/g, " ").trim().split(/\s+/)[0] || "";
    } else if (upper.startsWith("REASON:")) {
      const idx = line.indexOf(":");
      reason = idx >= 0 ? line.slice(idx + 1).trim() : line.trim();
    }
  }
  return { approved: approveTokens.includes(decision), decision, reason: reason || "No reason given." };
}

// Build the "here's what the page actually is" hint block shared by the reason
// and site prompts. Prefers the real page <title>; falls back to URL-derived
// signal (search query, then path) when no title is available.
function buildTitleHint({ tabTitle = "", url = "" }) {
  const parts = [];
  const title = (tabTitle || "").trim();
  if (title) parts.push(`Page title: "${title}"`);
  if (url) {
    try {
      const u = new URL(url);
      const q = u.searchParams.get("q") || u.searchParams.get("query") || u.searchParams.get("search");
      if (q) parts.push(`The user searched for: "${q}"`);
      else if (!title && u.pathname && u.pathname.length > 1) parts.push(`The URL path is: ${u.pathname}`);
    } catch {}
  }
  return parts.length ? "\n" + parts.join("\n") : "";
}

function fillTemplate(tpl, vars) {
  let out = tpl;
  for (const [k, v] of Object.entries(vars)) {
    out = out.split("{" + k + "}").join(v);
  }
  return out;
}

async function getPromptOverrides() {
  const state = await getState();
  const { prompts } = state;
  // Harshness is overridable per lockdown, so read the effective one — a lock
  // set to Strict should judge that way even if the global is Lenient.
  const { harshness } = resolveSettings(state);
  return {
    reason: (prompts?.reason || "").trim() || DEFAULT_REASON_PROMPT,
    site: (prompts?.site || "").trim() || DEFAULT_SITE_PROMPT,
    title: (prompts?.title || "").trim() || DEFAULT_TITLE_PROMPT,
    harshness: HARSHNESS_NOTE[harshness] || ""
  };
}

export async function evaluateReason({ domain, task, reason, tabTitle = "", url = "" }) {
  const tpls = await getPromptOverrides();
  const titleHint = buildTitleHint({ tabTitle, url });
  const prompt = fillTemplate(tpls.reason, {
    domain, reason, titleHint, task: task || "(no specific task)", harshness: tpls.harshness
  });
  const { ok, text, err } = await post(prompt);
  if (!ok) return { approved: false, reason: `AI evaluator unreachable: ${err}`, transient: true };
  return parseDecision(text, ["APPROVED"]);
}

export async function evaluateSiteRelevance({ domain, task, url, tabTitle = "" }) {
  const tpls = await getPromptOverrides();
  const titleHint = buildTitleHint({ tabTitle, url });
  const prompt = fillTemplate(tpls.site, {
    domain, titleHint, task: task || "(no specific task)"
  });
  const { ok, text, err } = await post(prompt);
  if (!ok) return { approved: false, reason: `AI evaluator unreachable: ${err}`, transient: true };
  const { approved, reason } = parseDecision(text, ["AUTO_ALLOW"]);
  return { approved, reason };
}

export async function evaluateTitle({ domain, task, tabTitle, approvalReason = "" }) {
  const tpls = await getPromptOverrides();
  const contextNote = approvalReason ? "" : "\n(No specific reason was recorded for the approval.)";
  const prompt = fillTemplate(tpls.title, {
    domain, tabTitle: tabTitle || "", task: task || "(no specific task)",
    approvalReason: approvalReason || "unknown", contextNote
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
