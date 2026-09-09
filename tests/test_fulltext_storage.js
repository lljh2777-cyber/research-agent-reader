"use strict";
// Exercise the real FileAcquisitionStorage implementation against a memory filesystem.
const assert = require("node:assert/strict"), path = require("node:path"), { randomUUID } = require("node:crypto");
const { loadReading } = require("./reading-test-helpers"), { request } = require("./fulltext-fixtures.cjs");
const files = new Map(), dirs = new Set(), links = new Set(); let failSync = "", opened = 0, closed = 0;
const error = code => Object.assign(new Error(code), { code });
const base = path.resolve("fulltext-memory-fixture"); dirs.add(base);
const stat = name => ({ isDirectory: () => dirs.has(name), isFile: () => files.has(name), isSymbolicLink: () => links.has(name), size: Buffer.byteLength(files.get(name) || ""), ino: 1, dev: 1 });
const fakeFs = {
	async lstat(name) { if (!dirs.has(name) && !files.has(name)) throw error("ENOENT"); return stat(name); },
	async realpath(name) { return name; },
	async mkdir(name) { if (dirs.has(name)) throw error("EEXIST"); dirs.add(name); },
	async opendir(name) { const entries = [...files.keys()].filter(file => path.dirname(file) === name).map(file => ({ name: path.basename(file) })); return { async read() { return entries.shift() || null; }, async close() {} }; },
	async open(name, flags) {
		if (flags === "wx") { if (files.has(name)) throw error("EEXIST"); files.set(name, ""); }
		else if (!files.has(name)) throw error("ENOENT");
		opened++;
		return { async stat() { return stat(name); }, async readFile(encoding) { return encoding ? files.get(name).toString(encoding) : Buffer.from(files.get(name)); },
			async read(buffer, offset, length, position) { const bytes=Buffer.from(files.get(name)); const bytesRead=bytes.copy(buffer,offset,position,position+length); return {bytesRead,buffer}; },
			async writeFile(bytes) { files.set(name, Buffer.concat([Buffer.from(files.get(name)),Buffer.from(bytes)])); }, async sync() { if (failSync && name.endsWith(failSync)) throw error("EIO"); }, async close() { closed++; } };
	},
};
const { FileAcquisitionStorage } = loadReading("fulltext/file-storage.ts", { "node:fs/promises": fakeFs });
const job = { schemaVersion: 1, id: "a-" + randomUUID(), attemptId: "a-" + randomUUID(), mode: "demo", deviceId: "fixture", request: request(), revision: 1, phase: "queued", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), detail: "", error: "", candidates: [] };
(async () => {
	const store = new FileAcquisitionStorage(base, "demo");
	assert.deepEqual(await store.listJobs(), []); assert.equal(dirs.size, 1, "read-only startup creates no directories");
	await store.writeJob(job); assert.deepEqual(await store.listJobs(), [job.id]); assert.deepEqual(await store.readJob(job.id), job);
	const root = path.join(base, "fulltext", "demo");
	await store.writeJob({ ...job, revision: 2, phase: "resolving" });
	failSync = ".json"; await assert.rejects(store.writeJob({ ...job, revision: 3, phase: "discovering" })); failSync = "";
	assert.equal((await store.readJob(job.id)).revision, 2, "torn JSON has no ready marker");
	await store.writeJob({ ...job, revision: 4 }); assert.equal((await store.readJob(job.id)).revision, 4);
	await store.writeJob({ ...job, revision: 4 }); await assert.rejects(store.readJob(job.id), /并发/);
	const second = { ...job, id: "a-" + randomUUID() }; await store.writeJob(second);
	const marker = [...files.keys()].find(file => file.includes(second.id) && file.endsWith(".ready")); files.set(marker, "partial"); await assert.rejects(store.readJob(second.id), /标记/);
	files.set(marker, "ready"); const json = marker.slice(0, -6); files.set(json, JSON.stringify({ ...second, revision: 999 })); await assert.rejects(store.readJob(second.id), /修订/);
	files.set(json, "x".repeat(256 * 1024 + 1)); await assert.rejects(store.readJob(second.id), /文件无效/);
	files.set(json, JSON.stringify(second)); links.add(json); await assert.rejects(store.readJob(second.id), /文件无效/); links.clear();
	links.add(root); await assert.rejects(store.listJobs(), /普通目录/); links.clear();
	await assert.rejects(store.readJob("../../escape"), /标识/);
	const snapshot = { schemaVersion: 1, id: "s-" + randomUUID(), jobId: job.id, attemptId: job.attemptId, mode: "demo", simulated: true, input: job.request.input, candidateId: "c-one", createdAt: job.createdAt };
	await store.writeSnapshot(snapshot); assert.deepEqual(await store.readSnapshot(snapshot.id), snapshot); await assert.rejects(store.writeSnapshot(snapshot), /EEXIST/);
	const production = new FileAcquisitionStorage(base, "production"); assert.deepEqual(await production.listJobs(), []); assert.equal(dirs.has(path.join(base, "fulltext", "production")), false);
	const attempt="a-"+randomUUID(), bytes=Buffer.from("%PDF-1.7\nreal storage fixture\n%%EOF\n");
	const writer=await production.beginArtifact(attempt); await writer.write(bytes.subarray(0,8)); await writer.write(bytes.subarray(8));
	const artifact=await writer.finish(); await assert.rejects(writer.write(bytes),/关闭/); await writer.close();
	assert.deepEqual(Buffer.from(await production.readArtifact(artifact)),bytes); await assert.rejects(production.beginArtifact(attempt),/EEXIST/);
	await assert.rejects(store.beginArtifact("a-"+randomUUID()),/标识/); await assert.rejects(production.beginArtifact("../escape"),/标识/);
	const pdfPath=path.join(base,"fulltext","production",artifact.filename); links.add(pdfPath); await assert.rejects(production.readArtifact(artifact),/变化/); links.clear();
	files.set(pdfPath,Buffer.alloc(bytes.length)); await assert.rejects(production.readArtifact(artifact),/校验/);
	files.set(pdfPath,Buffer.alloc(bytes.length+1)); await assert.rejects(production.readArtifact(artifact),/变化/);
	const partial=await production.beginArtifact("a-"+randomUUID()); await partial.write(bytes); failSync=".pdf"; await assert.rejects(partial.finish(),/EIO/); failSync=""; await partial.close();
	assert.equal(opened, closed, "all file handles close after successful and failed operations");
	console.log("PASS fulltext storage: immutable revisions/artifacts, torn writes, collision detection, marker validation, bounded reads, path/link rejection, hash tampering, mode isolation and handle cleanup");
})().catch(error => { console.error(error); process.exitCode = 1; });
