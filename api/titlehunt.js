// api/titlehunt.js
// 네이버 검색 API(블로그+뉴스)로 "이미 발행된 제목"을 모아 후킹 키워드를 추출한다.
// [v22.10] 뉴스 검색의 description(요약 스니펫)도 함께 가져와, 원고 작성 AI가
// 자기 기억이 아니라 실제 검색 스니펫을 근거로 사실을 쓸 수 있게 한다.
// [v22.12] 관련도순(sim)만 쓰면 "민경욱프로필"처럼 오래된 프로필 기사가 최신 속보(2026년 사건)를
// 밀어내는 문제가 있었다. 최신순(date) 검색도 같이 가져와 합치고, 최종은 실제 pubDate 기준으로
// 재정렬해서 최신 기사가 항상 위로 오게 한다.
// 키: 네이버 개발자센터 검색 API. Vercel 환경변수 NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 필요.
// 차단/실패에 강하게: 타임아웃, 개별 실패 격리, 전체 실패해도 200+빈결과(본체 보호).

const TIMEOUT_MS = 4500;

async function fetchWithTimeout(url, options = {}, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

function stripTags(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .trim();
}

async function fetchNaverSearch(type, keyword, clientId, clientSecret, sort='sim') {
  try {
    const url =
      `https://openapi.naver.com/v1/search/${type}.json?query=` +
      encodeURIComponent(keyword) + `&display=30&sort=${sort}`;
    const res = await fetchWithTimeout(url, {
      headers: {
        'X-Naver-Client-Id': clientId,
        'X-Naver-Client-Secret': clientSecret,
      },
    });
    if (!res.ok) {
      console.error(`naver ${type} search not ok:`, res.status);
      return [];
    }
    const data = await res.json();
    const items = Array.isArray(data.items) ? data.items : [];
    return items.map(it => stripTags(it.title)).filter(Boolean);
  } catch (e) {
    console.error(`naver ${type} search error:`, e.message);
    return [];
  }
}

// [v22.10, v22.12] 뉴스 검색 결과의 title+description(요약 스니펫)+날짜+매체를 함께 가져온다.
// 관련도순(sim)과 최신순(date)을 둘 다 가져와 합치고, 중복 제거 후 실제 pubDate 기준으로
// 재정렬한다. "관련도순만 쓰면 오래된 기사가 최신 속보를 밀어내는" 문제를 이렇게 해결한다.
async function fetchNaverNewsSnippetsOne(keyword, clientId, clientSecret, sort) {
  try {
    const url =
      `https://openapi.naver.com/v1/search/news.json?query=` +
      encodeURIComponent(keyword) + `&display=5&sort=${sort}`;
    const res = await fetchWithTimeout(url, {
      headers: {
        'X-Naver-Client-Id': clientId,
        'X-Naver-Client-Secret': clientSecret,
      },
    });
    if (!res.ok) {
      console.error(`naver news snippets(${sort}) not ok:`, res.status);
      return [];
    }
    const data = await res.json();
    const items = Array.isArray(data.items) ? data.items : [];
    return items
      .map(it => ({
        title: stripTags(it.title),
        description: stripTags(it.description),
        link: it.originallink || it.link || '',
        source: (it.originallink || it.link || '').replace(/^https?:\/\//, '').split('/')[0] || '',
        pubDate: it.pubDate || '',
      }))
      .filter(x => x.title && x.description);
  } catch (e) {
    console.error(`naver news snippets(${sort}) error:`, e.message);
    return [];
  }
}
async function fetchNaverNewsSnippets(keyword, clientId, clientSecret) {
  const [simItems, dateItems] = await Promise.all([
    fetchNaverNewsSnippetsOne(keyword, clientId, clientSecret, 'sim'),
    fetchNaverNewsSnippetsOne(keyword, clientId, clientSecret, 'date'),
  ]);
  // date(최신순) 결과를 먼저 넣어 최신 기사를 우선 확보하고, 링크 기준 중복 제거
  const seen = new Set();
  const merged = [];
  for (const it of [...dateItems, ...simItems]) {
    const key = (it.link || it.title || '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(it);
  }
  // 실제 pubDate 기준 최신순 정렬 — 관련도순으로 섞여 들어왔어도 최종은 날짜순
  merged.sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0));
  return merged.slice(0, 5).map(({ link, ...rest }) => rest); // link는 내부 중복제거용, 응답엔 불필요
}

// ===== 후킹 추출 ===== (기존과 동일, 변경 없음)
const TAIL_PATTERNS = [
  /(정리|총정리)?\s*(했|해)?(습니다|봅니다|볼게요|드려요|드립니다|할게요)\s*[.!~]*$/,
  /(해|하)?(세요|보세요|봐요|십시오)\s*[.!~]*$/,
  /(풀어|알아|살펴|짚어|정리해|확인해)\s*(봅니다|볼게요|보세요|드려요)?\s*[.!~]*$/,
  /(합니다|해요|네요|어요|아요|예요|이에요|입니다|랍니다|군요)\s*[.!~]*$/,
  /(총정리|정리|한번에|한 번에|꼭|완벽)\s*[.!~]*$/,
];
function stripNarrativeTail(title) {
  let t = String(title || '').trim();
  for (let i = 0; i < 3; i++) {
    let before = t;
    for (const re of TAIL_PATTERNS) t = t.replace(re, '').trim();
    t = t.replace(/[\s·,]+$/, '').trim();
    if (t === before) break;
  }
  return t;
}
function tokenize(text) {
  return String(text || '')
    .replace(/[^\uAC00-\uD7A3a-zA-Z0-9]+/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 2);
}
const COMMON_STOP = new Set([
  '정리','총정리','방법','완벽','한번에','이유','경우','관련','대해','대한','그리고',
  '하는법','하는','해서','했는데','입니다','합니다','네요','그것','우리','지금','오늘',
  '여기','진짜','정말','바로','모두','전부','각각','그냥','이번','당신','너무','매우',
]);
const ROUNDUP_TOKEN_LIMIT = 8;
function isLikelyRoundupTitle(tokens) {
  return tokens.length > ROUNDUP_TOKEN_LIMIT;
}
function keywordTokens(keyword) {
  return new Set(tokenize(keyword.replace(/\s+/g, '')).concat(tokenize(keyword)));
}
const SYNONYM_MAP = [
  { canon: '챗GPT', alts: ['챗지피티', 'chatgpt', '지피티', '챗gpt'] },
  { canon: '핸드폰', alts: ['휴대폰', '휴대전화'] },
];
function canonicalize(word) {
  const lw = word.toLowerCase();
  for (const s of SYNONYM_MAP) {
    if (s.canon.toLowerCase() === lw) return s.canon;
    if (s.alts.some(a => a.toLowerCase() === lw)) return s.canon;
  }
  return word;
}
const NON_NOUN_HOOK = new Set([
  '따라','통해','위해','대해','함께','보다','부터','까지','마다','조차',
  '입기','하기','되기','보기','읽기','쓰기','먹기','따라잡기',
  '감탄','부르는','나오는','입는','하는','되는','보는','만한','싶은','같은','오는','가는','드는',
]);
const NARRATIVE_FRAG = /(다는|는데|은데|았|었|아쉽|니다|어요|아요|네요)$/;
function isNounHook(word) {
  if (NON_NOUN_HOOK.has(word)) return false;
  if (word.length >= 2 && NARRATIVE_FRAG.test(word)) return false;
  return true;
}
function extractHooks(titles, mainKeyword) {
  const kwSet = keywordTokens(mainKeyword);
  const kwFlat = mainKeyword.replace(/\s+/g, '');
  const freq = new Map();
  for (const raw of titles) {
    const cleaned = stripNarrativeTail(raw);
    const tokens = tokenize(cleaned);
    if (isLikelyRoundupTitle(tokens)) continue;
    const seenInTitle = new Set();
    for (let tok of tokens) {
      tok = canonicalize(tok);
      if (COMMON_STOP.has(tok)) continue;
      if (!isNounHook(tok)) continue;
      if (kwSet.has(tok)) continue;
      if (kwFlat.includes(tok)) continue;
      if (/^\d+$/.test(tok)) continue;
      if (seenInTitle.has(tok)) continue;
      seenInTitle.add(tok);
      freq.set(tok, (freq.get(tok) || 0) + 1);
    }
  }
  return [...freq.entries()]
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count)
    .filter(h => h.count >= 2)
    .slice(0, 12);
}

