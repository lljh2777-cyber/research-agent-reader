export const TOPIC_EXPORT_ROOT = "wiki/qa/topic-learning";
export const isTopicExportPath = (path: string): boolean => path.replace(/\\/g, "/").toLowerCase().startsWith(TOPIC_EXPORT_ROOT + "/");
