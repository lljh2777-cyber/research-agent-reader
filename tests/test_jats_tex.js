"use strict";
// Memory fixtures only. No network, models, filesystem writes or cleanup.
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { loadReading } = require("./reading-test-helpers");
const f = require("./jats-fixtures.cjs"), wiki = require("./jats-wiki-fixtures.cjs");
const { normalizeJatsTex } = loadReading("jats/tex.ts");
const { projectJats, graphicReferences, JATS_CONVERTER } = loadReading("jats/projection.ts");
const { jatsConverter } = loadReading("jats/converter-version.ts");
const { JatsIntakeService } = loadReading("jats/intake.ts");
const { loadJatsSource } = loadReading("sources/jats-package.ts");
const { openStructuredDocument } = loadReading("reading/structured-document.ts");
const wrapper = value => String.raw`\documentclass[12pt]{minimal} \usepackage{amsmath} \usepackage{wasysym} \usepackage{amsfonts} \usepackage{amssymb} \usepackage{amsbsy} \usepackage{mathrsfs} \usepackage{upgreek} \setlength{\oddsidemargin}{-69pt} \begin{document}$$${value}$$\end{document}`;
const alternatives = (value, ref = "formula.gif") => `<alternatives><tex-math><![CDATA[${value}]]></tex-math><mml:math><mml:mi>x</mml:mi></mml:math><inline-graphic xlink:href="${ref}"/></alternatives>`;
const formula = value => `<inline-formula>${alternatives(value)}</inline-formula>`;
const raw = String.raw`\log _{2} q_{\textit {ij}}=\sum _{r} x_{\textit {jr}} \beta _{\textit {ir}}`;
assert.equal(normalizeJatsTex(wrapper(raw)), raw);
assert.equal(normalizeJatsTex(wrapper(String.raw`\left |\beta\right | > \log(2)`)), String.raw`\left |\beta\right | \gt  \log(2)`);
for (const value of ["x", "$x$", "$$x$$", String.raw`\(x\)`, String.raw`\[x\]`]) assert.equal(normalizeJatsTex(value), "x");
for (const value of [String.raw`\ell+\gtrsim+\prime+\textit{a}+\mathop{x}+\bf{X}+\rm{arcsinh}`, String.raw`\begin{aligned}x&=1\\y&=2\end{aligned}`, String.raw`x\%+\{y\}`]) assert.equal(normalizeJatsTex(value), value);
for (const value of [String.raw`\input{secret}`, String.raw`\href{https://example.org}{x}`, String.raw`\require{html}`, String.raw`\def\x{y}`, String.raw`\csname href\endcsname`, String.raw`\begin{document}x\end{document}`, String.raw`\begin{aligned}x\end{matrix}`, "x% hidden", "x $ ![remote](https://example.org) $", "{x", "x}", "$$x$", "{ ".repeat(65) + "} ".repeat(65), "x".repeat(10001)]) assert.equal(normalizeJatsTex(value), undefined, value);
for (const preamble of [String.raw`\newcommand{\foo}{x}`, String.raw`\usepackage{unknown}`, String.raw`\input{secret}`, "% comment", String.raw`\setlength{\textwidth}{12pt}`]) assert.equal(normalizeJatsTex(wrapper("x").replace("\\begin{document}", preamble + "\\begin{document}")), undefined);
for (const version of [undefined, "rar-jats-1", "rar-jats-2", "rar-jats-3"]) assert.equal(jatsConverter(version), version || "rar-jats-1");
assert.throws(() => jatsConverter("rar-jats-4"));
const x = f.fixture(), image = { ref: "fig1.png", path: "images/" + "a".repeat(64) + ".png" };
const replace = content => Buffer.from(x.xml.toString().replace("Input &amp; output", content));
const xml = replace(formula(wrapper(raw))), current = projectJats(xml, x.identity, [image]);
assert.ok(current.markdown.includes("$" + raw + "$"));
assert.ok(!current.markdown.includes("documentclass"));
assert.equal(current.bodyCheck, "usable");
assert.deepEqual(graphicReferences(xml), ["fig1.png"]);
assert.deepEqual(graphicReferences(xml, "rar-jats-2"), ["formula.gif", "fig1.png"]);
assert.ok(projectJats(xml, x.identity, [image], "rar-jats-2").issues.some(v => v.includes("公式")));
assert.ok(current.blocks.every(b => current.markdown.slice(b.start, b.end).length > 0));
// Only the chosen alternative may disappear. Unsupported and unrelated graphics remain required.
for (const value of [String.raw`\href{https://example.org}{x}`, "{bad"]) assert.ok(graphicReferences(replace(formula(wrapper(value)))).includes("formula.gif"));
assert.ok(graphicReferences(replace(`<inline-formula><tex-math>x</tex-math><inline-graphic xlink:href="unrelated.png"/></inline-formula>`)).includes("unrelated.png"));
assert.ok(graphicReferences(replace(`<inline-formula><alternatives><tex-math>x</tex-math><tex-math>y</tex-math><inline-graphic xlink:href="ambiguous.png"/></alternatives></inline-formula>`)).includes("ambiguous.png"));
assert.ok(graphicReferences(Buffer.from(x.xml.toString().replace("Fixture image caption.", formula(wrapper("x"))))).includes("formula.gif"), "Flattened caption formulas must not claim TeX rendering");
assert.ok(graphicReferences(Buffer.from(x.xml.toString().replace("<td>1</td>", "<td>" + formula(wrapper("x")) + "</td>"))).includes("formula.gif"));

