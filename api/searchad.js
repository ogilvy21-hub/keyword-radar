import crypto from 'crypto';

function makeSignature(timestamp, method, uri, secretKey) {
  const message = `${timestamp}.${method}.${uri}`;

  return crypto
    .createHmac('sha256', secretKey)
    .update(message)
    .digest('base64');
}

function toNumber(value) {
  if (value === undefined || value === null) return 0;
  if (typeof value === 'number') return value;

  const text = String(value).replace(/,/g, '').trim();

  if (text.includes('<')) return 0;

  const number = Number(text);
  return Number.isFinite(number) ? number : 0;
}

export default async function handler(req, res) {
  try {
    const keyword = String(req.query.keyword || '').trim();

    if (!keyword) {
      return res.status(400).json({
        error: 'keyword is required'
      });
    }

    const apiKey = process.env.NAVER_AD_API_KEY;
    const secretKey = process.env.NAVER_AD_SECRET_KEY;
    const customerId = process.env.NAVER_AD_CUSTOMER_ID;

    if (!apiKey || !secretKey || !customerId) {
      return res.status(500).json({
        error: 'Missing NAVER Search Ad API environment variables'
      });
    }

    const method = 'GET';
    const uri = '/keywordstool';
    const timestamp = Date.now().toString();
    const signature = makeSignature(timestamp, method, uri, secretKey);

    const params = new URLSearchParams({
      hintKeywords: keyword.replace(/\s+/g, ''),
      showDetail: '1'
    });

    const response = await fetch(
      `https://api.searchad.naver.com${uri}?${params.toString()}`,
      {
        method,
        headers: {
          'X-Timestamp': timestamp,
          'X-API-KEY': apiKey,
          'X-Customer': customerId,
          'X-Signature': signature
        }
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: 'NAVER Search Ad API failed',
        status: response.status,
        data
      });
    }

    const keywordList = Array.isArray(data.keywordList) ? data.keywordList : [];
    const exactKeywordCompact = keyword.replace(/\s+/g, '').toUpperCase();

    const exact =
      keywordList.find(item =>
        String(item.relKeyword || '').replace(/\s+/g, '').toUpperCase() === exactKeywordCompact
      ) ||
      keywordList[0] ||
      null;

    if (!exact) {
      return res.status(200).json({
        keyword,
        relKeyword: keyword,
        monthlyPc: 0,
        monthlyMobile: 0,
        monthlyTotal: 0,
        pcCtr: 0,
        mobileCtr: 0,
        competition: '',
        plAvgDepth: 0,
        related: []
      });
    }

    const monthlyPc = toNumber(exact.monthlyPcQcCnt);
    const monthlyMobile = toNumber(exact.monthlyMobileQcCnt);

    return res.status(200).json({
      keyword,
      relKeyword: exact.relKeyword,
      monthlyPc,
      monthlyMobile,
      monthlyTotal: monthlyPc + monthlyMobile,
      pcCtr: toNumber(exact.monthlyAvePcCtr),
      mobileCtr: toNumber(exact.monthlyAveMobileCtr),
      competition: exact.compIdx || '',
      plAvgDepth: toNumber(exact.plAvgDepth),
      related: keywordList.slice(0, 20).map(item => {
        const relatedPc = toNumber(item.monthlyPcQcCnt);
        const relatedMobile = toNumber(item.monthlyMobileQcCnt);

        return {
          relKeyword: item.relKeyword,
          monthlyPc: relatedPc,
          monthlyMobile: relatedMobile,
          monthlyTotal: relatedPc + relatedMobile,
          competition: item.compIdx || ''
        };
      })
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
}