export default async function handler(req, res) {
  const keyword = String(req.query.keyword || '').trim();
  if (!keyword) return res.status(400).json({ error: 'keyword is required' });

  const clientId = process.env.NAVER_CLIENT_ID;
  const clientSecret = process.env.NAVER_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return res.status(200).json({
      keyword, hooks: [], titles: [], newsSnippets: [], count: 0,
      _error: 'NAVER_CLIENT_ID/SECRET 미설정 (네이버 개발자센터 검색 API 키 필요)',
    });
  }

  try {
    // 블로그 제목(후킹용) + 뉴스 제목(맥락용) + 뉴스 스니펫(사실확인 근거용, 관련도+최신 합침) 병렬 수집
    const [blogTitles, newsTitles, newsSnippets] = await Promise.all([
      fetchNaverSearch('blog', keyword, clientId, clientSecret),
      fetchNaverSearch('news', keyword, clientId, clientSecret),
      fetchNaverNewsSnippets(keyword, clientId, clientSecret),
    ]);
    const hooks = extractHooks(blogTitles, keyword);

    res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=21600'); // 6h 캐시
    return res.status(200).json({
      keyword,
      count: blogTitles.length + newsTitles.length,
      blogCount: blogTitles.length,
      newsCount: newsTitles.length,
      hooks,
      sampleTitles: blogTitles.slice(0, 15),
      newsTitles: newsTitles.slice(0, 6),
      newsSnippets,             // [{title, description, source, pubDate}] — 최신순 재정렬된 사실확인 근거
    });
  } catch (error) {
    console.error('titlehunt handler error:', error.message);
    return res.status(200).json({
      keyword, hooks: [], sampleTitles: [], newsTitles: [], newsSnippets: [], count: 0, _error: error.message,
    });
  }
}
