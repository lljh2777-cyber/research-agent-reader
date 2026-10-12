const assert = require("node:assert/strict");
const { loadReading } = require("./reading-test-helpers");
const { openCodeTextAdapter: adapter, OPENCODE_ANNOTATION_MODELS } = loadReading("runtime/opencode-text.ts");
const { AnnotationService } = loadReading("annotations/annotation-service.ts");
(async () => {
	for (const { id } of OPENCODE_ANNOTATION_MODELS) {
		const invocation=adapter.invocation(id,"Use only supplied text","中文\n$() context"), env=invocation.env("/isolated/request");
		assert.equal(invocation.args.at(-1),"中文\n$() context");assert.equal(adapter.input("text"),null);
		assert.equal(invocation.args[invocation.args.indexOf("--model")+1],id);
		assert.ok(invocation.args.includes("--pure")); assert.ok(!invocation.args.some(flag=>["--auto","--share","--continue","--session"].includes(flag)));
		const config=JSON.parse(env.OPENCODE_CONFIG_CONTENT);
		assert.equal(config.agent["research-annotation"].model,id); assert.deepEqual(config.permission,{"*":"ask"}); assert.deepEqual(JSON.parse(env.OPENCODE_PERMISSION),{"*":"ask"}); assert.equal(config.share,"disabled");
		assert.equal(config.agent["research-annotation"].steps,2,"first response must not receive the max-steps report prompt");
		assert.equal(env.XDG_CONFIG_HOME,invocation.env("/another/request").XDG_CONFIG_HOME); assert.notEqual(env.XDG_CONFIG_HOME,"/isolated/request"); assert.equal(env.OPENCODE_DISABLE_PRUNE,"true");
		assert.equal(env.OPENCODE_CONFIG_DIR,"");assert.equal(env.OPENCODE_DISABLE_PROJECT_CONFIG,"true");
	}
	assert.throws(()=>adapter.invocation("step-5-preview",""),/provider\/model/);
	const stream=reason=>JSON.stringify({type:"text",sessionID:"one",part:{type:"text",text:"相关不能证明因果。"}})+"\n"+JSON.stringify({type:"step_finish",sessionID:"one",part:{reason,cost:0,tokens:{input:100,output:20,cache:{read:5,write:0}}}});
	const parsed=adapter.parse(stream("stop"),OPENCODE_ANNOTATION_MODELS[0].id);
	assert.equal(parsed.reportedModel,undefined); assert.equal(parsed.costUsd,0); assert.equal(parsed.usage.input_tokens,100);
	assert.equal(adapter.parse(stream("stop")+"\n"+JSON.stringify({type:"metadata",model:{providerID:"opencode",modelID:"step-5-preview-free"}}),parsed.requestedModel).reportedModel,parsed.requestedModel);
	assert.throws(()=>adapter.parse(stream("stop")+"\n"+JSON.stringify({type:"metadata",model:"opencode/other-model"}),parsed.requestedModel),/模型不一致/);
	for(const reason of ["length","tool-calls",undefined]) assert.throws(()=>adapter.parse(stream(reason),parsed.requestedModel));
	for(const type of ["error","tool_use"]) assert.throws(()=>adapter.parse(stream("stop")+"\n"+JSON.stringify({type}),parsed.requestedModel));
	assert.throws(()=>adapter.parse(stream("stop")+"\n"+JSON.stringify({type:"text",sessionID:"other"}),parsed.requestedModel));
	assert.throws(()=>adapter.parse(stream("stop")+"\n"+JSON.stringify({type:"step_finish",part:{reason:"stop"}}),parsed.requestedModel));
	let request,calls=0;
	const cli={generate:async(r,a)=>{calls++;request=r;assert.equal(a.label,"OpenCode");return parsed;}};
	const settings={annotationBackendId:"opencode",openCodeConfigSource:"official",openCodeExecutable:"native",annotationOpenCodeModel:parsed.requestedModel,openCodeModel:"old-configured-model",annotationCliTimeoutSeconds:120};
	const service=new AnnotationService({}, {settings},cli),selection={sourcePath:"papers/fixture/article.md",selectedText:"association",section:"Results",context:"Association does not establish causation."};
	const answer=await service.generateExplanation(selection,()=>{}); assert.equal(request.model,parsed.requestedModel); assert.match(answer.model,/未报告实际模型/);
	assert.match(request.system,/原文依据：/);assert.match(request.system,/一般知识／解释性推断：/);
	assert.match(request.system,/禁止调用任何工具、读取文件/);
	settings.annotationOpenCodeModel=""; settings.openCodeModel=OPENCODE_ANNOTATION_MODELS[1].id; await service.generateExplanation(selection,()=>{});assert.equal(request.model,settings.openCodeModel);
	// Existing CC Switch/web routing stays owned by the existing action runner.
	const action={id:"annotation-explain"};let actionRuns=0;
	const legacy=new AnnotationService({}, {settings,getDashboardAction:()=>action,resolveCliActionExecutionConfig:()=>({}),runVaultAction:async()=>{actionRuns++;return {exitCode:0,stdout:"legacy",stderr:""};}},cli);
	settings.openCodeConfigSource="cc-switch"; await legacy.generateExplanation(selection,()=>{});assert.equal(actionRuns,1);assert.equal(calls,2);
	settings.openCodeConfigSource="official";settings.annotationWebSearchEnabled=true;await legacy.generateExplanation(selection,()=>{});assert.equal(actionRuns,2);assert.equal(calls,2);
	console.log("OPENCODE_ANNOTATIONS_OK (exact model IDs, permissions, complete parts, unknown actual model, legacy routing)");
})().catch(error=>{console.error(error);process.exitCode=1;});
