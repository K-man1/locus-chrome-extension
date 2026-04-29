// Optional Cloudflare Worker patch for the Locus Chrome extension's
// Google Calendar OAuth flow.
//
// The deployed worker at https://locus-proxy.locus-proxy.workers.dev/ already
// exposes `/oauth/google` (auth-code redirect for the macOS app) and
// `POST /oauth/google/refresh`. The macOS app receives tokens via a custom URL
// scheme; the extension instead uses chrome.identity.launchWebAuthFlow, which
// requires the worker to redirect tokens back to a chromiumapp.org URL.
//
// To support the extension flow without breaking the macOS one, add this
// branch to the worker's `/oauth/google` handler:
//
//   if (url.searchParams.has("code") && url.searchParams.has("state")) {
//     const code = url.searchParams.get("code");
//     const state = decodeURIComponent(url.searchParams.get("state"));
//     // If state looks like an extension redirect URL, treat it as the
//     // extension flavor: bounce tokens back via fragment.
//     if (state.startsWith("https://") && state.includes(".chromiumapp.org/")) {
//       const tokenResp = await exchangeCode(code, env.GOOGLE_CLIENT_ID,
//                                            env.GOOGLE_CLIENT_SECRET,
//                                            `${url.origin}/oauth/google`);
//       const params = new URLSearchParams({
//         access_token: tokenResp.access_token,
//         expires_in: String(tokenResp.expires_in || 3600),
//         refresh_token: tokenResp.refresh_token || "",
//         token_type: tokenResp.token_type || "Bearer"
//       });
//       return Response.redirect(`${state}#${params.toString()}`, 302);
//     }
//   }
//
// `exchangeCode` is the same helper the macOS path already uses to POST to
// https://oauth2.googleapis.com/token with grant_type=authorization_code.
//
// Until this branch ships, the extension's "Connect Google Calendar" button
// will return tokens only if the user manually completes the flow — set
// GOOGLE_CLIENT_ID_FOR_WORKER in lib/calendar.js to the same public client ID
// configured on the worker.
