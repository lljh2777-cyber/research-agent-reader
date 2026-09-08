import type { CurationContext } from "../curation/types";
const string = { type: "string" };
const strings = { type: "array", items: string };
export const schemaObject = <T extends Record<string, unknown>>(properties: T) => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
export const READING_MEMORY_SCHEMA = schemaObject({ summary: string });
export const READING_SELECTION_SCHEMA = schemaObject({ ids: strings, query: string, needsVisual: { type: "boolean" }, vaultQuery: { type: ["string", "null"] } });
export const readingAnswerSchema = (main: boolean) => schemaObject({ title: string, content: string, evidenceIds: strings,
	...(main ? { outline: strings, mainSummary: string, completed: { type: "boolean" } } : {}) });
export const CURATION_SCHEMA = schemaObject({ suggestions: { type: "array", items: schemaObject({
	kind: { type: "string", enum: ["add", "replace", "covered", "condition", "conflict", "insufficient"] }, paragraphId: string, claim: string, text: string, reason: string,
	citations: { type: "array", items: { anyOf: [schemaObject({ id: string, quoteId: string }), schemaObject({ id: string, quote: string })] } },
	comparison: { anyOf: [schemaObject({ targetQuote: string, evidenceId: string }), { type: "null" }] },
}) } });

/** Bind each quote to its actual evidence owner; a free string schema still permits invented IDs. */
export function curationAnswerSchema(context: { evidence: CurationContext["evidence"]; target: Pick<CurationContext["target"], "paragraphs"> }) {
	const suggestion = CURATION_SCHEMA.properties.suggestions.items.properties;
	const choices = context.evidence.map(e => schemaObject({ id: { type: "string", enum: [e.id] },
		...(e.quotes?.length ? { quoteId: { type: "string", enum: e.quotes.map(q => q.id) } } : { quote: string }) }));
	return schemaObject({ suggestions: { type: "array", items: schemaObject({ ...suggestion,
		paragraphId: { type: "string", enum: context.target.paragraphs.map(p => p.id) },
		citations: { type: "array", items: { anyOf: choices.length ? choices : suggestion.citations.items.anyOf } },
	}) } });
}
