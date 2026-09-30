'use strict';
/**
 * A SUITE MUST ALWAYS PRODUCE A RESULT.
 *
 * B9.4.7 ran a suite whose https stub returned a request object that never
 * answered. The awaited promise stayed pending, node's event loop drained, and
 * the process exited **with no summary and exit code 0** — which reads as a pass
 * to anything watching exit codes, including a sabotage runner.
 *
 * That is the worst failure mode this programme has: not a wrong answer, but a
 * confident absence of one. This guard makes it impossible.
 *
 *   - a hard deadline; exceeding it is BLOCKED, never a pass
 *   - a beforeExit trap, so an event loop that simply runs dry is caught
 *   - the summary is printed on EVERY path, including the two above
 *   - the exit code always reflects the real outcome
 *
 * Usage:
 *   const guard = require('./lib/suite-guard.js');
 *   guard.run('B9.4.8', async () => { ... }, () => ({ pass, fail, unproven }));
 */

/**
 * @param {string}   name      suite name, for the BLOCKED line
 * @param {function} body      async suite body
 * @param {function} tally     returns { pass, fail, unproven } at any moment
 * @param {number}   timeoutMs hard deadline (default 120s)
 */
function run(name, body, tally, timeoutMs) {
  const LIMIT = timeoutMs || 120000;
  let finished = false;

  const summarise = (why) => {
    const t = tally() || {};
    const p = t.pass || 0, f = t.fail || 0, u = t.unproven || 0;
    if (why) console.log(`\n  BLOCKED  ${name} — ${why}`);
    console.log(`\n${p} passed, ${f} failed, ${u} unproven${why ? ', 1 blocked' : ''}`);
    return why ? 2 : (f ? 1 : 0);
  };

  const timer = setTimeout(() => {
    if (finished) return;
    finished = true;
    /* A hang is BLOCKED, not a failure and certainly not a pass: we do not know
       what the code would have done, only that it never said. */
    process.exit(summarise(`no result within ${LIMIT} ms — a hung suite proves nothing`));
  }, LIMIT);
  timer.unref();

  /* If every handle drains without the body resolving, node exits silently at
     code 0. That is precisely the B9.4.7 defect, and it never reaches the
     timeout above, so it needs its own trap. */
  process.on('beforeExit', () => {
    if (finished) return;
    finished = true;
    process.exit(summarise('the event loop drained before the suite finished — '
      + 'an unanswered stub leaves a promise pending forever'));
  });

  return Promise.resolve()
    .then(body)
    .then(() => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      process.exit(summarise(null));
    })
    .catch((e) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      console.error(e && e.stack ? e.stack : e);
      process.exit(summarise('the suite threw'));
    });
}

module.exports = { run };
