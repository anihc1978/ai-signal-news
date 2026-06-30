// netlify/functions/news.js
// ---------------------------------------------------------------------------
// AI News aggregator — Netlify Function (Node 18+, native global fetch).
//
// What it does:
//   GET /.netlify/functions/news
//       → fetches every curated feed in SOURCES in parallel, parses RSS/Atom
//         with a dependency-free parser, merges + de-dupes + sorts newest
//         first, caps to ~60 items, and returns JSON.
//
//   GET /.netlify/functions/news?digest=1
//       → same aggregation, then sends the top ~25 headlines to Claude
//         (haiku, key from env) to produce a short, factual "This week in AI"
//         TL;DR. Returns { digest, generatedAt }. If the key is missing it
//         returns a friendly { digest:null, message } — never a 500.
//
// Design notes for whoever reads this later (hi Eduardo):
//   * No npm packages. The XML "parser" is deliberately a robust regex/string
//     extractor — RSS and Atom are simple enough that this is reliable for the
//     handful of well-formed feeds we curate, and it keeps the function with
//     zero dependencies / zero build step.
//   * Promise.allSettled means one dead or slow feed can NEVER take down the
//     whole response — failures are logged and skipped.
//   * Each fetch has its own AbortController timeout (~8s) so a hung feed
//     can't stall the function.
//   * The API key lives ONLY in process.env.ANTHROPIC_API_KEY (Netlify → Site
//     settings → Environment variables). It is never sent to the browser.
//   * Security posture: the open aggregator path is CORS '*' (no secrets), but
//     the ?digest=1 path spends the Anthropic key, so it is BOTH origin-gated
//     (ALLOWED_ORIGINS) and per-IP rate-limited. Always keep a monthly spend
//     cap set on the key as the real backstop (house rule).
// ---------------------------------------------------------------------------

'use strict';

// --- Configuration ---------------------------------------------------------

// Verified feeds. Categories let the front-end group/filter without us having
// to hardcode UI logic server-side.
const SOURCES = [
  // Labs (frontier labs / product announcements)
  { name: 'Anthropic News',            feed_url: 'https://raw.githubusercontent.com/taobojlen/anthropic-rss-feed/main/anthropic_news_rss.xml', category: 'Labs' },
  { name: 'OpenAI Blog',               feed_url: 'https://openai.com/blog/rss.xml',                                  category: 'Labs' },
  { name: 'Google DeepMind',           feed_url: 'https://deepmind.google/blog/rss.xml',                             category: 'Labs' },
  { name: 'Google – The Keyword (AI)', feed_url: 'https://blog.google/technology/ai/rss/',                           category: 'Labs' },
  { name: 'Hugging Face Blog',         feed_url: 'https://huggingface.co/blog/feed.xml',                             category: 'Labs' },

  // Research (papers + institutional research blogs)
  { name: 'Google Research',           feed_url: 'https://research.google/blog/rss/',                                category: 'Research' },
  { name: 'arXiv cs.AI',               feed_url: 'https://export.arxiv.org/rss/cs.AI',                               category: 'Research' },
  { name: 'arXiv cs.LG',               feed_url: 'https://export.arxiv.org/rss/cs.LG',                               category: 'Research' },
  { name: 'arXiv cs.CL',               feed_url: 'https://export.arxiv.org/rss/cs.CL',                               category: 'Research' },
  { name: 'MIT News – AI',             feed_url: 'https://news.mit.edu/rss/topic/artificial-intelligence2',          category: 'Research' },

  // Outlets (editorial journalism)
  { name: 'MIT Technology Review – AI', feed_url: 'https://www.technologyreview.com/topic/artificial-intelligence/feed/', category: 'Outlets' },
  { name: 'Quanta Magazine',           feed_url: 'https://www.quantamagazine.org/feed/',                             category: 'Outlets' },

  // Newsletters (high-signal weekly roundups)
  { name: 'Import AI (Jack Clark)',    feed_url: 'https://importai.substack.com/feed',                              category: 'Newsletters' },
  { name: 'Ahead of AI (Raschka)',     feed_url: 'https://magazine.sebastianraschka.com/feed',                      category: 'Newsletters' },

  // Community (practitioner blogs)
  { name: "Simon Willison's Weblog",   feed_url: 'https://simonwillison.net/atom/everything/',                      category: 'Community' },
];

