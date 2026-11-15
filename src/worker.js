/**
 * The worker: a time trigger runs runQueue every 5 minutes and works through queued jobs one at a time.
 * Long uploads stop before Apps Script's time limit and carry on in the next run.
 */

function runQueue() {
  return runQueue_();
}

function runQueue_() {
  const p = props_();
  // Only one worker at a time. A crashed worker's claim runs out after 7 minutes.
  const claimed = withLock_(() => {
    if (Number(p.getProperty('WORKER_UNTIL') || 0) > Date.now()) return false;
    p.setProperty('WORKER_UNTIL', String(Date.now() + 7 * 60 * 1000));
    return true;
  });
  if (!claimed) return { ran: [], note: 'Another worker run is busy' };
  const started = Date.now();
  const ran = [];
  try {
    do {
      const job = pickNextJob_(allJobs_(), new Date());
      if (!job) break;
      const paused = runJob_(job, started) === 'paused';
      ran.push(presentJob_(job));
      if (paused) break; // out of time mid-upload; the next run carries on
    } while (Date.now() - started < WORK_BUDGET_MS);
  } finally {
    p.deleteProperty('WORKER_UNTIL');
  }
  return { ran };
}

function runJob_(job, started) {
  const adapter = adapterFor_(job.platform);
  const steps = adapter.steps(job.post);
  job.status = 'running';
  job.notBefore = null;
  const warnings = (job.result && job.result.warnings) || [];
  const ctx = {
    outOfTime: () => Date.now() - started > WORK_BUDGET_MS,
    save: () => saveJob_(job),
    warn: (msg) => { if (!warnings.includes(msg)) warnings.push(msg); },
    result: (r) => { job.result = Object.assign({}, r, { warnings }); },
    /** For extras (thumbnail, captions, playlists): a failure that a retry can't fix becomes a warning, not a failed job. */
    optional: (what, fn) => {
      try { fn(); } catch (err) {
        if (err && err.details && err.details.retry) throw err;
        ctx.warn(`${what}: ${err && err.message ? err.message : err}`);
      }
    },
  };
  saveJob_(job);
  try {
    for (let i = job.state.stepIndex || 0; i < steps.length; i++) {
      job.state.step = steps[i];
      if (adapter.run(steps[i], job, ctx) === 'pause') {
        job.status = 'queued';
        saveJob_(job);
        return 'paused';
      }
      job.state.stepIndex = i + 1;
      saveJob_(job);
    }
    job.status = 'done';
    job.error = null;
    if (!job.result) job.result = { warnings };
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
    Object.assign(job, afterError_(job, err, new Date()));
  }
  saveJob_(job);
}
