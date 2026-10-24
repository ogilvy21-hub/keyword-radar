const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const html=fs.readFileSync(path.join(__dirname,'../google-radar/index.html'),'utf8');
const script=html.split('<script>')[1].split('</script>')[0];new vm.Script(script);
function extract(name){const start=script.indexOf('function '+name+'(');assert.ok(start>=0);const rest=script.slice(start);const end=rest.indexOf('\nfunction ',1);return end<0?rest:rest.slice(0,end)}
const c=vm.createContext({fmt:String,googleFit:()=>[],intentBucket:()=>'',demandScore:()=>75,classifyDemand:()=> '수요 후보',trafficValue:()=>0});
for(const n of ['ratio','verifiedRow','volumeText','blogText','demandPoints','calculate','decisionForDemand'])vm.runInContext(extract(n),c);
for(const status of ['not_requested','unavailable','partial','lower_bound']){c.r={monthly:5000,blog:0,volumeStatus:'exact',supplyStatus:status};assert.equal(vm.runInContext('calculate(r).score',c),null);assert.equal(vm.runInContext('decisionForDemand([r],1,0).code',c),'HOLD')}
c.r={monthly:5000,blog:0,volumeStatus:'exact',supplyStatus:'complete'};assert.equal(vm.runInContext('calculate(r).score',c),75);assert.equal(vm.runInContext('blogText(r)',c),'0건');
c.r={monthly:0,blog:null,volumeStatus:'low_volume',supplyStatus:'unavailable'};assert.equal(vm.runInContext('calculate(r).score',c),null);assert.equal(vm.runInContext('blogText(r)',c),'미확인');
console.log('PASS Google Radar shared API compatibility: incomplete data held, complete zero retained, low volume held, full script syntax valid');
