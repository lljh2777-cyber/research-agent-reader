"use strict";
// Development-only preparation: no credentials, model calls, deletions or automatic grading.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {loadReading}=require('../tests/reading-test-helpers');
const {validateTopicIntent,validateTopicPlan,topicObject}=loadReading('topic-learning/contracts.ts');
const {TOPIC_TEACHING_RULES}=loadReading('topic-learning/teaching.ts');
const {STUDY_PROMPT_VERSION}=loadReading('topic-learning/study.ts');
const sha=value=>crypto.createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const fail=()=>{throw Error('Invalid topic teaching baseline')};
function validate(spec){
 topicObject(spec,['version','id','referenceStatus','independentReview','references','globalChecks','samples']);
 if(spec.version!==1||spec.id!=='topic-t1-v1'||spec.referenceStatus!=='provisional'||spec.independentReview!=='pending'||!Array.isArray(spec.samples)||spec.samples.length!==2||!Array.isArray(spec.references))fail();
 const strings=a=>Array.isArray(a)&&a.length>0&&a.every(x=>typeof x==='string'&&x.trim());if(!strings(spec.globalChecks))fail();
 const references=new Set(spec.references.map(r=>r.id));if(references.size!==spec.references.length)fail();
 for(const r of spec.references)if(!/^https:\/\//.test(r.url)||r.basis!=='external-official-documentation'||!r.supports)fail();
 const sampleIds=new Set(),allSteps=new Set();
 for(const sample of spec.samples){
  topicObject(sample,['id','intent','plan','steps']);if(sampleIds.has(sample.id))fail();sampleIds.add(sample.id);validateTopicIntent(sample.intent);const plan=validateTopicPlan(sample.plan),prior=new Map(),branches=new Map();let main=0;
  if(!Array.isArray(sample.steps)||sample.steps.length>20)fail();
  for(const step of sample.steps){
   topicObject(step,step.action==='next'?['id','action','expectedPoints','mustNotClaim','references']:['id','action','parent','question','newBranch','expectedPoints','mustNotClaim','references']);
   if(!/^[MN]\d{2}$/.test(step.id)||allSteps.has(step.id)||!strings(step.expectedPoints)||!strings(step.mustNotClaim)||!Array.isArray(step.references)||step.references.some(id=>!references.has(id)))fail();allSteps.add(step.id);
   if(step.action==='next'){if(++main>plan.modules.length)fail();prior.set(step.id,null)}
   else if(step.action==='ask'&&prior.has(step.parent)&&typeof step.question==='string'&&step.question.trim()&&step.question.length<=2000&&typeof step.newBranch==='boolean'){
    const branch=step.newBranch||!prior.get(step.parent)?step.id:prior.get(step.parent);if(branches.has(branch)&&branches.get(branch)!==step.parent)fail();branches.set(branch,step.id);prior.set(step.id,branch);
   }else fail();
  }
 }
 if(allSteps.size!==9)fail();return spec;
}
function prepare(spec){
 validate(spec);const baselineHash=sha(spec),instructionHash=sha(TOPIC_TEACHING_RULES);
 const inputs={version:1,baselineHash,promptVersion:STUDY_PROMPT_VERSION,instructionHash,system:TOPIC_TEACHING_RULES,mode:'sequential-topic-teaching',automaticRetries:0,
  samples:spec.samples.map(s=>({id:s.id,intent:structuredClone(s.intent),plan:structuredClone(s.plan),steps:s.steps.map(q=>q.action==='next'?{id:q.id,action:q.action}:{id:q.id,action:q.action,parent:q.parent,question:q.question,newBranch:q.newBranch})}))};
 const observation={version:1,baselineHash,instructionHash,inputHash:sha(inputs),sampleCount:spec.samples.length,questionCount:9,modelAnswerStatus:'not_run',independentReviewStatus:'pending'};
 const review=['# 主题教学冻结样本：待独立审阅','','模型回答尚未运行；当前要点是待审阅参考，不是通过结论。真实运行时按样本步骤执行，保留当时实际请求、首次响应和原始用量。参考要点与失败反例不得发送给被测模型。',''];
 for(const s of spec.samples){review.push('## '+s.id,'',s.intent.topic+'：'+s.intent.goal,'','基础：'+s.intent.background,'');for(const q of s.steps)review.push('### '+q.id,'',q.question||'按固定路线讲解下一主线单元','',...q.expectedPoints.map(v=>'- 待检查：'+v),...q.mustNotClaim.map(v=>'- 失败反例：'+v),'','独立审阅：待填写；事实、教学适配、来源诚实和主支线连续性分别判断。','');}
 review.push('## 外部核对来源','',...spec.references.map(r=>`- [${r.id}](${r.url})：${r.supports} 核对日期 ${r.checked}。`),'','这些外部文档用于复核要点，不是被测学习会话已经读取的证据。','');
 return{inputs,observation,review:review.join('\n')};
}
module.exports={validate,prepare,sha};
if(require.main===module){
 try{
  if(process.argv[2]!=='prepare'||!path.isAbsolute(process.argv[3]||''))throw Error('Usage: node scripts/topic-quality-baseline.cjs prepare <new absolute directory outside repository>');
  const directory=path.resolve(process.argv[3]),repo=path.resolve(__dirname,'..'),canonical=p=>process.platform==='win32'?p.toLowerCase():p;if(canonical(directory)===canonical(repo)||canonical(directory).startsWith(canonical(repo)+path.sep))throw Error('Keep prepared review material outside the repository');
  const spec=require('../tests/fixtures/topic-quality/t1-v1.json'),result=prepare(spec),frozen=require('../tests/fixtures/topic-quality/t1-v1-observation.json');
  if(JSON.stringify(result.observation)!==JSON.stringify(frozen))throw Error('Frozen baseline or teaching instructions changed');
  fs.mkdirSync(directory);for(const[name,text]of [['specification.json',JSON.stringify(spec,null,2)],['inputs.json',JSON.stringify(result.inputs,null,2)],['observation.json',JSON.stringify(result.observation,null,2)],['review.md',result.review]])fs.writeFileSync(path.join(directory,name),text,{flag:'wx',encoding:'utf8'});
  console.log(JSON.stringify({directory,...result.observation}));
 }catch(e){console.error(String(e));process.exitCode=1;}
}
