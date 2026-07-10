// Gmail search queries, proven against a real 12-month inbox on 2026-07-10.
// All read-only. Q2/Q4-style bare subject sweeps were dropped: everything they
// found, these three found first, with far less newsletter noise.

export const GMAIL_QUERIES = [
  {
    id: "processors",
    query:
      "from:(stripe.com OR paddle.com OR paddle.net OR lemonsqueezy.com OR gumroad.com OR paypal.com) newer_than:2y",
  },
  {
    id: "app_stores",
    query:
      "from:(no_reply@email.apple.com OR googleplay-noreply@google.com) newer_than:2y",
  },
  {
    id: "known_billers",
    query:
      "from:(openai.com OR anthropic.com OR github.com OR netflix.com OR spotify.com OR adobe.com OR notion.so OR figma.com OR canva.com OR dropbox.com OR substack.com OR midjourney.com OR elevenlabs.io OR vercel.com OR cloudflare.com OR perplexity.ai OR google.com) subject:(receipt OR invoice OR payment OR renewal OR charged) newer_than:2y",
  },
] as const;

// Senders that match the queries but are never billing mail.
// Filtering must be sender-based: PR notifications and newsletters routinely
// carry "payment" or "$" in their subjects.
export const IGNORE_SENDERS = [
  "notifications@github.com",
  "notifications@stripe.com",
  "googleone-noreply@google.com",
  "googleone-updates-noreply@google.com",
] as const;
