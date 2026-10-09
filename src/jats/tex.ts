import { children, xmlText, type XmlNode } from "./xml";

// Math only: never execute a document preamble, macros, links or package loading.
const commands = new Set("frac dfrac tfrac sqrt sum prod int iint iiint lim log ln exp sin cos tan cot sec csc arcsin arccos arctan sinh cosh tanh min max inf sup det dim gcd mod bmod pmod alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa lambda mu nu xi pi varpi rho varrho sigma varsigma tau upsilon phi varphi chi psi omega Gamma Delta Theta Lambda Xi Pi Sigma Upsilon Phi Psi Omega times cdot div pm mp le leq ge geq ne neq approx sim simeq equiv propto in notin subset subseteq supset supseteq cup cap setminus forall exists partial nabla infty lto to mapsto rightarrow leftarrow Rightarrow Leftarrow leftrightarrow Leftrightarrow ldots cdots vdots ddots left right big Big bigg Bigg lvert rvert langle rangle lbrace rbrace vert Vert overline underline hat widehat bar vec dot ddot tilde widetilde text textit mathrm mathbf mathit mathsf mathtt mathcal mathbb boldsymbol operatorname mathop overbrace underbrace overset underset begin end quad qquad thinspace enspace displaystyle textstyle scriptstyle scriptscriptstyle limits nolimits hline cr backslash percent lt gt ell gtrsim prime bf rm".split(" "));
const environments = new Set("aligned alignedat gathered split matrix pmatrix bmatrix Bmatrix vmatrix Vmatrix cases smallmatrix".split(" "));
const packages = new Set("amsmath wasysym amsfonts amssymb amsbsy mathrsfs upgreek".split(" "));

/** Recognize the bounded publisher wrapper; any unknown preamble remains unsupported. */
function unwrapDocument(original: string): string | undefined {
	if (!original.startsWith("\\documentclass")) return original;
	const document = /^\\documentclass\s*(?:\[(?:10|11|12)pt\])?\s*\{minimal\}\s*([\s\S]*?)\\begin\s*\{document\}([\s\S]*?)\\end\s*\{document\}\s*$/.exec(original);
	if (!document) return;
	let preamble = document[1].trim(), declarations = 0;
	while (preamble) {
		if (++declarations > 16) return;
		const use = /^\\usepackage\s*\{([a-z]+)\}\s*/.exec(preamble);
		if (use && packages.has(use[1])) { preamble = preamble.slice(use[0].length); continue; }
		const layout = /^\\setlength\s*\{\\oddsidemargin\}\s*\{[-+]?\d{1,3}(?:\.\d{1,3})?pt\}\s*/.exec(preamble);
		if (layout) { preamble = preamble.slice(layout[0].length); continue; }
		return;
	}
	return document[2].trim();
}

export function normalizeJatsTex(original: string): string | undefined {
	if (!original || original.length > 10000) return;
	let value = unwrapDocument(original.trim());
	if (value === undefined) return;
	// Require paired delimiters. Internal dollars and comments cannot escape math mode.
	if (value.startsWith("$$") && value.endsWith("$$") && value.length > 4) value = value.slice(2, -2).trim();
	else if (value.startsWith("$") && value.endsWith("$") && value.length > 2) value = value.slice(1, -1).trim();
	else if (value.startsWith("\\(") && value.endsWith("\\)")) value = value.slice(2, -2).trim();
	else if (value.startsWith("\\[") && value.endsWith("\\]")) value = value.slice(2, -2).trim();
	if (!value || /[`$\x00-\x1f]/.test(value) || /\\[<>]/.test(value)) return;
	// Preserve comparison operators without putting HTML delimiters into Markdown.
	value = value.replace(/</g, "\\lt ").replace(/>/g, "\\gt ");
	let depth = 0;
	const env: string[] = [];
	for (let i = 0; i < value.length; i++) {
		const c = value[i];
		if (c === "%") return;
		if (c === "{") { if (++depth > 64) return; }
		else if (c === "}") { if (--depth < 0) return; }
		else if (c === "\\") {
			const word = /^[A-Za-z]+/.exec(value.slice(i + 1))?.[0];
			if (!word) {
				if (!value[i + 1] || !"{} ,;:!%&#_\\|".includes(value[i + 1])) return;
				i++; continue;
			}
			if (!commands.has(word)) return;
			i += word.length;
			if (word === "begin" || word === "end") {
				const name = /^\s*\{([A-Za-z]+)\}/.exec(value.slice(i + 1));
				if (!name || !environments.has(name[1])) return;
				if (word === "begin") { if (env.length >= 64) return; env.push(name[1]); }
				else if (env.pop() !== name[1]) return;
			}
		}
	}
	return depth === 0 && env.length === 0 ? value : undefined;
}

/** Only images in this exact alternatives group can be replaced by the selected TeX. */
export function formulaTex(node: XmlNode): { value: string; alternatives?: XmlNode } | undefined {
	const direct = children(node, "tex-math"), alternatives = children(node, "alternatives");
	if (direct.length === 1 && alternatives.length === 0) {
		const value = normalizeJatsTex(xmlText(direct[0]));
		return value === undefined ? undefined : { value };
	}
	if (direct.length || alternatives.length !== 1) return;
	const tex = children(alternatives[0], "tex-math");
	if (tex.length !== 1) return;
	const value = normalizeJatsTex(xmlText(tex[0]));
	return value === undefined ? undefined : { value, alternatives: alternatives[0] };
}