const FEED_TIMEOUT_MS = 8000;   // per-feed AbortController timeout
const MAX_ITEMS = 60;           // cap on items returned
const DIGEST_HEADLINES = 25;    // how many headlines feed the LLM digest
const CACHE_SECONDS = 900;      // 15 min CDN/browser cache

const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001'; // pinned per house rules
const ANTHROPIC_MAX_TOKENS = 900;                    // capped per house rules

// CORS.
// The plain aggregator (no ?digest) is a read-only public feed with no secrets,
// so it stays embeddable from anywhere ('*') — that also lets the static page be
// opened from file:// in demo mode.
// The ?digest=1 path spends the Anthropic key, so it is gated to an origin
// allow-list (ALLOWED_ORIGINS env, comma-separated). This is the one endpoint
// worth protecting from drive-by budget burn.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
  'https://ai-signal.netlify.app')
  .split(',').map((s) => s.trim()).filter(Boolean);

function corsHeaders(origin, { gated } = {}) {
  // For the gated (digest) path, reflect the origin only if it's allow-listed.
  // For the open path, '*' is fine.
  let allow = '*';
  if (gated) {
    allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  }
  return {
    'Access-Control-Allow-Origin': allow,
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

// Coarse per-IP throttle for the digest path (best-effort, in-memory).
// Netlify may cold-start / run multiple instances, so this is a speed-bump
// against drive-by loops, NOT a hard guarantee — the real backstop is the
// monthly spend cap set on the Anthropic key (house rule).
const DIGEST_WINDOW_MS = 60 * 1000;  // 1 minute
const DIGEST_MAX_PER_WINDOW = 5;     // per IP per window
const digestHits = new Map();        // ip -> number[] (request timestamps)

function digestRateLimited(ip) {
  const now = Date.now();
  const key = ip || 'unknown';
  const hits = (digestHits.get(key) || []).filter((t) => now - t < DIGEST_WINDOW_MS);
  if (hits.length >= DIGEST_MAX_PER_WINDOW) {
    digestHits.set(key, hits);
    return true;
  }
  hits.push(now);
  digestHits.set(key, hits);
  // Opportunistic cleanup so the map can't grow unbounded.
  if (digestHits.size > 5000) {
    for (const [k, ts] of digestHits) {
      if (!ts.some((t) => now - t < DIGEST_WINDOW_MS)) digestHits.delete(k);
    }
  }
  return false;
}

function clientIp(event) {
  const h = event.headers || {};
  const xff = h['x-nf-client-connection-ip'] ||
    (h['x-forwarded-for'] || '').split(',')[0].trim() ||
    h['client-ip'] || '';
  return xff;
}

// ---------------------------------------------------------------------------
// Tiny XML helpers (dependency-free)
// ---------------------------------------------------------------------------

// Decode the handful of XML/HTML entities that actually show up in feed text.
// (Feeds are well-formed XML, so the set of raw entities is small.)
function decodeEntities(str) {
  if (!str) return '';
  return str
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&#x0*27;/gi, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&hellip;/g, '…')
    // numeric entities (decimal + hex), best-effort
    .replace(/&#(\d+);/g, (_, n) => safeFromCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => safeFromCodePoint(parseInt(n, 16)))
    // ampersand LAST so we don't double-decode the entities above
    .replace(/&amp;/g, '&');
}

function safeFromCodePoint(code) {
  // Guard against malformed/out-of-range code points so a bad entity can't throw.
  try {
    if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

// Strip CDATA wrappers anywhere in a string.
function stripCdata(str) {
  if (!str) return '';
  return str.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

// Remove HTML tags and collapse whitespace — used for summaries.
function stripHtml(str) {
  if (!str) return '';
  return str
    .replace(/<\/(p|div|br|li|h[1-6])>/gi, ' ') // turn block-closers into spaces
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')                     // drop remaining tags
    .replace(/\s+/g, ' ')
    .trim();
}

// Pull the inner text of the FIRST <tag>…</tag>. The optional ns prefix in the
// regex lets a bare tag like "title" also match "dc:title"; passing a fully
// qualified tag like "content:encoded" matches that exact element ONLY (it will
// not match a bare <content>), which is what the summary fallback relies on.
function firstTag(xml, tag) {
  const re = new RegExp(
    `<(?:[a-zA-Z0-9]+:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:[a-zA-Z0-9]+:)?${tag}>`,
    'i'
  );
  const m = re.exec(xml);
  return m ? m[1] : '';
}

// Clean a free-text field: strip CDATA, strip HTML, decode entities, trim.
function cleanText(raw) {
  return decodeEntities(stripHtml(stripCdata(raw || ''))).trim();
}

// Clean a title/link field (decode entities + CDATA, but keep it short/plain).
function cleanInline(raw) {
  return decodeEntities(stripCdata(raw || '')).replace(/\s+/g, ' ').trim();
}

// Extract a link from an <item>/<entry> block, handling both:
//   RSS:  <link>https://…</link>
//   Atom: <link rel="alternate" href="https://…"/>  (or just <link href="…">)
function extractLink(block) {
  // Prefer an Atom alternate link if present.
  const atomAlt = /<link\b[^>]*\brel=["']alternate["'][^>]*\bhref=["']([^"']+)["']/i.exec(block)
    || /<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\brel=["']alternate["']/i.exec(block);
  if (atomAlt) return cleanInline(atomAlt[1]);

  // Any Atom-style <link href="…"> (first one).
  const atomAny = /<link\b[^>]*\bhref=["']([^"']+)["']/i.exec(block);
  if (atomAny) return cleanInline(atomAny[1]);

  // RSS-style <link>…</link>.
  const rss = firstTag(block, 'link');
  if (rss) return cleanInline(rss);

  // Last resort: a <guid> that looks like a URL.
  const guid = cleanInline(firstTag(block, 'guid'));
  if (/^https?:\/\//i.test(guid)) return guid;

  return '';
}

// Normalise any feed date string to an ISO string. Returns null if unparseable.
// Curated feeds emit RFC822 (RSS) or ISO-8601 (Atom), both of which Date.parse
// handles deterministically; anything non-standard simply returns null and the
// item sinks to the bottom of the sort rather than getting a bogus date.
function toISO(dateStr) {
  if (!dateStr) return null;
  const s = cleanInline(dateStr);
  if (!s) return null;
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString();
}

// ---------------------------------------------------------------------------
// Feed parsing
// ---------------------------------------------------------------------------

// Split a feed document into its <item> (RSS) or <entry> (Atom) blocks.
function splitEntries(xml) {
  const items = xml.match(/<item\b[\s\S]*?<\/item>/gi);
  if (items && items.length) return items;
  const entries = xml.match(/<entry\b[\s\S]*?<\/entry>/gi);
  if (entries && entries.length) return entries;
  return [];
}

// Parse one feed's raw XML into normalized item objects.
function parseFeed(xml, source) {
  const blocks = splitEntries(xml);
  const out = [];

  for (const block of blocks) {
    // Titles can carry HTML inside CDATA (e.g. <b>…</b>), so strip tags too.
    const title = cleanText(firstTag(block, 'title'));
    const link = extractLink(block);

    // Date: RSS uses pubDate; Atom uses updated/published; dc:date is a fallback.
    const rawDate =
      firstTag(block, 'pubDate') ||
      firstTag(block, 'updated') ||
      firstTag(block, 'published') ||
      firstTag(block, 'date'); // matches dc:date via the ns-optional regex
    const date = toISO(rawDate);

    // Summary fallback order: RSS <description> → <content:encoded> (matched
    // explicitly before bare <content> so RSS isn't mis-sliced) → Atom
    // <summary> → Atom <content>. We strip HTML + CDATA and clamp length.
    let rawSummary =
      firstTag(block, 'description') ||
      firstTag(block, 'content:encoded') ||
      firstTag(block, 'summary') ||
      firstTag(block, 'content');
    let summary = cleanText(rawSummary);
    if (summary.length > 400) summary = summary.slice(0, 397).trimEnd() + '…';

    // Need at least a title or a link to be useful.
    if (!title && !link) continue;

    out.push({
      title: title || '(untitled)',
      link,
      source: source.name,
      category: source.category,
      date, // ISO string or null
      summary,
    });
  }

  return out;
}

// Fetch one feed with a hard per-feed timeout. Resolves to an array of items
// (possibly empty); throws on network/HTTP errors so allSettled can record it.
async function fetchFeed(source) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);
  try {
    const res = await fetch(source.feed_url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        // Some feeds 403 a blank UA; a polite UA avoids that.
        'User-Agent': 'AI-News-Aggregator/1.0 (+netlify-function)',
        'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} for ${source.name}`);
    }
    const xml = await res.text();
    return parseFeed(xml, source);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Merge / de-dupe / sort
// ---------------------------------------------------------------------------

// Normalize a string for fuzzy de-dupe keys (lowercase, strip punctuation).
function dedupeKey(str) {
  return (str || '')
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[#?].*$/, '')        // drop query/hash from links
    .replace(/\/+$/, '')           // drop trailing slashes
    .replace(/[^a-z0-9]+/g, ' ')   // collapse punctuation
    .trim();
}

function byDateDesc(a, b) {
  const ta = a.date ? Date.parse(a.date) : -Infinity;
  const tb = b.date ? Date.parse(b.date) : -Infinity;
  return tb - ta;
}

function mergeAndSort(arrays) {
  // Each entry in `arrays` is one source's items. Sort each source newest-first.
  // High-volume sources like arXiv publish dozens of same-day papers; a naive
  // global date-sort lets them flood the feed and bury the lab blogs/newsletters.
  // So we ROUND-ROBIN across sources — newest from each source first, then the
  // second-newest from each, and so on — for a diverse "signal over noise" feed.
  const lists = arrays.map((a) => [...a].sort(byDateDesc));

  const seen = new Set();
  const out = [];
  let round = 0;
  let addedThisRound = true;
  while (addedThisRound && out.length < MAX_ITEMS) {
    addedThisRound = false;
    for (const list of lists) {
      if (round >= list.length) continue;
      addedThisRound = true;
      const item = list[round];
      const linkKey = item.link ? 'l:' + dedupeKey(item.link) : '';
      const titleKey = 't:' + dedupeKey(item.title);
      if ((linkKey && seen.has(linkKey)) || seen.has(titleKey)) continue;
      if (linkKey) seen.add(linkKey);
      seen.add(titleKey);
      out.push(item);
      if (out.length >= MAX_ITEMS) break;
    }
    round++;
  }
  return out;
}

// Run all feeds in parallel; never let one failure break the response.
async function aggregate() {
  const results = await Promise.allSettled(SOURCES.map(fetchFeed));
  const ok = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'fulfilled') {
      ok.push(r.value);
    } else {
      // Log and move on — a dead feed must not break the endpoint.
      console.warn(`[news] feed failed: ${SOURCES[i].name} — ${r.reason && r.reason.message}`);
    }
  }
  return mergeAndSort(ok);
}

// ---------------------------------------------------------------------------
// LLM digest (optional, ?digest=1)
// ---------------------------------------------------------------------------

async function buildDigest(items) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    // Friendly, NOT an error — the aggregator still works without a key.
    return {
      digest: null,
      message:
        'AI digest is unavailable right now (the server has no ANTHROPIC_API_KEY configured). The headlines above are live.',
    };
  }

  // Feed the model a compact list of the freshest headlines.
  const headlines = items.slice(0, DIGEST_HEADLINES).map((it, i) => {
    const when = it.date ? it.date.slice(0, 10) : 'n/a';
    return `${i + 1}. [${it.category} · ${it.source} · ${when}] ${it.title}`;
  });

  const system =
    'You are an AI-news editor writing a concise weekly TL;DR for a busy developer ' +
    'who wants signal over noise. Be factual and neutral — no hype, no marketing ' +
    'adjectives, no speculation beyond what the headlines state. If a headline is a ' +
    'research preprint, say so. Group related items.';

  const userPrompt =
    'Here are the top recent AI headlines (newest first):\n\n' +
    headlines.join('\n') +
    '\n\nWrite a "This week in AI" TL;DR as 5-8 short bullet points. ' +
    'Group bullets loosely by theme (e.g. frontier labs, open-source/tooling, ' +
    'research, policy). Each bullet: one factual sentence, plain text, starting ' +
    'with "- ". No preamble, no closing remarks, no headings beyond the bullets.';

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS * 2); // a bit longer for the model
    let res;
    try {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: ANTHROPIC_MODEL,
          max_tokens: ANTHROPIC_MAX_TOKENS,
          system,
          messages: [{ role: 'user', content: userPrompt }],
        }),
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.warn(`[news] digest LLM HTTP ${res.status}: ${errText.slice(0, 300)}`);
      return {
        digest: null,
        message: 'Could not generate the AI digest right now. The headlines above are live.',
      };
    }

    const data = await res.json();
    // Anthropic returns { content: [ { type:'text', text:'…' }, … ] }.
    const text = Array.isArray(data.content)
      ? data.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim()
      : '';

    if (!text) {
      return {
        digest: null,
        message: 'The AI digest came back empty. The headlines above are live.',
      };
    }
    return { digest: text };
  } catch (e) {
    console.warn(`[news] digest error: ${e && e.message}`);
    return {
      digest: null,
      message: 'Could not generate the AI digest right now. The headlines above are live.',
    };
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

exports.handler = async (event) => {
  const origin = (event.headers && (event.headers.origin || event.headers.Origin)) || '';
  const wantsDigest =
    event.queryStringParameters && event.queryStringParameters.digest === '1';
  const cors = corsHeaders(origin, { gated: wantsDigest });

  // CORS preflight.
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors, body: '' };
  }
  // Read-only endpoint: only GET (and HEAD) make sense.
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'HEAD') {
    return {
      statusCode: 405,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  const generatedAt = new Date().toISOString();

  // The whole thing is wrapped so we NEVER throw an unhandled 500.
  try {
    if (wantsDigest) {
      // Coarse per-IP throttle — only the money-spending path is rate-limited.
      if (digestRateLimited(clientIp(event))) {
        return {
          statusCode: 429,
          headers: {
            ...cors,
            'Content-Type': 'application/json',
            'Retry-After': '60',
          },
          body: JSON.stringify({
            digest: null,
            message: 'Too many digest requests. Please wait a minute and try again.',
            generatedAt,
          }),
        };
      }

      const items = await aggregate();
      const result = await buildDigest(items);
      return {
        statusCode: 200,
        headers: {
          ...cors,
          'Content-Type': 'application/json',
          // Digest is more expensive + a bit more dynamic — cache briefly.
          'Cache-Control': 'public, max-age=600',
        },
        body: JSON.stringify({ ...result, generatedAt }),
      };
    }

    const items = await aggregate();
    return {
      statusCode: 200,
      headers: {
        ...cors,
        'Content-Type': 'application/json',
        'Cache-Control': `public, max-age=${CACHE_SECONDS}`,
      },
      body: JSON.stringify({ items, generatedAt }),
    };
  } catch (e) {
    // Absolute backstop. Return an empty-but-valid payload rather than a 500
    // so the front-end can render gracefully.
    console.error('[news] unhandled error:', e && e.stack ? e.stack : e);
    return {
      statusCode: 200,
      headers: {
        ...cors,
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=60',
      },
      body: JSON.stringify({
        items: [],
        generatedAt,
        error: 'Temporary problem aggregating feeds. Please try again shortly.',
      }),
    };
  }
};
