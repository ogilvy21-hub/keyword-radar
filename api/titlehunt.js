// api/titlehunt.js
// 네이버 검색 API(블로그+뉴스)로 "이미 발행된 제목"을 모아 후킹 키워드를 추출한다.
// [v22.10] 뉴스 검색의 description(요약 스니펫)도 함께 가져와, 원고 작성 AI가
// 자기 기억이 아니라 실제 검색 스니펫을 근거로 사실을 쓸 수 있게 한다.
// [v22.12] 관련도순(sim)만 쓰면 "민경욱프로필"처럼 오래된 프로필 기사가 최신 속보(2026년 사건)를
// 밀어내는 문제가 있었다. 최신순(date) 검색도 같이 가져와 합치고, 최종은 실제 pubDate 기준으로
// 재정렬해서 최신 기사가 항상 위로 오게 한다.
// [v22.15 / 2026-09-15] 네이버 블로그 검색(sort=sim)은 정확한 문구 일치 결과가 적으면
// "프로필", "가수"처럼 흔한 단어 하나만 겹쳐도 전혀 무관한 글을 관련도순으로 끼워 넣는다.
// 이걸 그대로 후킹어 추출·샘플 제목에 쓰면 "김범수 프로필"을 검색했는데 "인요한 프로필",
// "박효신 노래모음"처럼 완전히 무관한 제목이 섞여 나온다. 키워드의 각 단어를 전부 포함하지
// 않는 제목은 이 단계에서 걸러낸다(index.html의 relevanceScore()와 같은 취지, 서버 쪽 적용).
// 단, 필터링 결과가 0개면(네이버가 그 순간 겹치는 제목을 하나도 안 줬거나 하는 예외 상황)
// 화면에 아무것도 안 뜨는 것보다는 필터링 전 원본이라도 보여주는 게 낫다 — 원본으로 폴백한다.
// [v22.16 / 2026-09-15] 관련도 필터를 통과하고 나면 재료가 너무 적어지는 경우가 있었다.
// 블로그 검색 결과 수를 30개보다 늘려서 관련도 필터를 통과할 재료를 넉넉히 확보한다.
// (100개까지 시도했다가 응답 지연으로 4.5초 타임아웃을 넘겨 조용히 빈 결과가 되는 회귀가
// 있었다 — 50개 + 타임아웃 7초로 재조정. 네이버 API 자체의 display 상한은 100이지만,
// 우리 쪽 타임아웃 여유가 그만큼 못 따라갔던 것.)
// 키: 네이버 개발자센터 검색 API. Vercel 환경변수 NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 필요.
// 차단/실패에 강하게: 타임아웃, 개별 실패 격리, 전체 실패해도 200+빈결과(본체 보호).

const TIMEOUT_MS = 7000;

