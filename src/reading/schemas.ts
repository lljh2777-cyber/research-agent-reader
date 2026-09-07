const string = { type: "string" };
const strings = { type: "array", items: string };
export const schemaObject = (properties: Record<string, unknown>) => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
export const READING_MEMORY_SCHEMA = schemaObject({ summary: string });
export const READING_SELECTION_SCHEMA = schemaObject({ ids: strings, query: string, needsVisual: { type: "boolean" }, vaultQuery: { type: ["string", "null"] } });
export const readingAnswerSchema = (main: boolean) => schemaObject({ title: string, content: string, evidenceIds: strings,
	...(main ? { outline: strings, mainSummary: string, completed: { type: "boolean" } } : {}) });
export const CURATION_SCHEMA = schemaObject({ suggestions: { type: "array", items: schemaObject({
	kind: { type: "string", enum: ["add", "replace", "covered", "condition", "conflict", "insufficient"] }, paragraphId: string, claim: string, text: string, reason: string,
	citations: { type: "array", items: { anyOf: [schemaObject({ id: string, quoteId: string }), schemaObject({ id: string, quote: string })] } },
	comparison: { anyOf: [schemaObject({ targetQuote: string, evidenceId: string }), { type: "null" }] },
}) } });
