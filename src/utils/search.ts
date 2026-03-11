/**
 * Search integration: Tavily (web) + bird (X/Twitter).
 * Keyword detection routes to the appropriate search backend.
 */
import { execFile } from 'node:child_process';
import { config } from '../config/env.js';

const SEARCH_KEYWORDS = [
  '搜索', '搜一下', '查一下', '查询', '检索',
  '最新', '新闻', '今天', '最近',
  'search', 'lookup', 'look up', 'find out',
];

const X_KEYWORDS = [
  'twitter', '推特', 'x上', 'x 上',
  '推文', 'tweet',
];

export type SearchType = 'none' | 'web' | 'x' | 'both';

/**
 * Detect what kind of search the message needs.
 */
export function detectSearchType(text: string): SearchType {
  const lower = text.toLowerCase();
  const wantsSearch = SEARCH_KEYWORDS.some((kw) => lower.includes(kw));
  if (!wantsSearch) return 'none';

  const wantsX = X_KEYWORDS.some((kw) => lower.includes(kw));
  if (wantsX && config.BIRD_AUTH_TOKEN) return 'x';

  return 'web';
}

// ── Tavily (web search) ─────────────────────────────────────────────────────

interface TavilyResult {
  title: string;
  url: string;
  content: string;
}

interface TavilyResponse {
  results: TavilyResult[];
  answer?: string;
}

export async function tavilySearch(query: string): Promise<string> {
  if (!config.TAVILY_API_KEY) return '';

  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: config.TAVILY_API_KEY,
      query,
      search_depth: 'basic',
      max_results: 5,
      include_answer: true,
    }),
  });

  if (!res.ok) {
    throw new Error(`Tavily API error: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as TavilyResponse;
  const parts: string[] = [];

  if (data.answer) {
    parts.push(`Summary: ${data.answer}`);
  }

  for (const r of data.results) {
    parts.push(`- ${r.title}\n  ${r.content}\n  ${r.url}`);
  }

  return parts.join('\n\n');
}

// ── Bird (X/Twitter search) ─────────────────────────────────────────────────

interface BirdTweet {
  id: string;
  text: string;
  createdAt: string;
  author: { username: string; name: string };
  likeCount?: number;
  retweetCount?: number;
}

export async function birdSearch(query: string): Promise<string> {
  if (!config.BIRD_AUTH_TOKEN || !config.BIRD_CT0) return '';

  const output = await new Promise<string>((resolve, reject) => {
    execFile(
      'npx',
      [
        'bird',
        '--auth-token', config.BIRD_AUTH_TOKEN,
        '--ct0', config.BIRD_CT0,
        'search', query,
        '-n', '5',
        '--plain', '--json',
      ],
      { timeout: 30_000, shell: true },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr || err.message));
        } else {
          resolve(stdout);
        }
      },
    );
  });

  const tweets = JSON.parse(output) as BirdTweet[];
  if (tweets.length === 0) return '';

  const parts = tweets.map((t) => {
    const likes = t.likeCount ?? 0;
    const rts = t.retweetCount ?? 0;
    return `@${t.author.username}: ${t.text}\n  ${t.createdAt} | ❤️${likes} 🔁${rts}`;
  });

  return parts.join('\n\n');
}
