"use strict";
const assert = require("node:assert/strict");
const {loadReading} = require("./reading-test-helpers");
const {parseBilingualMarkdown} = loadReading("reader/bilingual-document.ts");
const {GuideEvidenceIndex, guideParent, MAIN_GUIDE} = loadReading("reading/inline-guide.ts");
const {paperMapTree} = loadReading("views/paper-discussion-map.ts");

const text = "# Results\n\n![Fig. 1: Comparison](<images/a.png>)\n\nFig. 1: Comparison\n\nThe small group scored higher in Fig. 1b and Table 2.\n\nTable 2: Measurements\n\n| Group | Score |\n| --- | --- |\n| Small | 2 |\n";
const file = {text, blocks:parseBilingualMarkdown(text).blocks};
const index = new GuideEvidenceIndex(file), quote = "The small group scored higher";
const chunk = text.slice(text.indexOf(quote),text.indexOf("Table 2:")).trim();
const e = {id:"p",kind:"paper",path:"paper.md",text:chunk,start:text.indexOf(quote)};
const main = {id:"m",branchId:null,title:"Results",content:'“'+quote+'” [p]',evidence:[e]};
const links = index.forTurn(main,["paper.md"]);
assert.deepEqual(links.map(l=>l.kind),["text","figure","table"]);
assert.equal(text.slice(links[0].start,links[0].end),quote);
assert.match(links[1].label,/1b/);
assert.equal(links[1].block.kind,"image");
assert.equal(links[2].block.kind,"table");
assert.deepEqual(index.forTurn({...main,evidence:[{...e,start:e.start+1}]},["paper.md"]),[]);
assert.deepEqual(index.forTurn(main,["another.md"]),[]);

// Cell places the numbered caption after a blank-alt image, without a colon.
const cell = "![](<images/a.jpg>)\n\nFigure 1 Main results\n\n(B) Measurements\n\n![](<images/b.jpg>)\n\nFigure S1 Additional results";
const cellIndex = new GuideEvidenceIndex({text:cell,blocks:parseBilingualMarkdown(cell).blocks});
for (const [asset,number] of [["a","图 1"],["b","图 S1"]]) {
	const tag = "![](<images/" + asset + ".jpg>)";
	const hit = cellIndex.forTurn({...main, evidence:[{...e,label:"Results",text:tag,start:cell.indexOf(tag),asset:asset+".jpg"}]},["paper.md"]);
	assert.equal(hit[0].figureNumber,number);
	assert.equal(cell.slice(hit[0].start,hit[0].end).trim(),tag);
}

const session = {mainIds:["m"],nodes:[main,...["question","annotation","nested"].map(id=>({id,branchId:id,content:"",question:id}))],
branches:[
	{id:"question",parentNodeId:"m",nodeIds:["question"]},
	{id:"annotation",parentNodeId:"m",annotation:{id:"quote"},nodeIds:["annotation"]},
	{id:"nested",parentNodeId:"question",nodeIds:["nested"]}
]};
const tree = paperMapTree(session,[{id:"quote",order:1}],new Map([["m",links]]));
assert.equal(tree.nodes.get("m").parent.id,MAIN_GUIDE);
assert.equal(tree.nodes.get("question").parent.id,"m");
assert.equal(tree.nodes.get("annotation").parent.id,"quote");
assert.equal(guideParent(session,"nested").id,"m");
assert.equal(guideParent(session,"annotation"),undefined);
console.log("INLINE_GUIDE_OK");
