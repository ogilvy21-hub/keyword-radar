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

  async function fetchNaverSearch(type) {
    const endpoint =
      type === 'blog'
        ? 'https://openapi.naver.com/v1/search/blog.json'
        : 'https://openapi.naver.com/v1/search/cafearticle.json';

    const url = `${endpoint}?query=${encodeURIComponent(keyword)}&display=1&start=1&sort=sim`;

    const response = await fetch(url, {
      headers: {
        'X-Naver-Client-Id': clientId,
        'X-Naver-Client-Secret': clientSecret,
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`${type} API failed: ${text}`);
    }

    return response.json();
  }

  try {
    const [blogData, cafeData] = await Promise.all([
      fetchNaverSearch('blog'),
      fetchNaverSearch('cafe'),
    ]);

    return res.status(200).json({
      keyword,
      blogTotal: blogData.total || 0,
      cafeTotal: cafeData.total || 0,
    });
  } catch (error) {
    return res.status(500).json({
      error: error.message,
    });
  }
}