async function fetchWithTimeout(url, options = {}, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

// [FIX 2026-09-15] 429(요청 과다)를 받으면 짧게 기다렸다가 최대 2회까지 자동 재시도한다.
// 네이버 오픈API(블로그·뉴스 검색)는 검색광고 API보다 한도가 넉넉하지만(일 25,000회 수준),
// 짧은 시간에 여러 요청이 몰리면 순간적으로 429가 뜰 수 있어 안전장치로 넣는다.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function fetchNaverWithRetry(url, headers, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetchWithTimeout(url, { headers });
    if (res.status !== 429) return res;
    if (attempt < retries) {
      await sleep(400 * (attempt + 1) + Math.floor(Math.random() * 200));
    } else {
      return res; // 마지막 시도까지 429면 그대로 반환 — 호출부가 !res.ok로 처리
    }
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

// [FIX 2026-09-15] 공백만 제거하고 대문자로 맞춰 "글자 겹침" 비교를 쉽게 한다.
// index.html의 normalizeKey()와 동일한 방식(구두점은 그대로 둠 — 여긴 단어 단위 포함 여부만 보면 충분).
function normalizeKeyCompact(s) {
  return String(s || '').replace(/\s+/g, '').toUpperCase();
}

// [FIX 2026-09-15] 키워드를 공백 기준으로 쪼갠 "단어" 전부가 제목 안에 글자 그대로 들어있어야
// 관련 있다고 본다. 예: "김범수 프로필" -> ["김범수","프로필"] 둘 다 포함된 제목만 통과.
// 한 글자짜리 조사·접속어(예: "그", "이")는 오탐이 심해서 판별 기준에서 제외한다.
function isRelevantTitle(title, keyword) {
  const compactTitle = normalizeKeyCompact(title);
  const parts = String(keyword || '')
    .trim()
    .split(/\s+/)
    .map(normalizeKeyCompact)
    .filter((p) => p.length >= 2);
  if (!parts.length) return true; // 쪼갤 단어가 없으면(한 글자 키워드 등) 걸러내지 않는다
  return parts.every((p) => compactTitle.includes(p));
}

// [FIX 2026-09-15] display를 30 -> 100(네이버가 허용하는 최대치)으로 올려서, 관련도 필터를
// 통과하고 남는 재료 자체를 늘린다. 필터가 엄격해진 만큼 원재료도 넉넉해야 후킹어가 나온다.
async function fetchNaverSearch(type, keyword, clientId, clientSecret, sort='sim', display=50) {
  try {
    const url =
      `https://openapi.naver.com/v1/search/${type}.json?query=` +
      encodeURIComponent(keyword) + `&display=${display}&sort=${sort}`;
    const res = await fetchNaverWithRetry(url, {
      'X-Naver-Client-Id': clientId,
      'X-Naver-Client-Secret': clientSecret,
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
    const res = await fetchNaverWithRetry(url, {
      'X-Naver-Client-Id': clientId,
      'X-Naver-Client-Secret': clientSecret,
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
    // 블로그 제목(50개) + 뉴스 제목(30개, 이제 후킹어 재료로도 씀) + 뉴스 스니펫(사실확인용) 병렬 수집
    const [blogTitlesRaw, newsTitlesRaw, newsSnippets] = await Promise.all([
      fetchNaverSearch('blog', keyword, clientId, clientSecret, 'sim', 50),
      fetchNaverSearch('news', keyword, clientId, clientSecret, 'sim', 30),
      fetchNaverNewsSnippets(keyword, clientId, clientSecret),
    ]);

    // [FIX 2026-09-15] 키워드 단어를 전부 포함하지 않는 무관한 제목을 걸러낸다.
    // [FIX 2026-09-16] 화면 문구("상위 블로그·뉴스가 제목에 쓴 후킹")는 원래도 블로그+뉴스
    // 둘 다 쓰겠다고 약속하고 있었는데, 실제로는 블로그 제목만 후킹어 추출·샘플 제목에 쓰고
    // newsTitles는 개수 세는 용도로만 쓰이며 방치돼 있었다. "이상윤" 같이 막 터진 이슈는
    // 기사는 이미 정확히 나와 있는데(newsTitles가 관련도 100%로 나왔었다) 블로그는 아직
    // 안 따라온 경우가 흔해서, 블로그만 보면 재료가 텅 비어 보인다. 이제 관련도 필터를 통과한
    // 블로그+뉴스 제목을 합쳐서 하나의 재료 풀로 쓴다. 합친 뒤에도 0개면(둘 다 무관하면)
    // 필터링 전 원본이라도 보여주는 폴백은 그대로 유지한다.
    const blogTitlesFiltered = blogTitlesRaw.filter(t => isRelevantTitle(t, keyword));
    const newsTitlesFiltered = newsTitlesRaw.filter(t => isRelevantTitle(t, keyword));
    const combinedFiltered = [...blogTitlesFiltered, ...newsTitlesFiltered];
    const combinedRaw = [...blogTitlesRaw, ...newsTitlesRaw];
    const huntTitles = combinedFiltered.length > 0 ? combinedFiltered : combinedRaw;
    const droppedCount = combinedRaw.length - huntTitles.length;

    const hooks = extractHooks(huntTitles, keyword);

    res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=21600'); // 6h 캐시
    return res.status(200).json({
      keyword,
      count: huntTitles.length,
      blogCount: blogTitlesFiltered.length,
      newsCount: newsTitlesFiltered.length,
      hooks,
      sampleTitles: huntTitles.slice(0, 15),
      newsTitles: newsTitlesRaw.slice(0, 6),
      newsSnippets,             // [{title, description, source, pubDate}] — 최신순 재정렬된 사실확인 근거
      _filteredOutCount: droppedCount, // 참고용: 관련도 필터로 제외된 제목 개수(블로그+뉴스 합산)
      _usedRawFallback: combinedFiltered.length === 0 && combinedRaw.length > 0, // 필터 결과 0개라 원본으로 되돌린 경우 true
    });
  } catch (error) {
    console.error('titlehunt handler error:', error.message);
    return res.status(200).json({
      keyword, hooks: [], sampleTitles: [], newsTitles: [], newsSnippets: [], count: 0, _error: error.message,
    });
  }
}
