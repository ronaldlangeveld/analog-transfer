import { runTests } from './js/tests.js';

const { failed } = await runTests(console.log);
process.exit(failed > 0 ? 1 : 0);
