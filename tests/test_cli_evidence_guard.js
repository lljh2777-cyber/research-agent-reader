const assert = require("node:assert/strict");
const { loadReading } = require("./reading-test-helpers");
const { verifyCliAdjustmentClaim: verify } = loadReading("annotations/cli-evidence-guard.ts");
const { AnnotationService } = loadReading("annotations/annotation-service.ts");
const evidence = "In an observational study of 96 participants, the high-expression group had a lower observed risk than the low-expression group. Follow-up timing and adjusted covariates are not specified.";
// Exact assertions retained from two real Step responses, including a labelled
// general-knowledge paragraph. Labelling a claim does not make it supported.
for (const text of ["这里只能按原文表述理解为两组之间的未调整观察比较。", "一般知识／解释性推断：此类观测风险比较属于未经调整的组间描述。"])
 assert.throws(() => verify(text, evidence), /未提供的调整信息/);
for (const text of ["不能理解为未经调整的比较。", "是否为未调整比较，片段没有说明。", "如果是未经调整的比较，还需另作核对。", "可能是未调整比较，但片段无法判断。", "两组存在差异，是否调整未知。"])
 assert.doesNotThrow(() => verify(text, evidence));
assert.doesNotThrow(() => verify("原文依据：这是未经调整的组间比较。", "The authors report an unadjusted comparison of the two groups."));
assert.doesNotThrow(() => verify("这是未调整比较。", "No covariate adjustment was performed."));
assert.doesNotThrow(() => verify("这是未调整比较。", "The estimates were not adjusted for covariates."));
assert.throws(() => verify("这是未调整比较。", "The paper does not state whether the comparison was unadjusted."));
assert.throws(() => verify("这是未调整比较。", "Unadjusted analysis was not reported in the passage."));
(async () => {
 let calls=0;
 const cli={generate:async()=>{calls++;return {text:"此类观测风险比较属于未经调整的组间描述。",requestedModel:"step-5-preview"};}};
 const service=new AnnotationService({}, {settings:{annotationBackendId:"codebuddy",annotationCodeBuddyModel:"step-5-preview",annotationCliTimeoutSeconds:120}},cli);
 await assert.rejects(service.generateExplanation({sourcePath:"papers/fixture.md",selectedText:"lower observed risk",context:evidence},()=>{}),/未提供的调整信息/);
 assert.equal(calls,1,"reject unsupported result without a retry or model substitution");
 console.log("CLI_EVIDENCE_GUARD_OK (observed failures, qualified statements, explicit evidence, one-call routing)");
})().catch(error=>{console.error(error);process.exitCode=1;});
