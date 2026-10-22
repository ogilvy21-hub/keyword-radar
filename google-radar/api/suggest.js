// api/suggest.js
// 네이버 + 구글 자동완성을 합쳐서 연관 키워드를 반환한다.
// 차단 방지: 정상 브라우저 헤더, 호출 간격(지터), 개별 실패 격리, 타임아웃.
// 검색량/경쟁도 데이터는 주지 않음(그건 searchad.js 담당). 여기는 '키워드 발굴'만.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (min, max) => min + Math.floor(Math.random() * (max - min));

// 공통: 타임아웃 달린 fetch
async function fetchWithTimeout(url, options = {}, timeoutMs = 4000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
};

// ---- 구글 자동완성 ----
// 응답 형식: ["입력어", ["추천1","추천2",...], ...]
async function fetchGoogleSuggest(keyword) {
  try {
    const url =
      'https://suggestqueries.google.com/complete/search?client=firefox&hl=ko&gl=kr&q=' +
      encodeURIComponent(keyword);
    const res = await fetchWithTimeout(url, {
      headers: { ...BROWSER_HEADERS, Referer: 'https://www.google.com/' },
    });
    if (!res.ok) return [];
    const data = await res.json();
    if (Array.isArray(data) && Array.isArray(data[1])) {
      return data[1].map((s) => String(s).trim()).filter(Boolean);
    }
    return [];
  } catch (e) {
    console.error('google suggest error:', e.message);
    return [];
  }
}

// ---- 네이버 자동완성 ----
// 응답 형식: { items: [ [ ["추천1"], ["추천2"], ... ] ] } (ac.search.naver.com)
async function fetchNaverSuggest(keyword) {
  try {
    const url =
      'https://ac.search.naver.com/nx/ac?q=' +
      encodeURIComponent(keyword) +
      '&con=0&frm=nv&ans=2&r_format=json&r_enc=UTF-8&r_unicode=0&t_koreng=1&run=2&rev=4&q_enc=UTF-8&st=100';
    const res = await fetchWithTimeout(url, {
      headers: { ...BROWSER_HEADERS, Referer: 'https://search.naver.com/' },
    });
    if (!res.ok) return [];
    const data = await res.json();
    const out = [];
    if (data && Array.isArray(data.items)) {
      for (const group of data.items) {
        if (!Array.isArray(group)) continue;
        for (const item of group) {
          // item 형태: ["키워드", ...] 또는 "키워드"
          const word = Array.isArray(item) ? item[0] : item;
          if (word) out.push(String(word).trim());
        }
      }
    }
    return out.filter(Boolean);
  } catch (e) {
    console.error('naver suggest error:', e.message);
    return [];
  }
}

export default async function handler(req, res) {
  const keyword = String(req.query.keyword || '').trim();
  if (!keyword) {
    return res.status(400).json({ error: 'keyword is required' });
  }

  // source=google | naver | both (기본 both)
  const source = String(req.query.source || 'both').toLowerCase();

  // 자동완성용 키워드 변형 생성:
  // 자동완성은 "2026장마기간"처럼 다 붙은 복합어를 인식 못 한다.
  // 사람이 실제로 치는 형태(공백 분리, 연도 분리, 핵심어)로 여러 변형을 만들어 시도한다.
  function buildVariants(kw){
    const variants = new Set();
    const base = kw.trim();
    variants.add(base);
    // 1) 연도(20xx, xx년) 분리: "2026장마기간" -> "2026 장마기간", "장마기간 2026", "장마기간"
    const yearMatch = base.match(/(20\d{2}|\d{2}년)/);
    if(yearMatch){
      const year = yearMatch[0];
      const rest = base.replace(year, '').trim();
      if(rest){
        variants.add(`${year} ${rest}`);
        variants.add(`${rest} ${year}`);
        variants.add(rest);
      }
    }
    // 2) 공백 없는 긴 복합어는 공백 버전도 시도 (자동완성이 띄어쓰기에 더 잘 반응)
    const noYear = base.replace(/(20\d{2}|\d{2}년)/g, '').trim();
    if(noYear && noYear !== base) variants.add(noYear);
    // 최대 4개 변형으로 제한 (호출 폭증 방지)
    return [...variants].filter(v => v && v.length >= 2).slice(0, 4);
  }

  try {
    const variants = buildVariants(keyword);
    let google = [];
    let naver = [];

    for (let i = 0; i < variants.length; i++) {
      const v = variants[i];
      if (source === 'google' || source === 'both') {
        const g = await fetchGoogleSuggest(v);
        google = google.concat(g);
      }
      if (source === 'both') {
        await sleep(jitter(100, 220));
      }
      if (source === 'naver' || source === 'both') {
        const n = await fetchNaverSuggest(v);
        naver = naver.concat(n);
      }
      // 변형 간에도 짧은 간격
      if (i < variants.length - 1) await sleep(jitter(120, 260));
    }

    // 합치고 중복 제거 (정규화: 공백 제거 + 대문자)
    const seen = new Set();
    const merged = [];
    const pushAll = (list, src) => {
      for (const w of list) {
        const key = w.replace(/\s+/g, '').toUpperCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        merged.push({ keyword: w, source: src });
      }
    };
    // 입력 키워드 자체는 제외
    seen.add(keyword.replace(/\s+/g, '').toUpperCase());
    pushAll(google, 'google');
    pushAll(naver, 'naver');

    // 캐시 헤더: CDN/브라우저가 24시간 캐싱하도록 (네이버/구글 호출 추가 절감)
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=43200');

    return res.status(200).json({
      keyword,
      variants,
      count: merged.length,
      googleCount: google.length,
      naverCount: naver.length,
      suggestions: merged.map((m) => m.keyword),
      detailed: merged, // [{keyword, source}]
    });
  } catch (error) {
    console.error('suggest handler error:', error.message);
    // 자동완성이 통째로 실패해도 200 + 빈 결과 (본체가 안 죽게)
    return res.status(200).json({
      keyword,
      count: 0,
      googleCount: 0,
      naverCount: 0,
      suggestions: [],
      detailed: [],
      _error: error.message,
    });
  }
}
