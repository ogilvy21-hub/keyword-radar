// 간단한 sleep 헬퍼
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function handler(req, res) {
  const keyword = (req.query.keyword || '').trim();
  if (!keyword) {
    return res.status(400).json({ error: 'keyword is required' });
  }

  const clientId = process.env.NAVER_CLIENT_ID;
  const clientSecret = process.env.NAVER_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return res.status(500).json({
      error: 'NAVER_CLIENT_ID or NAVER_CLIENT_SECRET is missing',
    });
  }

  // 한 종류(blog/cafe)를 호출. 실패하면 throw 하지 않고 0을 반환.
  // 429(rate limit)면 잠깐 쉬고 1회 재시도.
  async function fetchTotal(type, retries = 1) {
    const endpoint =
      type === 'blog'
        ? 'https://openapi.naver.com/v1/search/blog.json'
        : 'https://openapi.naver.com/v1/search/cafearticle.json';
    const url = `${endpoint}?query=${encodeURIComponent(keyword)}&display=1&start=1&sort=sim`;

    try {
      const response = await fetch(url, {
        headers: {
          'X-Naver-Client-Id': clientId,
          'X-Naver-Client-Secret': clientSecret,
        },
      });

      if (response.status === 429 && retries > 0) {
        await sleep(300);
        return fetchTotal(type, retries - 1);
      }

      if (!response.ok) {
        // 실패해도 죽이지 않고 0 처리 (이유는 콘솔에만 남김)
        const text = await response.text();
        console.error(`${type} API ${response.status}: ${text}`);
        return 0;
      }

      const data = await response.json();
      return Number(data.total) || 0;
    } catch (err) {
      console.error(`${type} fetch error:`, err.message);
      return 0;
    }
  }

  // allSettled 대신 각 함수가 이미 0으로 안전 반환하므로 Promise.all로 충분
  const [blogTotal, cafeTotal] = await Promise.all([
    fetchTotal('blog'),
    fetchTotal('cafe'),
  ]);

  return res.status(200).json({
    keyword,
    blogTotal,
    cafeTotal,
  });
}