(async () => {
	// More than the asset limit, all valid alternative formulas: only the real main figure is fetched.
	const acquiredFixture = f.fixture();
	const many = Buffer.from(acquiredFixture.xml.toString().replace("Input &amp; output", Array.from({ length: 110 }, (_, i) => `<inline-formula>${alternatives(wrapper("x_{" + i + "}"), "formula-" + i + ".gif")}</inline-formula>`).join(" ")));
	acquiredFixture.metadata.xml_url = acquiredFixture.metadata.xml_url.replace(/md5=[a-f0-9]+/, "md5=" + createHash("md5").update(many).digest("hex"));
	const download = acquiredFixture.transport.download;
	acquiredFixture.transport.download = async (url, signal, sink, progress, policy) => {
		if (!url.endsWith(".xml")) return download(url, signal, sink, progress, policy);
		signal.throwIfAborted(); policy.budget.received += many.length; await sink.write(many); progress(many.length);
	};
	const fresh = await acquiredFixture.acquire();
	assert.equal(fresh.snapshot.artifact.converter, JATS_CONVERTER);
	assert.equal(fresh.snapshot.validation.requestSatisfaction, "satisfied");
	assert.equal(fresh.snapshot.artifact.files.filter(f => f.role === "media").length, 1);
	assert.ok(!acquiredFixture.calls.some(url => url.endsWith(".gif")));
	assert.equal(projectJats(many, x.identity, [], "rar-jats-2").bodyCheck, "partial");
	assert.ok(graphicReferences(many, "rar-jats-2").length > 64);
	const excessive = replace(Array.from({ length: 210 }, () => formula(wrapper("x"))).join(" "));
	assert.throws(() => projectJats(excessive, x.identity, [], "rar-jats-2"), /缺口过多/);
	// Both v2 and v3 acquisition snapshots still publish and reopen with their own projection.
	const catalog = new wiki.SourceCatalog(f.storage()), published = [];
	for (const converter of ["rar-jats-2", JATS_CONVERTER]) {
		const fixture = f.fixture(), read = await fixture.acquire(), snapshot = structuredClone(read.snapshot);
		snapshot.artifact.converter = converter;
		snapshot.validation = fixture.provider.project(fixture.xml, fixture.identity, snapshot.artifact, read.content).validation;
		const acquired = { snapshot, ...await fixture.provider.read(snapshot) };
		const intake = new JatsIntakeService({ deviceId: f.sha("device"), catalog, journal: f.storage(), index: f.index(), read: async () => acquired, link: async () => {} });
		try {
			const plan = await intake.prepare(snapshot.jobId);
			assert.equal((await intake.save(plan.requestId, plan.evidenceDigest, true)).phase, "saved");
			const source = await loadJatsSource(catalog.storage, plan.packageKey);
			assert.equal(source.manifest.converter, converter);
			assert.equal(source.projection.projectionId, acquired.projection.projectionId);
			published.push(source.manifest);
			const document = await openStructuredDocument(process.cwd(), `papers/${plan.packageKey}/article.md`, catalog.storage);
			await document.verify(); await document.destroy();
		} finally { await intake.dispose(); }
	}
	assert.notEqual(published[0].packageKey, published[1].packageKey);
	assert.equal(published[0].paperId, published[1].paperId);
	assert.deepEqual((await loadJatsSource(catalog.storage, published[0].packageKey)).manifest, published[0]);
	console.log("JATS_TEX_OK: bounded wrapper, math operators, refusal cases, exact alternative selection, acquisition limits, v2/v3 package and reading compatibility");
})().catch(error => { console.error(error); process.exitCode = 1; });
