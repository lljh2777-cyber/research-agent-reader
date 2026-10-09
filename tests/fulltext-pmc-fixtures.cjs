const { createHash } = require("node:crypto");
const { memory } = require("./fulltext-fixtures.cjs");
const bytes = Buffer.from("%PDF-1.7\nfixture PDF bytes\n%%EOF\n");
const md5 = createHash("md5").update(bytes).digest("hex");
const title = "A deterministic scientific article for fulltext acquisition tests";
const ids = { doi: "10.1234/example", pmid: "123", pmcid: "PMC123" };
const identity = { title, authors: ["Example A"], year: "2025", identifiers: ids, publicationTypes: ["research-article"], warnings: [], evidence: [{ provider: "europe-pmc", recordId: "MED:123", observedAt: "2026-09-09T00:00:00.000Z", fields: ["identifiers", "title", "authors", "year", "publicationTypes"] }] };
const request = policy => ({ input: {kind:"pmcid",value:ids.pmcid},goal:"pdf",versionPolicy:policy||"record_only" });
const europe = {hitCount:1,resultList:{result:[{id:ids.pmid,source:"MED",...ids,title,authorList:{author:[{fullName:"Example A"}]},pubYear:"2025",pubTypeList:{pubType:["research-article"]}}]}};
const crossref = {message:{DOI:ids.doi,title:[title],author:[{given:"A",family:"Example"}],issued:{"date-parts":[[2025]]},type:"journal-article"}};
const manifest = (version = 1, changes = {}) => ({pmcid:ids.pmcid,pmid:Number(ids.pmid),doi:ids.doi,title,version,is_manuscript:false,is_pmc_openaccess:true,is_retracted:false,license_code:"CC BY",pdf_url:`s3://pmc-oa-opendata/PMC123.${version}/PMC123.${version}.pdf?md5=${md5}`,xml_url:`s3://pmc-oa-opendata/PMC123.${version}/PMC123.${version}.xml?md5=${md5}`,...changes});
const listing = versions => `<?xml version="1.0"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>pmc-oa-opendata</Name><Prefix>PMC123.</Prefix><IsTruncated>false</IsTruncated>${versions.map(v=>`<CommonPrefixes><Prefix>PMC123.${v}/</Prefix></CommonPrefixes>`).join("")}</ListBucketResult>`;
const response = (value,status=200) => ({status,headers:{"content-type":"application/json"},bytes:Buffer.from(typeof value === "string" ? value : JSON.stringify(value))});
const store = () => {
	const journal = memory(), artifacts = new Map();
	return Object.assign(journal, {artifacts, async beginArtifact(attemptId) {
		const filename=attemptId+".pdf"; if(artifacts.has(filename))throw new Error("exists"); artifacts.set(filename,Buffer.alloc(0));
		return {async write(chunk){artifacts.set(filename,Buffer.concat([artifacts.get(filename),chunk]));},async finish(){const value=artifacts.get(filename);return{filename,byteLength:value.length,sha256:createHash("sha256").update(value).digest("hex"),md5:createHash("md5").update(value).digest("hex")};},async close(){}};
	}, async readArtifact(artifact){const value=artifacts.get(artifact.filename);if(!value||value.length!==artifact.byteLength||createHash("sha256").update(value).digest("hex")!==artifact.sha256)throw new Error("changed");return new Uint8Array(value);}});
};
const pdfLoader = (text = title + " DOI: " + ids.doi, overrides={}) => async () => ({getDocument(){return{promise:Promise.resolve({numPages:2,async getPage(){return{async getTextContent(){return{items:[{str:text}]};},cleanup(){}};},...overrides}),async destroy(){}};}});
const transport = () => ({ calls:[], downloads:0, manifests:[manifest()], noEurope:false, noCrossref:false, failDownload:false,
	async metadata(raw){this.calls.push(raw);const url=new URL(raw);if(url.hostname==="www.ebi.ac.uk")return response(this.noEurope?{hitCount:0,resultList:{result:[]}}:europe);if(url.hostname==="api.crossref.org")return response(crossref,this.noCrossref?404:200);if(url.pathname==="/")return response(listing(this.manifests.map(v=>v.version)));const version=Number(/\.(\d+)\.json$/.exec(url.pathname)?.[1]);return response(this.manifests.find(v=>v.version===version)||{},this.manifests.some(v=>v.version===version)?200:404);},
	async download(url,signal,sink,progress){this.downloads++;signal.throwIfAborted();await sink.write(bytes.subarray(0,8));progress(8,bytes.length);if(this.failDownload)throw new Error("disconnected");await sink.write(bytes.subarray(8));progress(bytes.length,bytes.length);},
});
module.exports={bytes,md5,title,ids,identity,request,europe,crossref,manifest,listing,response,store,pdfLoader,transport};
