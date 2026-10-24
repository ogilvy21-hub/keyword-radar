// api/keyword.js
// v24: "전체 검색 문서수" 대신 최근 30일 실제 공급량을 계산한다.
// 네이버 검색 API를 최신순(date)으로 최대 500건까지 훑고,
// 제목+설명에 메인 키워드(공백 단위 핵심 토큰)가 실제로 들어간 문서만 센다.
// 경쟁비율은 프론트에서 recentBlogTotal / 월간검색수 로 계산한다.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DISPLAY = 100;
const MAX_PAGES = 5; // 최대 500건. 500건을 넘으면 capped=true로 표시.
const TIMEOUT_MS = 5000;
const WINDOW_DAYS = 30;

function stripTags(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .trim();
}

function compact(s) {
  return stripTags(s)
    .toLowerCase()
    .replace(/[^0-9a-z가-힣]+/gi, '');
}

function keywordParts(keyword) {
  const raw = String(keyword || '').trim();
  const parts = raw
    .split(/\s+/)
    .map(compact)
    .filter((x) => x.length >= 2);
  return parts.length ? [...new Set(parts)] : [compact(raw)].filter(Boolean);
}

function itemMatchesKeyword(item, keyword) {
  const hay = compact((item?.title || '') + ' ' + (item?.description || ''));
  const parts = keywordParts(keyword);
  if (!parts.length) return true;
  return parts.every((p) => hay.includes(p));
}

function parsePostDate(v) {
  const s = String(v || '').replace(/\D/g, '');
  if (s.length !== 8) return null;
  const y = Number(s.slice(0,4)), m = Number(s.slice(4,6)), d = Number(s.slice(6,8));
  if (!y || !m || !d) return null;
  const date=new Date(Date.UTC(y,m-1,d));
  return date.getUTCFullYear()===y&&date.getUTCMonth()===m-1&&date.getUTCDate()===d?date:null;
}

async function fetchWithTimeout(url, headers) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchNaverPage(type, keyword, clientId, clientSecret, start, retries = 1) {
  const endpoint = type === 'blog'
    ? 'https://openapi.naver.com/v1/search/blog.json'
    : 'https://openapi.naver.com/v1/search/cafearticle.json';
  const url = endpoint +
    '?query=' + encodeURIComponent(keyword) +
    '&display=' + DISPLAY +
    '&start=' + start +
    '&sort=date';

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchWithTimeout(url, {
        'X-Naver-Client-Id': clientId,
        'X-Naver-Client-Secret': clientSecret,
      });
      if (res.status === 429 && attempt < retries) {
        await sleep(350 * (attempt + 1));
        continue;
      }
      if (!res.ok) {
        const body = await res.text();
        console.error(type + ' API ' + res.status + ': ' + body);
        return null;
      }
      const data=await res.json();
      return Array.isArray(data.items)&&data.total!=null&&Number.isFinite(Number(data.total))?data:null;
    } catch (err) {
      if (attempt >= retries) {
        console.error(type + ' fetch error:', err.message);
        return null;
      }
      await sleep(250);
    }
  }
  return null;
}

async function countRecent(type, keyword, clientId, clientSecret) {
  const now = new Date(Date.now()+9*60*60*1000);
  const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  cutoff.setUTCDate(cutoff.getUTCDate() - (WINDOW_DAYS - 1));

  const seen = new Set();
  let count = 0;
  let failed=false,unknownDates=0;
  let allTimeTotal = 0;
  let pages = 0;
  let reachedOld = false;
  let lastPageFullAndRecent = false;

  for (let page = 0; page < MAX_PAGES; page++) {
    const start = 1 + page * DISPLAY;
    const data = await fetchNaverPage(type, keyword, clientId, clientSecret, start);
    if (!data) {failed=true;break;}
    pages += 1;
    if (page === 0) allTimeTotal = Number(data.total) || 0;

    const items = Array.isArray(data.items) ? data.items : [];
    if (!items.length) break;

    let hasRecent = false;
    let hasOld = false;
    for (const item of items) {
      const dt = parsePostDate(item.postdate);
      if (!dt || dt>now) {unknownDates++;continue;}
      if (dt < cutoff) {
        hasOld = true;
        continue;
      }
      hasRecent = true;
      if (!itemMatchesKeyword(item, keyword)) continue;
      const key = String(item.link || item.title || '') + '|' + String(item.postdate || '');
      if (seen.has(key)) continue;
      seen.add(key);
      count += 1;
    }

    // 최신순이므로 한 페이지 안에 cutoff 이전 문서가 나오기 시작하면 이후 페이지는 볼 필요가 없다.
    if (hasOld) {
      reachedOld = true;
      break;
    }
    if (items.length < DISPLAY) break;
    lastPageFullAndRecent = hasRecent;
  }

  const capped = !reachedOld && pages >= MAX_PAGES && lastPageFullAndRecent;
  const status=failed?(pages?'partial':'unavailable'):unknownDates?'partial':capped?'lower_bound':'complete';
  return { count:status==='unavailable'?null:count, capped, allTimeTotal, pages, status, unknownDates };
}

export default async function handler(req, res) {
  const keyword = (req.query.keyword || '').trim();
  if (!keyword) return res.status(400).json({ error: 'keyword is required' });

  const clientId = process.env.NAVER_CLIENT_ID;
  const clientSecret = process.env.NAVER_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return res.status(500).json({ error: 'NAVER_CLIENT_ID or NAVER_CLIENT_SECRET is missing' });
  }

  const blog = await countRecent('blog', keyword, clientId, clientSecret);
  // Cafe Search has no postdate field. A 30-day count cannot be inferred from sort=date.

  // 최근 30일 발행량은 매 요청마다 1~10개의 네이버 검색 페이지를 훑을 수 있다.
  // 1시간 CDN 캐시로 반복 분석 비용과 대기 시간을 줄이되, 일중 변화는 계속 반영한다.
  res.setHeader('Cache-Control',['complete','lower_bound'].includes(blog.status)?'s-maxage=3600, stale-while-revalidate=7200':'no-store');

  return res.status(blog.status==='unavailable'?503:200).json({
    keyword,
    windowDays: WINDOW_DAYS,
    recentBlogTotal: blog.count,
    recentCafeTotal: null,
    blogStatus: blog.status,
    cafeStatus: 'unsupported_date',
    statusVersion: 'reliability-20261024',
    recentBlogCapped: blog.capped,
    recentCafeCapped: false,
    allTimeBlogTotal: blog.allTimeTotal,
    allTimeCafeTotal: null,
    blogPagesScanned: blog.pages,
    cafePagesScanned: 0,
    unknownDates: blog.unknownDates,
    method: 'recent30d_strict_token_match',
  });
}


export { countRecent, itemMatchesKeyword, parsePostDate };
