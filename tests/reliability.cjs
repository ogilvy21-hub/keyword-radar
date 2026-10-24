const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const root=path.join(__dirname,'..'),html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const elements=new Map();function el(id){if(!elements.has(id))elements.set(id,{value:id==='platformSelect'?'티스토리':id==='tistoryChannelSelect'?'moneyphd.tistory.com':'',textContent:'',innerHTML:'',style:{},addEventListener(){},querySelectorAll(){return[]},querySelector(){return null},scrollIntoView(){},classList:{add(){},remove(){},toggle(){}}});return elements.get(id)}
const c=vm.createContext({console,document:{getElementById:el,querySelectorAll:()=>[]},window:{addEventListener(){}},setTimeout,clearTimeout,URL,Map,performance,alert:()=>{}});
vm.runInContext(html.split('<script>')[1].split('\nif(els.articleBox){')[0],c);
const run=x=>vm.runInContext(x,c);let passed=0;function check(name,fn){fn();passed++;console.log('PASS',name)}
const exact={kw:'청년월세지원',monthly:5000,pc:1000,mo:4000,volumeStatus:'exact',supplyStatus:'complete',totalContent:120,relevance:10,intentClarityScore:13};c.row=exact;
check('exact verified row can rank',()=>assert.equal(run('readyForRanking(row)'),true));
for(const status of ['unavailable','not_requested','partial','lower_bound']){c.status=status;check('supply '+status+' is held',()=>assert.equal(run('readyForRanking({...row,supplyStatus:status})'),false))}
for(const status of ['unavailable','not_found','low_volume']){c.status=status;check('volume '+status+' is held',()=>assert.equal(run('readyForRanking({...row,volumeStatus:status})'),false))}
check('lower-bound ratio label',()=>assert.ok(run("ratioText({...row,supplyStatus:'lower_bound'})").includes('하한')));
check('failure ratio is unverified',()=>assert.equal(run("ratioText({...row,supplyStatus:'unavailable'})"),'미검증'));
check('zero verified count stays zero',()=>assert.equal(run("contentStatus({...row,totalContent:0})"),'0건'));
check('unrequested count never displays zero',()=>assert.equal(run("contentStatus({...row,supplyStatus:'not_requested'})"),'미조회'));
check('cafe unsupported date',()=>assert.ok(run('cafeText(row)').includes('측정 불가')));
check('null exact payload rejected',()=>assert.equal(run("rowFromExactPayload({relKeyword:'다른사람',monthlyTotal:10000},'박항서','test')"),null));
check('verified original spacing is retained',()=>assert.equal(run("rowFromExactPayload({relKeyword:'청년월세지원',volumeStatus:'exact',monthlyTotal:10,monthlyPc:1,monthlyMobile:9},'청년 월세 지원','test').kw"),'청년 월세 지원'));
check('sub-10 volume is not exact zero',()=>assert.ok(run("demandText({volumeStatus:'low_volume',monthly:null,monthlyUpperBound:18})").includes('소량')));
check('unrelated candidates cannot set intent',()=>assert.equal(run("inferIntentFromEvidence('박항서',[{kw:'보험 대출 금리 한도'}]).key"),'general'));
check('own policy terms are intent evidence',()=>assert.equal(run("inferIntentFromEvidence('청년월세지원 신청방법',[]).key"),'policy'));
check('different person names do not match',()=>assert.equal(run("sameTopic('이재','이재명 프로필')"),false));
check('short name prefix is not a second person',()=>assert.equal(run("sameTopic('정현','정현수 선수')"),false));
check('same policy with spaces matches',()=>assert.equal(run("sameTopic('청년월세지원','청년 월세 지원 대상')"),true));
check('single syllable hook rejected',()=>assert.equal(run("titleHookTail('청년월세지원금','청년월세지원')"),''));
check('meaningful hook retained',()=>assert.equal(run("titleHookTail('청년 월세 지원 신청방법','청년월세지원')"),'신청방법'));
check('unknown volume not included in title materials',()=>assert.equal(run("buildTitleMaterial('청년월세지원',[{kw:'청년월세지원 신청방법',monthly:null,volumeStatus:'unavailable'}]).hooks.length"),0));
check('purpose selector changes actual title',()=>assert.notEqual(run("generateTitleByPattern('청년월세지원',['대상'],'when')"),run("generateTitleByPattern('청년월세지원',['대상'],'target')")));
check('title preserves original keyword',()=>assert.ok(run("generateTitleByPattern('청년월세지원',['신청방법'],'apply')").startsWith('청년월세지원')));
check('lower-bound row stays comparable with a provisional label',()=>{run("state.seed='청년월세지원'");assert.ok(run("enrichScore({...row,supplyStatus:'lower_bound'},[]).score")>0);assert.ok(run("scoreText({...row,supplyStatus:'lower_bound'})").includes('잠정'))});
check('comparison index uses only demand divided by measured supply',()=>{assert.equal(run('enrichScore(row,[]).score'),exact.monthly/exact.totalContent)});
check('CPC does not add rank points',()=>{const r=run('enrichScore(row,[])');assert.ok(!r.reason.includes('고단가'))});
check('source failure cannot become a zero count',()=>{const r=run("hydrateContent(row,{_error:'503'})");assert.equal(r.totalContent,null);assert.equal(r.supplyStatus,'unavailable')});
check('malformed supply status cannot rank',()=>assert.equal(run("readyForRanking(hydrateContent(row,{recentBlogTotal:0}))"),false));
check('article sections and FAQ survive parsing',()=>{el('articleBox').value='# 점검\n\n도입\n\n## 목차\n1. 조건\n\n## 1. 조건\n내용\n\n## 2. 방법\n내용\n\n## FAQ\nQ1. 질문\n답\n\n## 자료 출처\n공식 자료';const p=run('parsePublishArticle()');assert.equal(p.sections.length,2);assert.ok(p.faq);assert.ok(p.tail)});
check('TOC numbering is not duplicated',()=>assert.ok(!run("buildTistoryTocHtmlV24([{heading:'1. 1. 조건'}])").includes('1. 1.')));
check('all body images survive Tistory metadata',()=>{run("publishHeroId='hero';publishImages=[{id:'hero',kind:'hero'},...Array.from({length:13},(_,i)=>({id:'body'+i,kind:'body',section:'unassigned',filename:i+'.jpg',w:100,h:100}))]");const r=run('normalizedImagesForTistorySendV24()');assert.equal(r.length,13);assert.ok(r.every(x=>['s1','s2'].includes(x.section)));assert.equal(run('buildTistorySendMetaV24(normalizedImagesForTistorySendV24()).images.length'),13)});
check('Tistory target selection is preserved',()=>{el('tistoryChannelSelect').value='moneyfinder.tistory.com';assert.equal(run('buildTistorySendMetaV24([]).targetHost'),'moneyfinder.tistory.com');el('tistoryChannelSelect').value='moneyphd.tistory.com'});
check('Hong ordering follows demand and supply rather than intent',()=>{c.hong=[{kw:'홍화연',monthly:40520,totalContent:462,supplyStatus:'lower_bound',volumeStatus:'exact',relevance:10},{kw:'홍화연 나이',monthly:310,totalContent:67,supplyStatus:'complete',volumeStatus:'exact',relevance:8,intentClarityScore:100},{kw:'홍화연 나무위키',monthly:760,totalContent:26,supplyStatus:'complete',volumeStatus:'exact',relevance:8}];const a=run('fillRecommended(sortCandidates(hong))');assert.equal(a.map(x=>x.kw).join(','),'홍화연,홍화연 나무위키,홍화연 나이')});
check('higher demand with less supply always ranks ahead',()=>{c.pair=[{monthly:500,totalContent:80,supplyStatus:'complete',volumeStatus:'exact',grade:'우선 검토',score:100},{monthly:10000,totalContent:50,supplyStatus:'complete',volumeStatus:'exact',grade:'검토 후보',score:1}];assert.equal(run('sortCandidates(pair)[0].monthly'),10000)});
check('missing API counts never participate as zero',()=>assert.equal(run("comparableOpportunity({monthly:10000,totalContent:null,volumeStatus:'exact',supplyStatus:'unavailable'})"),false));
check('quality warnings do not block editorial freedom',()=>assert.ok(run("searchQualityAdvice('다른 제목','홍화연')").includes('의도적으로')));
async function backend(file,fetch){const source=fs.readFileSync(path.join(root,'api',file),'utf8').replace("import crypto from 'crypto';",'').replace('export default async function handler','async function handler').replace(/export \{[^}]+\};/g,'');const box=vm.createContext({crypto,fetch,process:{env:{NAVER_CLIENT_ID:'fixture',NAVER_CLIENT_SECRET:'fixture',NAVER_AD_API_KEY:'fixture',NAVER_AD_SECRET_KEY:'fixture',NAVER_AD_CUSTOMER_ID:'fixture'}},console:{error(){}},AbortController,URLSearchParams,setTimeout,clearTimeout,Date});vm.runInContext(source,box);let body,headers={};const res={statusCode:200,status(n){this.statusCode=n;return this},setHeader(k,v){headers[k]=v},json(x){body=x;return x}};await box.handler({query:{keyword:'청년월세지원'}},res);return {body,code:res.statusCode,headers,box}}
(async()=>{
let r=await backend('searchad.js',async()=>({ok:true,json:async()=>({keywordList:[{relKeyword:'다른키워드',monthlyPcQcCnt:10000,monthlyMobileQcCnt:90000}]})}));check('server exact miss cannot borrow other volume',()=>{assert.equal(r.body.exactMatched,false);assert.equal(r.body.monthlyTotal,null);assert.equal(r.body.related[0].monthlyTotal,100000)});
r=await backend('searchad.js',async()=>({ok:true,json:async()=>({keywordList:[{relKeyword:'청년월세지원',monthlyPcQcCnt:'< 10',monthlyMobileQcCnt:'< 10'}]})}));check('server preserves threshold volume as interval',()=>{assert.equal(r.body.volumeStatus,'low_volume');assert.equal(r.body.monthlyTotal,null);assert.equal(r.body.monthlyUpperBound,18)});
r=await backend('keyword.js',async()=>({ok:false,status:503,text:async()=> 'unavailable'}));check('upstream outage returns error not zero',()=>{assert.equal(r.code,503);assert.equal(r.body.recentBlogTotal,null);assert.equal(r.body.blogStatus,'unavailable');assert.equal(r.headers['Cache-Control'],'no-store')});
r=await backend('keyword.js',async()=>({ok:true,json:async()=>({total:0,items:[]})}));check('actual empty results are complete zero',()=>{assert.equal(r.body.blogStatus,'complete');assert.equal(r.body.recentBlogTotal,0);assert.equal(r.body.recentCafeTotal,null);assert.equal(r.body.cafePagesScanned,0)});
r=await backend('keyword.js',async()=>({ok:true,json:async()=>({items:[]})}));check('malformed results cannot claim zero',()=>assert.equal(r.code,503));
let page=0;const day=new Date(Date.now()+9*3600000).toISOString().slice(0,10).replace(/-/g,'');r=await backend('keyword.js',async()=>({ok:true,json:async()=>({total:5000,items:Array.from({length:100},(_,i)=>({title:'청년월세지원',description:'조건',link:'https://example.test/'+page+++'-'+i,postdate:day}))})}));check('500-row limit is lower-bound, not complete',()=>{assert.equal(r.body.blogStatus,'lower_bound');assert.equal(r.body.recentBlogCapped,true);assert.equal(r.body.blogPagesScanned,5)});
let calls=0;r=await backend('keyword.js',async()=>++calls===1?{ok:true,json:async()=>({total:5000,items:Array.from({length:100},(_,i)=>({title:'청년월세지원',link:'https://example.test/'+i,postdate:day}))})}:{ok:false,status:503,text:async()=>''});check('partial scan keeps lower-bound and no caching',()=>{assert.equal(r.body.blogStatus,'partial');assert.equal(r.body.recentBlogTotal,100);assert.equal(r.headers['Cache-Control'],'no-store')});
r=await backend('keyword.js',async()=>({ok:true,json:async()=>({total:1,items:[{title:'청년월세지원',link:'https://example.test/1'}]})}));check('missing dates are partial, not complete zero',()=>assert.equal(r.body.blogStatus,'partial'));
const titleSource=fs.readFileSync(path.join(root,'api/titlehunt.js'),'utf8');check('raw title fallback removed',()=>{assert.ok(!titleSource.includes('combinedFiltered.length > 0 ? combinedFiltered : combinedRaw'));assert.ok(titleSource.includes('_usedRawFallback: false'))});
r=await backend('titlehunt.js',async()=>({ok:true,json:async()=>({total:1,items:[{title:'전혀 다른 배우 인터뷰',description:'이 검색어와 다른 사건',link:'https://example.test/news',pubDate:new Date().toUTCString()}]})}));
check('titlehunt returns no material for unrelated results',()=>{assert.equal(r.body._usedRawFallback,false);assert.equal(r.body.hooks.length,0);assert.equal(r.body.sampleTitles.length,0);assert.equal(r.body.newsSnippets.length,0)});
check('event qualifiers remain in news search',()=>assert.equal(vm.runInContext("buildFreshNewsQuery('손석구 최희서 결혼')",r.box),'손석구 최희서 결혼'));
let tries=0;c.memo=new Map();c.loader=async()=>{tries++;if(tries===1)throw Error('temporary');return {value:'fresh'}};
try{await run("memoEvidence(memo,'k',loader,1000)")}catch(_){}
await run("memoEvidence(memo,'k',loader,1000)");check('transient failure can be retried',()=>assert.equal(tries,2));
console.log(`All ${passed} reliability/title/publishing regression checks passed`);
})().catch(e=>{console.error(e);process.exitCode=1});
