const MIB = 1024 * 1024;

/** Shared publish/load/render budgets for an untrusted MinerU package. */
export const MINERU_RESOURCE_LIMITS = {
	articleBytes: 16 * MIB,
	mineruJsonBytes: 32 * MIB,
	contractBytes: 8 * MIB,
	manifestBytes: 2 * MIB,
	validationBytes: 1 * MIB,
	pdfBytes: 64 * MIB,
	outputAssetBytes: 32 * MIB,
	manifestRecords: 8_192,
	packageTotalBytes: 128 * MIB,
	imageCount: 1_024,
	imageTotalBytes: 48 * MIB,
	imagePixels: 16_000_000,
	imageTotalPixels: 64_000_000,
	jsonDepth: 64,
	jsonStringChars: 1_000_000,
	pdfPages: 2_048,
	canvasDimension: 16_384,
	canvasPixels: 8_000_000,
	activeCanvasPixels: 16_000_000,
	pageAspectRatio: 20,
} as const;

/**
 * Linear pre-parse scan. It rejects pathological nesting and string sizes
 * before JSON.parse creates an unbounded object graph.
 */
export function assertJsonTextComplexity(value: string, label: string): void {
	let depth = 0;
	let inString = false;
	let escaped = false;
	let stringChars = 0;
	for (let index = 0; index < value.length; index += 1) {
		const char = value[index];
		if (inString) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (char === "\\") {
				escaped = true;
				continue;
			}
			if (char === '"') {
				inString = false;
				stringChars = 0;
				continue;
			}
			stringChars += 1;
			if (stringChars > MINERU_RESOURCE_LIMITS.jsonStringChars) {
				throw new Error(`${label} 含超长字符串`);
			}
			continue;
		}
		if (char === '"') {
			inString = true;
			continue;
		}
		if (char === "{" || char === "[") {
			depth += 1;
			if (depth > MINERU_RESOURCE_LIMITS.jsonDepth) {
				throw new Error(`${label} 嵌套深度超过 ${MINERU_RESOURCE_LIMITS.jsonDepth}`);
			}
		} else if (char === "}" || char === "]") {
			depth -= 1;
			if (depth < 0) throw new Error(`${label} 结构不平衡`);
		}
	}
	if (inString || depth !== 0) throw new Error(`${label} 结构不完整`);
}

export function parseBoundedJson(value: string, label: string): unknown {
	assertJsonTextComplexity(value, label);
	try {
		return JSON.parse(value);
	} catch (error) {
		throw new Error(`${label} 不是有效 JSON：${error instanceof Error ? error.message : String(error)}`);
	}
}
