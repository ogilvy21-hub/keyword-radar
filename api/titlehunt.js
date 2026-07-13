// api/titlehunt.js
// 네이버 검색 API(블로그+뉴스)로 "이미 발행된 제목"을 모아 후킹 키워드를 추출한다.
// 사용자가 손으로 하던 "키워드 검색 → 상위 제목 보고 후킹 캐기"를 자동화.
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

// HTML 태그/엔티티 제거 (네이버 검색 결과 title엔 <b> 강조태그가 섞여 옴)
function stripTags(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .trim();
}

// 네이버 검색 API 한 종류(blog 또는 news) 호출
async function fetchNaverSearch(type, keyword, clientId, clientSecret) {
  try {
    const url =
      `https://openapi.naver.com/v1/search/${type}.json?query=` +
      encodeURIComponent(keyword) + '&display=30&sort=sim';
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

// ===== 후킹 추출 =====

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

// [v22.10] 카테고리 블랙리스트(국가명·방송사명 등) 방식 폐기.
// 이유: (1) "JTBC 아파트"처럼 동명이인 콘텐츠를 구분하는 정당한 채널명·지역명 검색까지 막아버림
//      (2) 카테고리를 하나씩 추가하는 방식은 근본적으로 두더지잡기 — 내일은 다른 카테고리가 오염시킬 수 있음
// 대신 구조적 신호로 감지: 종합/모음형 블로그 제목("이번주 이슈모음: A + B + C...")은
// 무관한 소재를 한 제목에 욱여넣어 토큰 수가 비정상적으로 많다. 카테고리와 무관하게 이런 제목 자체를
// 후킹 집계에서 제외하면, 어떤 종류의 오염 단어든 구조적으로 걸러진다.
// [v22.10] 9는 실제 네이버 데이터로 검증한 값이 아니라, 소수의 예시 문장으로 잡은 임시값이다.
// 온토픽 예시는 대개 4~7토큰, 의도적으로 만든 모음형 예시는 10토큰이어서 그 사이(9)로 잡았을 뿐이다.
// 실서비스 데이터로 토큰 수 분포를 확인한 뒤 조정이 필요할 수 있다.
const ROUNDUP_TOKEN_LIMIT = 9;
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
    if (isLikelyRoundupTitle(tokens)) continue; // [v22.10] 모음형 제목 전체를 집계에서 제외
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
      keyword, hooks: [], titles: [], count: 0,
      _error: 'NAVER_CLIENT_ID/SECRET 미설정 (네이버 개발자센터 검색 API 키 필요)',
    });
  }

  try {
    const [blogTitles, newsTitles] = await Promise.all([
      fetchNaverSearch('blog', keyword, clientId, clientSecret),
      fetchNaverSearch('news', keyword, clientId, clientSecret),
    ]);
    const hooks = extractHooks(blogTitles, keyword);

    res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=21600');
    return res.status(200).json({
      keyword,
      count: blogTitles.length + newsTitles.length,
      blogCount: blogTitles.length,
      newsCount: newsTitles.length,
      hooks,
      sampleTitles: blogTitles.slice(0, 15),
      newsTitles: newsTitles.slice(0, 6),
    });
  } catch (error) {
    console.error('titlehunt handler error:', error.message);
    return res.status(200).json({
      keyword, hooks: [], sampleTitles: [], newsTitles: [], count: 0, _error: error.message,
    });
  }
}
