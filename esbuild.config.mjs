import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

const buildOptions = {
	entryPoints: ["src/main.ts"],
	bundle: true,
	external: ["obsidian", "electron"],
	format: "cjs",
	platform: "node",
	target: "es2020",
	charset: "utf8",
	logLevel: "info",
	minify: !watch,
	sourcemap: watch ? "inline" : false,
	treeShaking: true,
	outfile: "main.js",
	banner: {
		js: "/* This file is generated from src/. Run `pnpm build`; do not edit main.js directly. */",
	},
	footer: {
		js: "module.exports = module.exports.default;",
	},
};

if (watch) {
	const context = await esbuild.context(buildOptions);
	await context.watch();
	console.log("Watching Agent Dashboard TypeScript sources...");
} else {
	await esbuild.build(buildOptions);
}
