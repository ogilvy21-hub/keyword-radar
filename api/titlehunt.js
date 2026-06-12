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

// 1) 서술형 꼬리(TMI) 제거: 제목을 "글처럼" 끝맺는 동사/권유 표현을 떼어 명사구만 남긴다.
// 예) "...찍힌 이유부터 풀어봅니다" -> "...찍힌 이유부터"
//     "...도용되었으니 꼭 확인하세요" -> "...도용"
const TAIL_PATTERNS = [
  /(정리|총정리)?\s*(했|해)?(습니다|봅니다|볼게요|드려요|드립니다|할게요)\s*[.!~]*$/,
  /(해|하)?(세요|보세요|봐요|십시오)\s*[.!~]*$/,
  /(풀어|알아|살펴|짚어|정리해|확인해)\s*(봅니다|볼게요|보세요|드려요)?\s*[.!~]*$/,
  /(합니다|해요|네요|어요|아요|예요|이에요|입니다|랍니다|군요)\s*[.!~]*$/,
  /(총정리|정리|한번에|한 번에|꼭|완벽)\s*[.!~]*$/,
];
function stripNarrativeTail(title) {
  let t = String(title || '').trim();
  // 괄호 보조설명은 보존하되, 끝의 서술 꼬리만 반복 제거
  for (let i = 0; i < 3; i++) {
    let before = t;
    for (const re of TAIL_PATTERNS) t = t.replace(re, '').trim();
    // 끝에 남은 구두점/공백 정리
    t = t.replace(/[\s·,]+$/, '').trim();
    if (t === before) break;
  }
  return t;
}

// 2) 토큰화: 한글/영문/숫자 덩어리로 쪼갠다.
function tokenize(text) {
  return String(text || '')
    .replace(/[^\uAC00-\uD7A3a-zA-Z0-9]+/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 2);
}

// 공용 불용어(어느 분야든 후킹 가치 없음). 분야별 보존어는 프론트(분야 판별 후)에서 가산.
const COMMON_STOP = new Set([
  '정리','총정리','방법','완벽','한번에','이유','경우','관련','대해','대한','그리고',
  '하는법','하는','해서','했는데','입니다','합니다','네요','그것','우리','지금','오늘',
  '여기','진짜','정말','바로','모두','전부','각각','그냥','이번','당신','너무','매우',
]);

// 메인키워드를 토큰으로 분해(후킹 후보에서 자기 자신 제거용)
function keywordTokens(keyword) {
  return new Set(tokenize(keyword.replace(/\s+/g, '')).concat(tokenize(keyword)));
}

// 표기만 다른 동의어 병합 (예: 챗지피티/챗GPT/chatgpt -> 하나로)
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

// 제목 묶음 -> 후킹 후보(빈도순)
function extractHooks(titles, mainKeyword) {
  const kwSet = keywordTokens(mainKeyword);
  const kwFlat = mainKeyword.replace(/\s+/g, '');
  const freq = new Map();
  for (const raw of titles) {
    const cleaned = stripNarrativeTail(raw);
    const seenInTitle = new Set(); // 한 제목 안 중복은 1회만
    for (let tok of tokenize(cleaned)) {
      tok = canonicalize(tok);               // 동의어 통일
      if (COMMON_STOP.has(tok)) continue;
      if (kwSet.has(tok)) continue;          // 메인키워드 구성어 제외
      if (kwFlat.includes(tok)) continue;    // 메인키워드에 포함된 조각 제외
      if (/^\d+$/.test(tok)) continue;       // 순수 숫자 제외
      if (seenInTitle.has(tok)) continue;
      seenInTitle.add(tok);
      freq.set(tok, (freq.get(tok) || 0) + 1);
    }
  }
  return [...freq.entries()]
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count)
    .filter(h => h.count >= 2) // 최소 2개 제목에서 반복돼야 '검증된 후킹'
    .slice(0, 12);
}

export default async function handler(req, res) {
  const keyword = String(req.query.keyword || '').trim();
  if (!keyword) return res.status(400).json({ error: 'keyword is required' });

  const clientId = process.env.NAVER_CLIENT_ID;
  const clientSecret = process.env.NAVER_CLIENT_SECRET;

  // 키가 없으면 기능을 끄되 본체는 안 죽게 200+빈결과 + 안내
  if (!clientId || !clientSecret) {
    return res.status(200).json({
      keyword, hooks: [], titles: [], count: 0,
      _error: 'NAVER_CLIENT_ID/SECRET 미설정 (네이버 개발자센터 검색 API 키 필요)',
    });
  }

  try {
    // 블로그 + 뉴스 제목 동시 수집 (한쪽 실패해도 다른 쪽 살림)
    const [blogTitles, newsTitles] = await Promise.all([
      fetchNaverSearch('blog', keyword, clientId, clientSecret),
      fetchNaverSearch('news', keyword, clientId, clientSecret),
    ]);
    // [v19] 후킹은 '블로그 제목'만으로 추출한다.
    // 블로그는 도메인 권위가 약해 상위 노출을 위해 제목에 검색의도(키워드)를 의도적으로 박는다 = 검증된 후킹.
    // 뉴스는 매체 신뢰도로 노출되어 기사체 문장이 많아 후킹 노이즈가 크다 → 후킹엔 쓰지 않고 '맥락 파악용'으로만 분리.
    const hooks = extractHooks(blogTitles, keyword);

    res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=21600'); // 6h 캐시
    return res.status(200).json({
      keyword,
      count: blogTitles.length + newsTitles.length,
      blogCount: blogTitles.length,
      newsCount: newsTitles.length,
      hooks,                                   // [{word, count}] 블로그 제목 기반 후킹(검증된 키워드)
      sampleTitles: blogTitles.slice(0, 8),    // 후킹 근거로 보여줄 블로그 제목
      newsTitles: newsTitles.slice(0, 6),      // 맥락·최신성 파악용 뉴스 제목 (후킹엔 미사용)
    });
  } catch (error) {
    console.error('titlehunt handler error:', error.message);
    return res.status(200).json({
      keyword, hooks: [], sampleTitles: [], newsTitles: [], count: 0, _error: error.message,
    });
  }
}
