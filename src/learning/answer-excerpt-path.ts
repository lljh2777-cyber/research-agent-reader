export const ANSWER_EXCERPT_ROOT = "wiki/qa/answer-excerpts";
export const isAnswerExcerptPath = (path: string): boolean => path.replace(/\\/g, "/").toLowerCase().startsWith(ANSWER_EXCERPT_ROOT + "/");
export const validAnswerExcerptPath = (path: string): boolean => /^wiki\/qa\/answer-excerpts\/answer-[a-f0-9]{48}\.md$/.test(path);
