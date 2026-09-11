"use strict";
// Build a frozen, development-only runtime outside the repository. No providers or secrets.
const fs = require('node:fs'), path = require('node:path'), esbuild = require('esbuild');
const io = require('./reading-quality-io.cjs');
const baseline = require('./topic-quality-baseline.cjs');
function prepareRun(output) {
 const spec = require('../tests/fixtures/topic-quality/t1-v1.json');
 const frozen = require('../tests/fixtures/topic-quality/t1-v1-observation.json');
 const result = baseline.prepare(spec);
 if (JSON.stringify(result.observation) !== JSON.stringify(frozen)) throw Error('Frozen teaching baseline changed');
 const built = esbuild.buildSync({ stdin: { contents: [
  'export { FileSourceStorage } from "./src/sources/storage";',
  'export { TopicSessionStore } from "./src/topic-learning/store";',
  'export { TopicLearningService } from "./src/topic-learning/service";',
  'export { TopicStudyStore } from "./src/topic-learning/study-store";',
  'export { TopicStudyService } from "./src/topic-learning/study-service";',
  'export { nextTopicNode, topicQuestion, projectStudy, STUDY_PROMPT_VERSION } from "./src/topic-learning/study";',
  'export { topicTeachingRequest, TOPIC_TEACHING_RULES, parseTopicTeaching } from "./src/topic-learning/teaching";',
  'export { supportsReadingSchema } from "./src/providers/structured";'
 ].join('\n'), resolveDir: io.ROOT, sourcefile: 'topic-quality-entry.js' }, absWorkingDir: io.ROOT, bundle: true, write: false, platform: 'node', format: 'cjs', metafile: true, logLevel: 'silent' });
 const runtime = built.outputFiles[0].contents;
 const sources = Object.keys(built.metafile.inputs).filter(f => f !== 'topic-quality-entry.js').sort().map(file => ({ file, sha256: io.sha(fs.readFileSync(path.join(io.ROOT, file))) }));
 const directory = io.privateTarget(output);
 fs.mkdirSync(directory);
 io.save(directory, 'runtime.cjs', runtime, true);
 io.save(directory, 'inputs.json', result.inputs);
 io.save(directory, 'specification.json', spec);
 io.save(directory, 'review.md', result.review, true);
 const manifest = { protocol: 'topic-quality-run-1', ...frozen, runtimeHash: io.sha(runtime), sources,
  pluginVersion: require('../manifest.json').version, pluginHash: io.sha(fs.readFileSync(path.join(io.ROOT, 'main.js'))),
  runnerHash: io.sha(fs.readFileSync(path.join(__dirname, 'topic-quality-runner.cjs'))) };
 const planHash = io.sha(JSON.stringify(manifest));
 io.save(directory, 'plan.json', { ...manifest, planHash });
 return { directory, planHash, questions: frozen.questionCount };
}
module.exports = { prepareRun };
if (require.main === module) {
 try { if (!path.isAbsolute(process.argv[2] || '')) throw Error('Usage: node scripts/prepare-topic-quality-run.cjs <new absolute directory>'); console.log(JSON.stringify(prepareRun(process.argv[2]))); }
 catch (e) { console.error(String(e)); process.exitCode = 1; }
}
