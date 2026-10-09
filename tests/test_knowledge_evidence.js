"use strict";
// All fixtures are in memory; no cleanup or external calls.
const assert = require("node:assert/strict");
const { loadReading } = require("./reading-test-helpers");
class TFile { constructor(path) { this.path = path; } }
const { readVaultEvidencePackets } = loadReading("services/vault-evidence.ts", { obsidian: { TFile } });
const { contentHash } = loadReading("retrieval/chunks.ts");
const { knowledgeTrace } = loadReading("retrieval/trace.ts");
async function main() {
 const file = new TFile("wiki/sources/alpha.md"); const other = new TFile("wiki/sources/beta.md");
 let text = "irrelevant\nEvidence that must be read.\ntrailing";
 const app = { vault: { getAbstractFileByPath: path => [file, other].find(f => f.path === path), cachedRead: async () => text } };
 const hit = { id: "h", path: file.path, hash: contentHash(text), title: "Alpha", heading: "Methods", start: 11, end: 37, text: "DO NOT TRUST CACHED TEXT", input: "private embedding input", vectorKey: "private vector key", role: "evidence", origins: [file.path], depth: "abstract-level", basis: "vault", score: 0.9 };
 const trace = knowledgeTrace({ mode: "hybrid", hits: [hit, { ...hit, path: other.path }], warnings: [], scope: [file.path], indexedChunks: 2, totalChunks: 2, documents: 2 });
 assert(!("input" in trace.knowledge_passages[0])); assert(!("vectorKey" in trace.knowledge_passages[0]));
 const packets = await readVaultEvidencePackets(app, trace);
 assert.equal(packets.length, 1); assert(packets[0].content.includes(text.slice(11, 37))); assert(!packets[0].content.includes("DO NOT TRUST"));
 assert(packets[0].content.includes("abstract-level")); assert.equal(packets[0].hash, hit.hash);
 assert.equal((await readVaultEvidencePackets(app, { ...trace, knowledge: { ...trace.knowledge, scope: [] } })).length, 0);
 text += " changed"; assert.equal((await readVaultEvidencePackets(app, trace)).length, 0);
 const invalid = { ...hit, hash: contentHash(text), end: 10000 };
 assert.equal((await readVaultEvidencePackets(app, { knowledge_passages: [invalid] })).length, 0);
 const legacy = await readVaultEvidencePackets(app, { candidate_paths: [file.path] }); assert.equal(legacy[0].content, text);
 console.log("KNOWLEDGE_EVIDENCE_OK");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
