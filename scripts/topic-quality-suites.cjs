"use strict";
// Pure suite metadata, also read inside Obsidian; never loads a compiler or a model.
const suites = Object.freeze({
 'topic-t1-v1': Object.freeze({ prompt: 'topic-teaching-v1', samples: 2, questions: 9 }),
 'topic-t1-v2': Object.freeze({ prompt: 'topic-teaching-v2', samples: 2, questions: 9 }),
 'topic-t1-transfer-v1': Object.freeze({ prompt: 'topic-teaching-v2', samples: 2, questions: 8 })
});
module.exports = suites;
