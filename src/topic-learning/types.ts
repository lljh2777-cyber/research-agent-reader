/** Topic sessions have no document identity. ReadingSession keeps its existing evidence contract. */
export interface TopicIntent {
	topic: string;
	goal: string;
	background: string;
}
export interface TopicModule {
	id: string;
	title: string;
	question: string;
	objective: string;
	prerequisites: string[];
}
export interface TopicPlan { version: 1; modules: TopicModule[]; }
export type TopicPlanOrigin = { kind: "user" } | { kind: "model-knowledge"; provider: string; model: string };
export interface TopicSession {
	version: 1;
	kind: "topic-learning";
	id: string;
	intent: TopicIntent;
	evidencePolicy: "general-knowledge";
	createdAt: string;
	updatedAt: string;
	plan?: TopicPlan;
	planOrigin?: TopicPlanOrigin;
	confirmation?: { planDigest: string; confirmedAt: string };
}
