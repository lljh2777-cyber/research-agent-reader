"use strict";
const base=require("./fulltext-pmc-fixtures.cjs"),path=require("node:path");
exports.config={enabled:true,email:"reader@example.org"};
exports.record=(locations=[exports.location("https://publisher.example.org/paper.pdf")])=>({doi:base.ids.doi,oa_locations:locations});
exports.location=(url,version="publishedVersion",extras={})=>({url_for_pdf:url,version,host_type:"publisher",license:"cc-by",...extras});
exports.request=()=>({...base.request(),useUnpaywall:true});
exports.transport=()=>{const net=base.transport(),metadata=net.metadata;net.manifests=[base.manifest(1,{pdf_url:null})];net.oa=exports.record();net.metadata=async function(url,signal){if(new URL(url).hostname==="api.unpaywall.org"){this.calls.push(url);return base.response(this.oa);}return metadata.call(this,url,signal);};return net;};
exports.store=()=>{const storage=base.store();storage.artifactPath=async artifact=>{await storage.readArtifact(artifact);return path.resolve("m3-memory",artifact.filename);};return storage;};
