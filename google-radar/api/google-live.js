function decodeXml(s=''){
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1')
    .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/&quot;/g,'"').replace(/&#39;/g,"'").trim();
}
function stripTags(s=''){ return decodeXml(String(s).replace(/<[^>]+>/g,' ')).replace(/\s+/g,' ').trim(); }
function tag(block,name){
  const re=new RegExp('<(?:ht:)?'+name+'[^>]*>([\\s\\S]*?)<\\/(?:ht:)?'+name+'>','i');
  const m=String(block).match(re); return m?stripTags(m[1]):'';
}
function tagRaw(block,name){
  const re=new RegExp('<(?:ht:)?'+name+'[^>]*>([\\s\\S]*?)<\\/(?:ht:)?'+name+'>','i');
  const m=String(block).match(re); return m?decodeXml(m[1]):'';
}
function trafficValue(v){ const n=Number(String(v||'').replace(/[^0-9]/g,'')); return Number.isFinite(n)?n:0; }
function parseFeed(xml){
  const items=[];
  const blocks=String(xml).match(/<item>[\s\S]*?<\/item>/gi)||[];
  for(const block of blocks){
    const title=tag(block,'title'); if(!title) continue;
    const traffic=tag(block,'approx_traffic');
    const pubDate=tag(block,'pubDate');
    const picture=tagRaw(block,'picture');
    const pictureSource=tag(block,'picture_source');
    const news=[];
    const newsBlocks=block.match(/<ht:news_item>[\s\S]*?<\/ht:news_item>/gi)||[];
    for(const nb of newsBlocks){
      const t=tag(nb,'news_item_title');
      const url=tagRaw(nb,'news_item_url');
      const source=tag(nb,'news_item_source');
      const snippet=tag(nb,'news_item_snippet');
      if(t||url) news.push({title:t,url,source,snippet});
    }
    items.push({
      keyword:title,
      traffic,
      traffic_value:trafficValue(traffic),
      started_at:pubDate,
      picture,
      picture_source:pictureSource,
      news
    });
  }
  return items;
}
export default async function handler(req,res){
  res.setHeader('Cache-Control','s-maxage=180, stale-while-revalidate=300');
  try{
    const url='https://trends.google.com/trending/rss?geo=KR';
    const r=await fetch(url,{headers:{
      'User-Agent':'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/155 Safari/537.36',
      'Accept':'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
      'Accept-Language':'ko-KR,ko;q=0.9,en;q=0.7'
    },cache:'no-store'});
    if(!r.ok) throw new Error('Google Trends RSS HTTP '+r.status);
    const xml=await r.text();
    const items=parseFeed(xml).map((x,i)=>({...x,feed_rank:i+1}));
    if(!items.length) throw new Error('Google Trends RSS returned no items');
    return res.status(200).json({
      ok:true,
      source:'Google Trends Trending Now RSS · KR',
      source_url:url,
      fetched_at:new Date().toISOString(),
      count:items.length,
      trends:items
    });
  }catch(e){
    console.error('google-live error:',e.message);
    return res.status(500).json({ok:false,error:'Failed to load Google Trends',detail:e.message});
  }
}
