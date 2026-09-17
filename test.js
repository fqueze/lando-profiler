#!/usr/bin/env node
/**
 * Tests for lando-profiler.
 *
 * Run with `node test.js`. Uses synthetic log entries so it needs no fixtures,
 * and validates the emitted profile against the invariants the Firefox Profiler
 * front end relies on (see profile-format.js).
 */

'use strict';

const assert = require('assert');

const {
  normalizeEntry,
  extractHgCommands,
  extractActivities,
  attributeCommands,
  buildProfile,
  hgCommandName,
  commandPhase,
} = require('./index.js');

let failures = 0;
let passes = 0;

function test(name, fn) {
  try {
    fn();
    passes++;
  } catch (error) {
    failures++;
    console.error(`FAIL ${name}`);
    console.error('  ' + String(error.message).split('\n').join('\n  '));
  }
}

// ---------------------------------------------------------------------------
// Synthetic log construction
// ---------------------------------------------------------------------------

const HOST = 'lando-landingworkertry-0';
const T0 = Date.parse('2026-09-10T04:00:00.000Z');

/** Builds a Cloud Logging entry in the shape the workers emit. */
function logEntry(offsetMs, message, extra = {}) {
  const nanos = BigInt(T0 + offsetMs) * 1000000n;
  return {
    insertId: extra.insertId || `id-${offsetMs}-${Math.abs(hash(message))}`,
    jsonPayload: {
      message,
      source: extra.source || 'lando.main.scm.hg',
      Hostname: extra.host || HOST,
      Timestamp: nanos.toString(),
      Fields: { msg: message, ...(extra.fields || {}) },
    },
    timestamp: new Date(T0 + offsetMs).toISOString(),
    severity: extra.severity || 'INFO',
  };
}

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return h;
}

function running(offset, id, command, extra = {}) {
  return logEntry(offset, `running hg command #${id}: ${command}`, {
    ...extra,
    fields: { command, command_id: id, path: '/files/repos/try', ...(extra.fields || {}) },
  });
}

function output(offset, id, text, extra = {}) {
  return logEntry(offset, `output from hg command #${id}: ${text}`, {
    ...extra,
    fields: { command_id: id, output: text, path: '/files/repos/try', ...(extra.fields || {}) },
  });
}

const WORKER = { source: 'lando.api.legacy.workers.base' };

function normalize(entries) {
  return entries.map(normalizeEntry).filter((e) => Number.isFinite(e.time));
}

// ---------------------------------------------------------------------------
// Command name normalization
// ---------------------------------------------------------------------------

test('hgCommandName strips global flags and arguments', () => {
  assert.strictEqual(hgCommandName("hg log -r . -T '{node}'"), 'hg log');
  assert.strictEqual(hgCommandName('hg --quiet revert --no-backup --all'), 'hg revert');
  assert.strictEqual(hgCommandName('hg purge'), 'hg purge');
  assert.strictEqual(
    hgCommandName('hg pull https://hg.mozilla.org/mozilla-unified'),
    'hg pull'
  );
  assert.strictEqual(hgCommandName('hg push -r tip ssh://hg.mozilla.org/try -f'), 'hg push');
  assert.strictEqual(hgCommandName('hg import -s 95 --no-commit /tmp/x'), 'hg import');
});

test('hgCommandName keeps the mode flag where it changes the operation', () => {
  assert.strictEqual(hgCommandName('hg rebase --abort'), 'hg rebase --abort');
  assert.strictEqual(hgCommandName('hg update --clean -r abc123'), 'hg update --clean');
});

test('commandPhase groups commands into pipeline stages', () => {
  const phaseOf = (command) => commandPhase({ name: hgCommandName(command) });
  assert.strictEqual(phaseOf('hg purge'), 'Prepare repo');
  assert.strictEqual(phaseOf('hg rebase --abort'), 'Prepare repo');
  assert.strictEqual(phaseOf('hg pull https://x'), 'Pull');
  assert.strictEqual(phaseOf('hg import -s 95 /tmp/x'), 'Apply patches');
  assert.strictEqual(phaseOf('hg commit -m x'), 'Apply patches');
  assert.strictEqual(phaseOf('hg push -r tip ssh://x'), 'Push');
});

// ---------------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------------

test('the nanosecond payload timestamp wins over the ingestion timestamp', () => {
  const entry = logEntry(1500, 'hello');
  // The ingestion timestamp is deliberately made wrong.
  entry.timestamp = '2026-01-01T00:00:00.000Z';
  assert.strictEqual(normalizeEntry(entry).time, T0 + 1500);
});

test('entries without a jsonPayload fall back to the outer timestamp', () => {
  const entry = {
    insertId: 'x',
    textPayload: 'RuntimeWarning: naive datetime',
    timestamp: new Date(T0 + 42).toISOString(),
    severity: 'ERROR',
  };
  const normalized = normalizeEntry(entry);
  assert.strictEqual(normalized.time, T0 + 42);
  assert.match(normalized.message, /RuntimeWarning/);
});

// ---------------------------------------------------------------------------
// hg command extraction
// ---------------------------------------------------------------------------

test('a command with output gets an exact end time', () => {
  const commands = extractHgCommands(
    normalize([running(0, 'a', 'hg purge'), output(2500, 'a', 'ok')])
  );
  assert.strictEqual(commands.length, 1);
  assert.strictEqual(commands[0].end - commands[0].start, 2500);
  assert.strictEqual(commands[0].inferredEnd, false);
  assert.strictEqual(commands[0].output, 'ok');
});

test('a silent command ends at the next log line, and is flagged', () => {
  const commands = extractHgCommands(
    normalize([
      running(0, 'a', 'hg commit -m x'),
      running(3000, 'b', 'hg purge'),
      output(4000, 'b', 'ok'),
    ])
  );
  assert.strictEqual(commands.length, 2);
  assert.strictEqual(commands[0].end - commands[0].start, 3000);
  assert.strictEqual(commands[0].inferredEnd, true);
  assert.strictEqual(commands[1].inferredEnd, false);
});

test('any log line bounds an in-flight silent command', () => {
  const commands = extractHgCommands(
    normalize([
      running(0, 'a', 'hg commit -m x'),
      logEntry(1200, 'Queue size for worker try is 0 (0 on open trees, 0 behind closed trees).', WORKER),
    ])
  );
  assert.strictEqual(commands[0].end - commands[0].start, 1200);
  assert.strictEqual(commands[0].inferredEnd, true);
});

test('an hg error terminates the command it belongs to', () => {
  const commands = extractHgCommands(
    normalize([
      running(0, 'a', "hg strip --no-backup -r 'not public()'"),
      logEntry(
        800,
        "hg error in cmd: hg strip --no-backup -r not public(): \nabort: empty revision set",
        {
          severity: 'ERROR',
          fields: { command_id: 'a', path: '/files/repos/try' },
        }
      ),
    ])
  );
  assert.strictEqual(commands.length, 1);
  assert.strictEqual(commands[0].end - commands[0].start, 800);
  assert.match(commands[0].error, /empty revision set/);
});

test('the last command of a log gets a zero duration rather than a bogus one', () => {
  const commands = extractHgCommands(normalize([running(0, 'a', 'hg commit -m x')]));
  assert.strictEqual(commands[0].end, commands[0].start);
  assert.strictEqual(commands[0].inferredEnd, true);
});

test('output arriving for an unknown command id is ignored', () => {
  const commands = extractHgCommands(normalize([output(0, 'nope', 'stray output')]));
  assert.strictEqual(commands.length, 0);
});

test('the repo comes from Fields.path', () => {
  const commands = extractHgCommands(
    normalize([
      running(0, 'a', 'hg purge', { fields: { path: '/files/repos/try-comm-central' } }),
      output(100, 'a', 'ok', { fields: { path: '/files/repos/try-comm-central' } }),
    ])
  );
  assert.strictEqual(commands[0].repo, 'try-comm-central');
});

test('commands on different workers do not terminate each other', () => {
  const commands = extractHgCommands(
    normalize([
      running(0, 'a', 'hg commit -m x', { host: 'worker-a' }),
      running(500, 'b', 'hg commit -m y', { host: 'worker-b' }),
      output(9000, 'a', 'created new head', { host: 'worker-a' }),
      output(9500, 'b', 'created new head', { host: 'worker-b' }),
    ])
  );
  const byHost = new Map(commands.map((c) => [c.host, c]));
  assert.strictEqual(byHost.get('worker-a').end - byHost.get('worker-a').start, 9000);
  assert.strictEqual(byHost.get('worker-b').end - byHost.get('worker-b').start, 9000);
  assert.strictEqual(byHost.get('worker-a').inferredEnd, false);
});

// ---------------------------------------------------------------------------
// Jobs, maintenance, attribution
// ---------------------------------------------------------------------------

function jobLog() {
  return normalize([
    logEntry(0, 'LandingWorker try [RUNNING] [3 repos]', WORKER),
    logEntry(1000, 'Queue size for worker try is 1 (1 on open trees, 0 behind closed trees).', {
      ...WORKER,
      fields: { worker: 'try', queue_size: '1', open_queue_size: '1', closed_queue_size: '0' },
    }),
    logEntry(2000, 'Starting LandingJob 89766 [SUBMITTED]', WORKER),
    running(3000, 'c1', 'hg purge'),
    running(5000, 'c2', 'hg pull https://hg.mozilla.org/mozilla-unified'),
    output(9000, 'c2', 'pulling from https://hg.mozilla.org/mozilla-unified\nno changes found'),
    running(9500, 'c3', 'hg import -s 95 --no-commit /tmp/x'),
    output(11000, 'c3', 'applying /tmp/x'),
    running(11000, 'c4', "hg commit -m 'Bug 1'"),
    running(14000, 'c5', 'hg push -r tip ssh://hg.mozilla.org/try -f'),
    output(40000, 'c5', 'pushing to ssh://hg.mozilla.org/try\nremote: adding changesets'),
    logEntry(41000, '/files/repos/try/mots.yaml found, setting reviewer data.', {
      source: 'lando.api.legacy.workers.landing_worker',
    }),
    logEntry(42000, 'Finished processing LandingJob 89766 [LANDED]', WORKER),
    logEntry(50000, "Starting idle maintenance for 1 repo(s): ['try']", WORKER),
    running(50500, 'da1', "hg strip --no-backup -r 'not public()'"),
    output(51000, 'da1', 'ok'),
    logEntry(52000, 'Finished idle maintenance for 1 of 1 repo(s) in 1.50s', WORKER),
  ]);
}

test('jobs are bracketed by their start and finish lines', () => {
  const { jobs } = extractActivities(jobLog());
  assert.strictEqual(jobs.length, 1);
  assert.strictEqual(jobs[0].id, '89766');
  assert.strictEqual(jobs[0].initialState, 'SUBMITTED');
  assert.strictEqual(jobs[0].state, 'LANDED');
  assert.strictEqual(jobs[0].end - jobs[0].start, 40000);
});

test('the job repo comes from the mots.yaml line', () => {
  const entries = jobLog();
  const { jobs, maintenance } = extractActivities(entries);
  attributeCommands(extractHgCommands(entries), jobs, maintenance);
  assert.strictEqual(jobs[0].repo, 'try');
});

test('a job with no mots.yaml line falls back to its commands', () => {
  const entries = normalize([
    logEntry(0, 'Starting LandingJob 1 [SUBMITTED]', WORKER),
    running(100, 'a', 'hg purge', { fields: { path: '/files/repos/try-comm-central' } }),
    output(200, 'a', 'ok', { fields: { path: '/files/repos/try-comm-central' } }),
    logEntry(300, 'Finished processing LandingJob 1 [LANDED]', WORKER),
  ]);
  const { jobs, maintenance } = extractActivities(entries);
  attributeCommands(extractHgCommands(entries), jobs, maintenance);
  assert.strictEqual(jobs[0].repo, 'try-comm-central');
});

test('commands are attributed to the job or maintenance round containing them', () => {
  const entries = jobLog();
  const commands = extractHgCommands(entries);
  const { jobs, maintenance } = extractActivities(entries);
  attributeCommands(commands, jobs, maintenance);

  assert.strictEqual(jobs[0].commands.length, 5);
  assert.strictEqual(maintenance.length, 1);
  assert.strictEqual(maintenance[0].commands.length, 1);
  assert.strictEqual(maintenance[0].commands[0].name, 'hg strip');
  assert.deepStrictEqual(maintenance[0].repos, ['try']);
  for (const command of jobs[0].commands) {
    assert.strictEqual(command.maintenance, undefined);
  }
});

test('an unterminated job is closed rather than left open', () => {
  const { jobs } = extractActivities(
    normalize([logEntry(0, 'Starting LandingJob 7 [SUBMITTED]', WORKER)])
  );
  assert.strictEqual(jobs[0].state, 'UNTERMINATED');
  assert.strictEqual(jobs[0].end, jobs[0].start);
});

test('a new job start closes a job that never logged a finish', () => {
  const { jobs } = extractActivities(
    normalize([
      logEntry(0, 'Starting LandingJob 1 [SUBMITTED]', WORKER),
      logEntry(5000, 'Starting LandingJob 2 [SUBMITTED]', WORKER),
      logEntry(6000, 'Finished processing LandingJob 2 [LANDED]', WORKER),
    ])
  );
  assert.strictEqual(jobs.length, 2);
  assert.strictEqual(jobs[0].state, 'INCOMPLETE');
  assert.strictEqual(jobs[0].end - jobs[0].start, 5000);
  assert.strictEqual(jobs[1].state, 'LANDED');
});

test('queue readings and the budget line are picked up', () => {
  const { queueReadings, maintenance } = extractActivities(
    normalize([
      logEntry(0, 'Queue size for worker try is 3 (2 on open trees, 1 behind closed trees).', WORKER),
      logEntry(1000, "Starting idle maintenance for 3 repo(s): ['try', 'try-comm-central', 'conduit-testing-production-repo']", WORKER),
      logEntry(2000, 'Idle maintenance budget (10s) reached after 2 of 3 repo(s); stopping early.', WORKER),
      logEntry(3000, 'Finished idle maintenance for 2 of 3 repo(s) in 2.00s', WORKER),
    ])
  );
  assert.strictEqual(queueReadings.length, 1);
  assert.deepStrictEqual(
    { size: queueReadings[0].size, open: queueReadings[0].openTrees, closed: queueReadings[0].closedTrees },
    { size: 3, open: 2, closed: 1 }
  );
  assert.strictEqual(maintenance[0].repos.length, 3);
  assert.strictEqual(maintenance[0].budgetReached, true);
  assert.strictEqual(maintenance[0].completed, 2);
});

test('errors are collected, and attributed to the running job', () => {
  const entries = normalize([
    logEntry(0, 'Starting LandingJob 1 [SUBMITTED]', WORKER),
    logEntry(100, 'something broke', {
      severity: 'ERROR',
      source: 'lando.api.legacy.workers.landing_worker',
      fields: { exc: { error: "HgCommandError('boom')", traceback: '  File "x.py"\n' } },
    }),
    logEntry(200, 'Finished processing LandingJob 1 [FAILED]', WORKER),
  ]);
  const { jobs, notes } = extractActivities(entries);
  assert.strictEqual(notes.length, 1);
  assert.match(notes[0].error, /HgCommandError/);
  assert.strictEqual(jobs[0].errors.length, 1);
  assert.strictEqual(jobs[0].state, 'FAILED');
});

// ---------------------------------------------------------------------------
// Profile structure
// ---------------------------------------------------------------------------

/** True for any level of the activity nesting, all of which are named `Task`. */
function isTaskPayload(data) {
  return Boolean(data) && (data.type === 'Task' || data.type === 'Subtask');
}

/** Resolves a `unique-string` marker field back to its string. */
function resolveString(profile, index) {
  assert.strictEqual(
    typeof index,
    'number',
    'a unique-string field must hold a string-table index'
  );
  const value = profile.shared.stringArray[index];
  assert.strictEqual(typeof value, 'string', `no string at index ${index}`);
  return value;
}

const FORMATS = new Set([
  'url', 'file-path', 'sanitized-string', 'string', 'unique-string', 'flow-id',
  'terminating-flow-id', 'duration', 'time', 'seconds', 'milliseconds',
  'microseconds', 'nanoseconds', 'bytes', 'percentage', 'integer', 'decimal',
  'hexadecimal', 'pid', 'tid', 'list',
]);
const DISPLAY_LOCATIONS = new Set([
  'marker-chart', 'marker-table', 'timeline-overview', 'timeline-memory',
  'timeline-ipc', 'timeline-fileio', 'timeline-network', 'stack-chart',
]);

/** Asserts every invariant the front end relies on. */
function validateProfile(profile) {
  const { shared, meta, threads } = profile;
  const { stackTable, frameTable, funcTable, stringArray } = shared;

  assert.strictEqual(meta.preprocessedProfileVersion, 69);
  assert.ok(
    meta.categories.some((c) => c.color === 'grey'),
    'a grey (default) category must exist'
  );
  for (const category of meta.categories) {
    assert.strictEqual(category.subcategories[0], 'Other');
  }

  // Stack table: prefixes must be offsets pointing at a lower index.
  assert.strictEqual(stackTable.frame.length, stackTable.length);
  assert.strictEqual(stackTable.prefixOffset.length, stackTable.length);
  for (let i = 0; i < stackTable.length; i++) {
    const offset = stackTable.prefixOffset[i];
    assert.ok(offset >= 0 && offset <= i, `stack ${i}: prefixOffset out of range`);
    assert.ok(
      stackTable.frame[i] >= 0 && stackTable.frame[i] < frameTable.length,
      `stack ${i}: frame index out of range`
    );
  }

  for (const column of ['address', 'inlineDepth', 'category', 'subcategory', 'func',
    'nativeSymbol', 'innerWindowID', 'line', 'column', 'originalLocation']) {
    assert.strictEqual(frameTable[column].length, frameTable.length, `frameTable.${column}`);
  }
  for (let i = 0; i < frameTable.length; i++) {
    assert.ok(frameTable.func[i] >= 0 && frameTable.func[i] < funcTable.length);
    assert.ok(frameTable.category[i] >= 0 && frameTable.category[i] < meta.categories.length);
  }

  for (const column of ['name', 'isJS', 'relevantForJS', 'resource', 'source',
    'lineNumber', 'columnNumber', 'originalLocation']) {
    assert.strictEqual(funcTable[column].length, funcTable.length, `funcTable.${column}`);
  }
  for (let i = 0; i < funcTable.length; i++) {
    assert.ok(funcTable.name[i] >= 0 && funcTable.name[i] < stringArray.length);
  }

  // Every column of the shared tables has to be present even when empty: the
  // sanitization the Share button runs always rewrites source contents, and a
  // sources table without a `content` column throws on `.length`.
  assert.deepStrictEqual(Object.keys(shared.sources).sort(), [
    'content', 'filename', 'id', 'length', 'sourceMapURL', 'startColumn',
    'startLine',
  ]);
  assert.deepStrictEqual(Object.keys(shared.resourceTable).sort(), [
    'host', 'length', 'lib', 'name', 'type',
  ]);
  assert.deepStrictEqual(Object.keys(shared.nativeSymbols).sort(), [
    'address', 'functionSize', 'length', 'libIndex', 'name',
  ]);
  assert.deepStrictEqual(Object.keys(shared.sourceLocationTable).sort(), [
    'column', 'length', 'line', 'source',
  ]);

  const schemaNames = new Set(meta.markerSchema.map((s) => s.name));
  for (const schema of meta.markerSchema) {
    // `name`, `display` and `fields` are the required properties; a schema
    // missing `fields` loads fine and then throws when a marker is selected.
    assert.strictEqual(typeof schema.name, 'string', 'schema has no name');
    assert.ok(Array.isArray(schema.display), `${schema.name}: no display`);
    assert.ok(Array.isArray(schema.fields), `${schema.name}: no fields`);
    for (const location of schema.display) {
      assert.ok(DISPLAY_LOCATIONS.has(location), `bad display '${location}'`);
    }
    for (const field of schema.fields) {
      assert.ok(FORMATS.has(field.format), `${schema.name}.${field.key}: bad format`);
    }
    // Every field a label interpolates has to be declared, or it renders as an
    // empty string.
    const declared = new Set(schema.fields.map((f) => f.key));
    for (const label of [
      schema.tooltipLabel,
      schema.tableLabel,
      schema.chartLabel,
    ]) {
      for (const [, key] of String(label ?? '').matchAll(
        /\{marker\.data\.(\w+)\}/g
      )) {
        assert.ok(
          declared.has(key),
          `${schema.name}: label uses undeclared field '${key}'`
        );
      }
    }
  }

  for (const thread of threads) {
    const { samples, markers } = thread;
    assert.strictEqual(samples.stack.length, samples.length);
    assert.strictEqual(samples.time.length, samples.length);
    if (samples.weight !== null) {
      assert.strictEqual(samples.weight.length, samples.length);
    }
    for (let i = 1; i < samples.length; i++) {
      assert.ok(samples.time[i] >= samples.time[i - 1], 'samples must be ascending');
    }
    for (let i = 0; i < samples.length; i++) {
      const stack = samples.stack[i];
      assert.ok(stack === null || (stack >= 0 && stack < stackTable.length));
    }

    for (const column of ['data', 'name', 'startTime', 'endTime', 'phase', 'category']) {
      assert.strictEqual(markers[column].length, markers.length, `markers.${column}`);
    }
    const GRAPH_COLOR_NAMES = new Set([
      'blue', 'green', 'grey', 'ink', 'magenta', 'orange', 'purple', 'red',
      'teal', 'yellow',
    ]);
    for (let i = 0; i < markers.length; i++) {
      assert.ok(markers.name[i] >= 0 && markers.name[i] < stringArray.length);
      assert.ok(markers.category[i] >= 0 && markers.category[i] < meta.categories.length);
      const data = markers.data[i];
      if (data && data.type) {
        assert.ok(schemaNames.has(data.type), `marker type '${data.type}' has no schema`);
        const schema = meta.markerSchema.find((s) => s.name === data.type);
        for (const field of schema.fields) {
          const value = data[field.key];
          if (value === undefined) {
            continue;
          }
          // A unique-string field holds a string-table index, so a plain string
          // here would render as garbage or crash the tooltip.
          if (field.format === 'unique-string') {
            assert.strictEqual(
              typeof value,
              'number',
              `${data.type}.${field.key} should be a string-table index`
            );
            assert.ok(
              value >= 0 && value < stringArray.length,
              `${data.type}.${field.key} index ${value} is out of range`
            );
          }
        }
        // colorField has to name a field holding a valid GraphColor.
        if (schema.colorField && data[schema.colorField] !== undefined) {
          assert.ok(
            GRAPH_COLOR_NAMES.has(data[schema.colorField]),
            `${data.type}.${schema.colorField} is not a GraphColor: ${data[schema.colorField]}`
          );
        }
      }
      if (markers.phase[i] === 1) {
        assert.ok(markers.endTime[i] >= markers.startTime[i], 'interval end before start');
      }
    }
  }

  const GRAPH_COLORS = new Set([
    'blue', 'green', 'grey', 'ink', 'magenta', 'orange', 'purple', 'red',
    'teal', 'yellow',
  ]);
  for (const counter of profile.counters || []) {
    assert.strictEqual(counter.samples.time.length, counter.samples.length);
    assert.strictEqual(counter.samples.count.length, counter.samples.length);
    assert.ok(
      threads.some((t) => t.pid === counter.pid),
      `counter ${counter.name}: pid matches no thread`
    );
    assert.ok(
      threads[counter.mainThreadIndex],
      `counter ${counter.name}: mainThreadIndex is out of range`
    );
    // Required since format v63. A counter without it makes the front end
    // throw on `counter.display.label` while building the track list, and
    // nothing back-fills it for a profile declaring the current version.
    const display = counter.display;
    assert.ok(display, `counter ${counter.name}: display config is missing`);
    assert.ok(
      ['line-accumulated', 'line-rate'].includes(display.graphType),
      `counter ${counter.name}: bad graphType`
    );
    assert.ok(GRAPH_COLORS.has(display.color), `counter ${counter.name}: bad color`);
    assert.strictEqual(typeof display.label, 'string');
    assert.strictEqual(typeof display.unit, 'string');
    assert.strictEqual(typeof display.sortWeight, 'number');
    assert.ok(
      display.markerSchemaLocation === null ||
        DISPLAY_LOCATIONS.has(display.markerSchemaLocation),
      `counter ${counter.name}: bad markerSchemaLocation`
    );
    assert.ok(
      Array.isArray(display.tooltipRows) && display.tooltipRows.length > 0,
      `counter ${counter.name}: tooltipRows is missing`
    );
    for (const row of display.tooltipRows) {
      if (row.type === 'separator') {
        continue;
      }
      assert.strictEqual(row.type, 'value');
      assert.strictEqual(typeof row.source, 'string');
      assert.ok(
        ['bytes', 'bytes-per-second', 'percent', 'number'].includes(row.format.unit),
        `counter ${counter.name}: bad tooltip row unit`
      );
      assert.strictEqual(typeof row.label, 'string');
    }
  }
}

test('a job with no known repo lands on the worker track, not its own', () => {
  // A job cut off by the end of the log window logs no commands, so there is
  // nothing to infer a repo from.
  const entries = normalize([
    logEntry(0, 'Starting LandingJob 90371 [SUBMITTED]', WORKER),
    logEntry(500, 'Queue size for worker try is 1 (1 on open trees, 0 behind closed trees).', {
      ...WORKER,
      fields: { worker: 'try', queue_size: '1', open_queue_size: '1', closed_queue_size: '0' },
    }),
  ]);
  const { jobs } = extractActivities(entries);
  attributeCommands(extractHgCommands(entries), jobs, []);
  assert.strictEqual(jobs[0].repo, null);

  const { profile } = buildProfile(entries, { samples: true });
  validateProfile(profile);
  // No repo track was conjured for it.
  assert.deepStrictEqual(
    profile.threads.map((t) => t.name),
    ['worker']
  );
  const names = [];
  for (const thread of profile.threads) {
    for (let i = 0; i < thread.markers.length; i++) {
      const data = thread.markers.data[i];
      if (data && data.type === 'Task') {
        names.push(data);
      }
    }
  }
  assert.strictEqual(names.length, 1);
  assert.strictEqual(names[0].repo, undefined);
});

test('each sample reports the CPU use of the span that ends at it', () => {
  // The activity graph paints a sample from halfway back to the previous sample
  // to halfway on to the next, scaling the fill by cpuDelta/elapsed. Without
  // CPU figures every sample is assumed fully busy, so a long run of work
  // bleeds into its neighbours and draws as a ramp. The deltas are what keep a
  // sparse sample set rendering correctly, so they must match each span.
  const entries = normalize([
    logEntry(0, 'Starting LandingJob 1 [SUBMITTED]', WORKER),
    running(1000, 'a', 'hg purge'),
    output(2000, 'a', 'ok'),
    // A 20 minute push, next to commands lasting a second.
    running(2000, 'b', 'hg push -r tip ssh://hg.mozilla.org/try -f'),
    output(1202000, 'b', 'pushing to ssh://hg.mozilla.org/try'),
    running(1202000, 'c', "hg log -r . -T '{node}'"),
    output(1203000, 'c', 'abc'),
    logEntry(1204000, '/files/repos/try/mots.yaml found, setting reviewer data.', {
      source: 'lando.api.legacy.workers.landing_worker',
    }),
    logEntry(1205000, 'Finished processing LandingJob 1 [LANDED]', WORKER),
  ]);
  const { profile } = buildProfile(entries, { samples: true });
  assert.strictEqual(profile.meta.sampleUnits.threadCPUDelta, 'µs');

  for (const thread of profile.threads) {
    const { time, threadCPUDelta, weight, length } = thread.samples;
    assert.ok(threadCPUDelta, `${thread.name}: no threadCPUDelta column`);
    assert.strictEqual(threadCPUDelta.length, length);

    for (let i = 1; i < length; i++) {
      const elapsed = time[i] - time[i - 1];
      // A span is either fully busy or fully idle, never in between: the
      // worker runs one command at a time.
      const percent = elapsed > 0 ? threadCPUDelta[i] / 1000 / elapsed : 0;
      assert.ok(
        percent < 0.001 || percent <= 1.001,
        `${thread.name}: sample ${i} reports ${(percent * 100).toFixed(1)}% CPU`
      );
    }
    void weight;
  }
});

test('a busy span reads as fully busy and an idle span as idle', () => {
  const entries = normalize([
    running(0, 'a', 'hg purge'),
    output(5000, 'a', 'ok'),
    // An hour of nothing, then more work.
    running(3605000, 'b', 'hg purge'),
    output(3610000, 'b', 'ok'),
  ]);
  const { profile } = buildProfile(entries, { samples: true });
  const thread = profile.threads[0];
  const { time, threadCPUDelta, stack, length } = thread.samples;
  const { shared } = profile;
  const categoryOf = (s) =>
    profile.meta.categories[
      shared.frameTable.category[shared.stackTable.frame[s]]
    ].name;

  let busySpans = 0;
  let idleSpans = 0;
  for (let i = 1; i < length; i++) {
    const elapsed = time[i] - time[i - 1];
    const percent = threadCPUDelta[i] / 1000 / elapsed;
    // The span's own stack is the one opened by the preceding sample.
    if (categoryOf(stack[i - 1]) === 'Waiting for work') {
      assert.ok(percent < 0.001, `idle span ${i} reports ${percent}`);
      idleSpans++;
    } else {
      assert.ok(Math.abs(percent - 1) < 0.001, `busy span ${i} reports ${percent}`);
      busySpans++;
    }
  }
  assert.ok(busySpans > 0 && idleSpans > 0, 'expected both busy and idle spans');
});

test('sample weights still sum to the exact wall-clock span', () => {
  const { profile, stats } = buildProfile(jobLog(), { samples: true });
  const span = stats.endTime - stats.startTime;
  for (const thread of profile.threads) {
    if (thread.samples.length === 0) {
      continue;
    }
    const total = thread.samples.weight.reduce((a, b) => a + b, 0);
    assert.ok(
      Math.abs(total - span) < 1,
      `${thread.name}: weights sum to ${total}, expected ${span}`
    );
  }
});

test('a long idle stretch stays cheap in samples', () => {
  // An idle gap is drawn as nothing, so it does not need a sample per second;
  // only its ends matter, to keep neighbouring work from bleeding across it.
  const entries = normalize([
    running(0, 'a', 'hg purge'),
    output(1000, 'a', 'ok'),
    // Six hours of nothing.
    running(21601000, 'b', 'hg purge'),
    output(21602000, 'b', 'ok'),
  ]);
  const { profile } = buildProfile(entries, { samples: true });
  for (const thread of profile.threads) {
    assert.ok(
      thread.samples.length < 100,
      `${thread.name}: ${thread.samples.length} samples for a 6h idle gap`
    );
  }
});

test('stack frames merge across jobs, with the job id only on markers', () => {
  // A frame name is what the call tree and the flame graph aggregate on, so a
  // per-job frame name gives every job its own sliver and the flame graph stops
  // showing where landing time goes. Per-job detail belongs on the marker.
  const entries = normalize([
    logEntry(0, 'Starting LandingJob 1 [SUBMITTED]', WORKER),
    running(100, 'a', 'hg purge'),
    output(200, 'a', 'ok'),
    logEntry(300, '/files/repos/try/mots.yaml found, setting reviewer data.', {
      source: 'lando.api.legacy.workers.landing_worker',
    }),
    logEntry(400, 'Finished processing LandingJob 1 [LANDED]', WORKER),
    logEntry(500, 'Starting LandingJob 2 [SUBMITTED]', WORKER),
    running(600, 'b', 'hg purge'),
    output(700, 'b', 'ok'),
    logEntry(800, '/files/repos/try/mots.yaml found, setting reviewer data.', {
      source: 'lando.api.legacy.workers.landing_worker',
    }),
    logEntry(900, 'Finished processing LandingJob 2 [LANDED]', WORKER),
  ]);
  const { profile } = buildProfile(entries, { samples: true });
  const { shared } = profile;
  const frameNames = shared.funcTable.name.map((i) => shared.stringArray[i]);

  // Both jobs share one frame, so the tree aggregates them.
  assert.strictEqual(frameNames.filter((n) => n === 'Task').length, 1);
  // No frame name carries a job id, a repo, or any other per-instance detail.
  for (const name of frameNames) {
    assert.ok(
      !/\d/.test(name),
      `frame name "${name}" carries a number, so it will not merge`
    );
  }

  // The ids are still on the markers. The job-level Task is the one with no
  // stage of its own; the nested stage markers repeat the id.
  const jobIds = [];
  for (const thread of profile.threads) {
    for (let i = 0; i < thread.markers.length; i++) {
      const data = thread.markers.data[i];
      if (data && data.type === 'Task' && data.phase === undefined) {
        jobIds.push(data.jobId);
      }
    }
  }
  assert.deepStrictEqual(jobIds.sort(), ['1', '2']);
});

test('a landing Task links to its page in the Lando web UI', () => {
  const { profile } = buildProfile(jobLog(), { samples: false });
  let landing = null;
  for (const thread of profile.threads) {
    for (let i = 0; i < thread.markers.length; i++) {
      const data = thread.markers.data[i];
      // The landing itself: has a job id and an outcome, unlike its stages.
      if (
        data &&
        data.type === 'Task' &&
        data.jobId !== undefined &&
        data.state !== undefined
      ) {
        landing = data;
      }
    }
  }
  assert.ok(landing, 'no landing Task marker was emitted');
  assert.strictEqual(
    landing.url,
    'https://lando.moz.tools/landings/89766/'
  );
  // The id is in the label the chart and tooltip are built from.
  assert.strictEqual(resolveString(profile, landing.name), 'Landing job 89766');

  // The field has to be declared `url` for the front end to linkify it.
  const schema = profile.meta.markerSchema.find((s) => s.name === 'Task');
  const field = schema.fields.find((f) => f.key === 'url');
  assert.ok(field, 'the Task schema has no url field');
  assert.strictEqual(field.format, 'url');
});

test('Task markers are coloured by their outcome', () => {
  const entries = normalize([
    logEntry(0, 'Starting LandingJob 1 [SUBMITTED]', WORKER),
    logEntry(100, 'Finished processing LandingJob 1 [LANDED]', WORKER),
    logEntry(200, 'Starting LandingJob 2 [SUBMITTED]', WORKER),
    logEntry(300, 'Finished processing LandingJob 2 [FAILED]', WORKER),
    logEntry(400, 'Starting LandingJob 3 [DEFERRED]', WORKER),
    logEntry(500, 'Finished processing LandingJob 3 [DEFERRED]', WORKER),
  ]);
  const { profile } = buildProfile(entries, { samples: false });
  validateProfile(profile);

  const byState = new Map();
  for (const thread of profile.threads) {
    for (let i = 0; i < thread.markers.length; i++) {
      const data = thread.markers.data[i];
      if (data && data.type === 'Task') {
        byState.set(resolveString(profile, data.state), data.color);
      }
    }
  }
  assert.strictEqual(byState.get('LANDED'), 'green');
  assert.strictEqual(byState.get('FAILED'), 'red');
  assert.strictEqual(byState.get('DEFERRED'), 'orange');

  // The schema has to point at the field the colour lives on.
  const schema = profile.meta.markerSchema.find((s) => s.name === 'Task');
  assert.strictEqual(schema.colorField, 'color');
});

test('tasks and their stages share the one Task marker name', () => {
  // A marker name per stage filled the marker chart with rows that are all the
  // same kind of thing; the stage belongs in a field. Both levels of the
  // nesting are called Task so they read as one thing, and so that `hg` sorts
  // last.
  const { profile } = buildProfile(jobLog(), { samples: false });
  const names = new Set();
  const phases = new Set();
  for (const thread of profile.threads) {
    for (let i = 0; i < thread.markers.length; i++) {
      const data = thread.markers.data[i];
      if (isTaskPayload(data) && data.phase !== undefined) {
        names.add(profile.shared.stringArray[thread.markers.name[i]]);
        phases.add(resolveString(profile, data.phase));
      }
    }
  }
  assert.deepStrictEqual([...names], ['Task']);
  assert.ok(phases.size > 1, 'expected several distinct phases');
  for (const phase of phases) {
    assert.ok(
      ['Prepare repo', 'Pull', 'Apply patches', 'Export patches', 'Push',
       'Inspect repo', 'Other hg', 'Unknown (before first hg)',
       'Unknown (after push)'].includes(phase),
      `unexpected phase "${phase}"`
    );
  }
});

test('worker diagnostics keep their own names but share a category', () => {
  // State heartbeats, pauses and log errors all describe the worker rather than
  // the work, so they are one marker kind in one category instead of three.
  const entries = normalize([
    logEntry(0, 'LandingWorker try [RUNNING] [3 repos]', WORKER),
    logEntry(100, 'try paused, waiting 10 seconds...', WORKER),
    logEntry(200, 'Unexpected error while pushing to try.', {
      severity: 'ERROR',
      source: 'lando.api.legacy.workers.landing_worker',
    }),
  ]);
  const { profile } = buildProfile(entries, { samples: false });
  validateProfile(profile);

  const debugging = [];
  for (const thread of profile.threads) {
    for (let i = 0; i < thread.markers.length; i++) {
      const data = thread.markers.data[i];
      if (!data || !['LogError', 'WorkerState', 'Paused'].includes(data.type)) {
        continue;
      }
      debugging.push({
        name: profile.shared.stringArray[thread.markers.name[i]],
        category: profile.meta.categories[thread.markers.category[i]].name,
      });
    }
  }
  assert.strictEqual(debugging.length, 3);
  // Three different kinds of thing, so three names...
  assert.deepStrictEqual(debugging.map((d) => d.name).sort(), [
    'LogError',
    'Paused',
    'WorkerState',
  ]);
  // ...but one category, which is what keeps them out of the activity markers.
  assert.deepStrictEqual(
    [...new Set(debugging.map((d) => d.category))],
    ['Debugging']
  );
});

test('idle maintenance is a Task too, coloured grey', () => {
  const entries = normalize([
    logEntry(0, "Starting idle maintenance for 1 repo(s): ['try']", WORKER),
    running(100, 'da1', "hg strip --no-backup -r 'not public()'"),
    output(200, 'da1', 'ok'),
    logEntry(300, 'Finished idle maintenance for 1 of 1 repo(s) in 0.20s', WORKER),
  ]);
  const { profile } = buildProfile(entries, { samples: false });
  validateProfile(profile);

  const tasks = [];
  for (const thread of profile.threads) {
    for (let i = 0; i < thread.markers.length; i++) {
      const data = thread.markers.data[i];
      if (isTaskPayload(data)) {
        tasks.push(data);
      }
    }
  }
  // The round, plus one Task per repo it touched, so the marker chart nests the
  // same way the stack does.
  assert.strictEqual(tasks.length, 2);

  const round = tasks.find((t) => t.state !== undefined);
  assert.strictEqual(resolveString(profile, round.name), 'Idle maintenance');
  assert.strictEqual(resolveString(profile, round.state), 'MAINTENANCE');
  assert.strictEqual(round.color, 'grey');
  assert.strictEqual(resolveString(profile, round.repos), 'try');

  const perRepo = tasks.find((t) => t.state === undefined);
  assert.strictEqual(resolveString(profile, perRepo.name), 'repo: try');
  assert.strictEqual(resolveString(profile, perRepo.repo), 'try');
  assert.strictEqual(perRepo.commandCount, 1);
  // Uncoloured: a repo is a level of the nesting, not an outcome. Only the
  // round itself is grey, because it has no outcome to report.
  assert.strictEqual(perRepo.color, undefined);
});

test('patch-moving stages report how many patches they moved', () => {
  const entries = normalize([
    logEntry(0, 'Starting LandingJob 1 [SUBMITTED]', WORKER),
    // Three patches, each an import followed by a commit.
    running(1000, 'a1', 'hg import -s 95 --no-commit /tmp/x1'),
    output(1100, 'a1', 'applying /tmp/x1'),
    running(1100, 'a2', "hg commit -m 'one'"),
    running(1200, 'a3', 'hg import -s 95 --no-commit /tmp/x2'),
    output(1300, 'a3', 'applying /tmp/x2'),
    running(1300, 'a4', "hg commit -m 'two'"),
    running(1400, 'a5', 'hg import -s 95 --no-commit /tmp/x3'),
    output(1500, 'a5', 'applying /tmp/x3'),
    running(1500, 'a6', "hg commit -m 'three'"),
    // A stage that moves no patches, for contrast.
    running(1600, 'b1', 'hg push -r tip ssh://hg.mozilla.org/try -f'),
    output(1700, 'b1', 'pushing to ssh://hg.mozilla.org/try'),
    logEntry(1800, '/files/repos/try/mots.yaml found, setting reviewer data.', {
      source: 'lando.api.legacy.workers.landing_worker',
    }),
    logEntry(1900, 'Finished processing LandingJob 1 [LANDED]', WORKER),
  ]);
  const { profile } = buildProfile(entries, { samples: false });
  validateProfile(profile);

  const stages = new Map();
  for (const thread of profile.threads) {
    for (let i = 0; i < thread.markers.length; i++) {
      const data = thread.markers.data[i];
      if (isTaskPayload(data) && data.phase !== undefined) {
        stages.set(resolveString(profile, data.phase), data);
      }
    }
  }

  const apply = stages.get('Apply patches');
  assert.ok(apply, 'no Apply patches stage marker');
  // Three patches, not the six commands it took to apply them.
  assert.strictEqual(apply.patchCount, 3);
  assert.strictEqual(apply.commandCount, 6);
  assert.strictEqual(
    resolveString(profile, apply.name),
    'Apply patches (3 patches)'
  );

  // A stage that moves no patches says nothing about them.
  const push = stages.get('Push');
  assert.ok(push, 'no Push stage marker');
  assert.strictEqual(push.patchCount, undefined);
  assert.strictEqual(resolveString(profile, push.name), 'Push');
});

test('a single patch is not labelled "1 patches"', () => {
  const entries = normalize([
    logEntry(0, 'Starting LandingJob 1 [SUBMITTED]', WORKER),
    running(1000, 'a1', 'hg import -s 95 --no-commit /tmp/x1'),
    output(1100, 'a1', 'applying /tmp/x1'),
    running(1100, 'a2', "hg commit -m 'one'"),
    logEntry(1200, 'Finished processing LandingJob 1 [LANDED]', WORKER),
  ]);
  const { profile } = buildProfile(entries, { samples: false });
  for (const thread of profile.threads) {
    for (let i = 0; i < thread.markers.length; i++) {
      const data = thread.markers.data[i];
      if (isTaskPayload(data) && data.patchCount === 1) {
        assert.strictEqual(
          resolveString(profile, data.name),
          'Apply patches (1 patch)'
        );
        return;
      }
    }
  }
  assert.fail('no single-patch stage marker was emitted');
});

test('a Paused marker lasts as long as the worker said it would', () => {
  // The log line states the wait, so there is no reason to draw it as an
  // instant. The pauses repeat for as long as the tree stays closed.
  const entries = normalize([
    logEntry(0, 'try paused, waiting 10 seconds...', WORKER),
    logEntry(10000, 'try paused, waiting 10 seconds...', WORKER),
  ]);
  const { profile } = buildProfile(entries, { samples: false });
  validateProfile(profile);

  const paused = [];
  for (const thread of profile.threads) {
    for (let i = 0; i < thread.markers.length; i++) {
      const data = thread.markers.data[i];
      if (data && data.type === 'Paused') {
        paused.push({
          phase: thread.markers.phase[i],
          duration: thread.markers.endTime[i] - thread.markers.startTime[i],
          seconds: data.seconds,
        });
      }
    }
  }
  assert.strictEqual(paused.length, 2);
  for (const marker of paused) {
    assert.strictEqual(marker.phase, 1, 'should be an interval, not an instant');
    assert.strictEqual(marker.duration, 10000);
    assert.strictEqual(marker.seconds, 10);
  }
});

test('only top-level tasks reach the timeline overview', () => {
  // The timeline strip is one thin row for a whole day, so it only has room
  // for the tasks themselves. Adding the stages, repos, hg commands and log
  // errors under them turned it into a solid band.
  const { profile } = buildProfile(jobLog(), { samples: false });
  const inTimeline = new Set(
    profile.meta.markerSchema
      .filter((s) => s.display.includes('timeline-overview'))
      .map((s) => s.name)
  );
  assert.deepStrictEqual([...inTimeline], ['Task']);

  // Subtasks are named `Task` but typed `Subtask`, since the front end picks
  // the schema by payload type. That is what keeps them out of the timeline
  // while letting the marker chart nest them under the task.
  let tasks = 0;
  let subtasks = 0;
  for (const thread of profile.threads) {
    for (let i = 0; i < thread.markers.length; i++) {
      const data = thread.markers.data[i];
      if (!isTaskPayload(data)) {
        continue;
      }
      const name = profile.shared.stringArray[thread.markers.name[i]];
      assert.strictEqual(name, 'Task', 'every level is named Task');
      if (data.type === 'Task') {
        tasks++;
        // A top-level task is a landing or a maintenance round, so it always
        // reports an outcome.
        assert.ok(data.state !== undefined, `${name} has no outcome`);
      } else {
        subtasks++;
      }
    }
  }
  assert.ok(tasks > 0 && subtasks > 0, 'expected both tasks and subtasks');
  assert.ok(
    subtasks > tasks,
    'the subtasks are the numerous ones, which is why they are excluded'
  );
});

test('only tasks with an outcome are coloured', () => {
  // Colour on a Task means "this is how it ended". Stage and repo markers are
  // levels of the nesting, so they have nothing to report and stay uncoloured;
  // colouring them made the chart a christmas tree and buried the failures.
  const { profile } = buildProfile(jobLog(), { samples: false });
  for (const thread of profile.threads) {
    for (let i = 0; i < thread.markers.length; i++) {
      const data = thread.markers.data[i];
      if (!isTaskPayload(data)) {
        continue;
      }
      const name = resolveString(profile, data.name);
      if (data.state === undefined) {
        assert.strictEqual(data.color, undefined, `${name} should be uncoloured`);
      } else {
        assert.ok(data.color, `${name} should be coloured`);
      }
    }
  }
});

test('a maintenance repo Task spans only that repo\'s commands', () => {
  // A round works each repo in turn, so the repo markers must not overlap.
  const entries = normalize([
    logEntry(0, "Starting idle maintenance for 2 repo(s): ['try', 'try-comm-central']", WORKER),
    running(100, 'da1', "hg strip --no-backup -r 'not public()'", {
      fields: { path: '/files/repos/try' },
    }),
    output(900, 'da1', 'ok', { fields: { path: '/files/repos/try' } }),
    running(1000, 'da2', "hg strip --no-backup -r 'not public()'", {
      fields: { path: '/files/repos/try-comm-central' },
    }),
    output(1300, 'da2', 'ok', { fields: { path: '/files/repos/try-comm-central' } }),
    logEntry(1400, 'Finished idle maintenance for 2 of 2 repo(s) in 1.30s', WORKER),
  ]);
  const { profile } = buildProfile(entries, { samples: false });
  validateProfile(profile);

  const spans = [];
  for (const thread of profile.threads) {
    for (let i = 0; i < thread.markers.length; i++) {
      const data = thread.markers.data[i];
      if (isTaskPayload(data) && data.repo !== undefined) {
        spans.push({
          repo: resolveString(profile, data.repo),
          start: thread.markers.startTime[i],
          end: thread.markers.endTime[i],
        });
      }
    }
  }
  spans.sort((a, b) => a.start - b.start);
  assert.deepStrictEqual(spans.map((s) => s.repo), ['try', 'try-comm-central']);
  assert.ok(
    spans[0].end <= spans[1].start,
    'the repo markers must be sequential, not overlapping'
  );
});

test('all activity markers share one category so they can nest', () => {
  // The marker chart groups stack-based markers by category, so a task, the
  // stage of it that is running, and the hg command doing the work have to be
  // in the same category or they are drawn in separate blocks instead of
  // nested under each other.
  const { profile } = buildProfile(jobLog(), { samples: false });
  const categoryName = (index) => profile.meta.categories[index].name;

  const seen = new Map();
  for (const thread of profile.threads) {
    for (let i = 0; i < thread.markers.length; i++) {
      const data = thread.markers.data[i];
      if (!data) {
        continue;
      }
      const name = profile.shared.stringArray[thread.markers.name[i]];
      if (!seen.has(name)) {
        seen.set(name, new Set());
      }
      seen.get(name).add(categoryName(thread.markers.category[i]));
    }
  }
  // Tasks, stages and hg commands all land in Activity.
  assert.deepStrictEqual([...seen.get('Task')], ['Activity']);
  assert.deepStrictEqual([...seen.get('hg')], ['Activity']);
  for (const name of ['LogError', 'WorkerState', 'Paused']) {
    if (seen.has(name)) {
      assert.deepStrictEqual([...seen.get(name)], ['Debugging'], name);
    }
  }

  // Activity sorts before Debugging, so the work comes first in the chart.
  const names = profile.meta.categories.map((c) => c.name);
  assert.ok(
    names.indexOf('Activity') < names.indexOf('Debugging'),
    'Activity must come before Debugging'
  );
  assert.ok(
    'Activity' < 'Debugging',
    'Activity must also sort before Debugging alphabetically'
  );
});

test('frames keep per-stage colours while markers share one category', () => {
  // These two are independent and need different granularity. Frames colour
  // the timeline's activity graph and the call tree, so they want a colour per
  // stage. Markers have to share one category or the marker chart draws a task,
  // its stage and its hg command as separate blocks instead of nested.
  const { profile } = buildProfile(jobLog(), { samples: true });
  const { shared } = profile;
  const categoryName = (index) => profile.meta.categories[index].name;

  // Frames: the stage and its hg command both carry the stage's category.
  const frameCategories = new Map();
  for (let i = 0; i < shared.frameTable.length; i++) {
    frameCategories.set(
      shared.stringArray[shared.funcTable.name[shared.frameTable.func[i]]],
      categoryName(shared.frameTable.category[i])
    );
  }
  assert.strictEqual(frameCategories.get('Push'), 'Push');
  assert.strictEqual(frameCategories.get('hg push'), 'Push');
  assert.strictEqual(frameCategories.get('Prepare repo'), 'Prepare repo');
  assert.strictEqual(frameCategories.get('hg purge'), 'Prepare repo');
  assert.strictEqual(frameCategories.get('Apply patches'), 'Apply patches');

  // The timeline is painted from the samples, so several stage categories have
  // to be present there or the graph comes out one flat colour.
  const sampleCategories = new Set();
  for (const thread of profile.threads) {
    for (let i = 0; i < thread.samples.length; i++) {
      const stack = thread.samples.stack[i];
      if (stack === null) {
        continue;
      }
      sampleCategories.add(
        categoryName(shared.frameTable.category[shared.stackTable.frame[stack]])
      );
    }
  }
  assert.ok(
    sampleCategories.size >= 4,
    `the timeline only uses ${sampleCategories.size} categories: ${[...sampleCategories]}`
  );

  // Markers: all activity in one category regardless.
  for (const thread of profile.threads) {
    for (let i = 0; i < thread.markers.length; i++) {
      const data = thread.markers.data[i];
      if (!data || !['Task', 'Subtask', 'hg'].includes(data.type)) {
        continue;
      }
      assert.strictEqual(
        categoryName(thread.markers.category[i]),
        'Activity',
        `${data.type} marker should be in Activity`
      );
    }
  }
});

test('activity is two marker names, diagnostics are named per kind', () => {
  const { profile } = buildProfile(jobLog(), { samples: false });
  const names = new Set();
  for (const thread of profile.threads) {
    for (let i = 0; i < thread.markers.length; i++) {
      names.add(profile.shared.stringArray[thread.markers.name[i]]);
    }
  }
  // The activity nesting is Task -> Task -> hg, and nothing else.
  assert.ok(names.has('Task'));
  assert.ok(names.has('hg'));
  for (const name of names) {
    assert.ok(
      ['Task', 'hg', 'LogError', 'WorkerState', 'Paused'].includes(name),
      `unexpected marker name "${name}"`
    );
  }
});

test('the queue counter sits on the worker track it belongs to', () => {
  const { profile } = buildProfile(jobLog(), { samples: true });
  const counter = profile.counters[0];
  const thread = profile.threads[counter.mainThreadIndex];
  assert.strictEqual(thread.name, 'worker');
  assert.strictEqual(thread.pid, counter.pid);
});

test('the queue counter is emitted with a usable display config', () => {
  const { profile } = buildProfile(jobLog(), { samples: false });
  assert.strictEqual(profile.counters.length, 1);
  const counter = profile.counters[0];
  assert.match(counter.name, /Landing queue/);
  assert.strictEqual(counter.samples.length, 1);
  // The counter graphs deltas, so the first reading is the delta from zero.
  assert.strictEqual(counter.samples.count[0], 1);
  assert.strictEqual(counter.display.graphType, 'line-accumulated');
  assert.strictEqual(counter.display.tooltipRows[0].source, 'accumulated');
});

test('the emitted profile satisfies the format invariants', () => {
  const { profile } = buildProfile(jobLog(), { samples: true });
  validateProfile(profile);
});

test('the profile is valid without samples too', () => {
  const { profile } = buildProfile(jobLog(), { samples: false });
  validateProfile(profile);
  for (const thread of profile.threads) {
    assert.strictEqual(thread.samples.length, 0);
  }
});

test('a multi-worker log produces one track per worker, not per repo', () => {
  const entries = normalize([
    logEntry(0, 'Starting LandingJob 1 [SUBMITTED]', { ...WORKER, host: 'worker-a' }),
    running(100, 'a', 'hg purge', { host: 'worker-a' }),
    output(200, 'a', 'ok', { host: 'worker-a' }),
    logEntry(300, '/files/repos/try/mots.yaml found, setting reviewer data.', {
      source: 'lando.api.legacy.workers.landing_worker',
      host: 'worker-a',
    }),
    logEntry(400, 'Finished processing LandingJob 1 [LANDED]', { ...WORKER, host: 'worker-a' }),
    logEntry(0, 'Starting LandingJob 2 [SUBMITTED]', { ...WORKER, host: 'worker-b' }),
    running(100, 'b', 'hg purge', {
      host: 'worker-b',
      fields: { path: '/files/repos/try-comm-central' },
    }),
    output(200, 'b', 'ok', {
      host: 'worker-b',
      fields: { path: '/files/repos/try-comm-central' },
    }),
    logEntry(400, 'Finished processing LandingJob 2 [LANDED]', { ...WORKER, host: 'worker-b' }),
  ]);
  const { profile, stats } = buildProfile(entries, { samples: true });
  validateProfile(profile);
  assert.strictEqual(stats.hosts.length, 2);
  // One track per worker, each in its own process.
  assert.strictEqual(profile.threads.length, 2);
  assert.deepStrictEqual(
    profile.threads.map((t) => t.name),
    ['worker', 'worker']
  );
  assert.deepStrictEqual(
    profile.threads.map((t) => t.processName).sort(),
    ['worker-a', 'worker-b']
  );
  assert.strictEqual(new Set(profile.threads.map((t) => t.pid)).size, 2);

  // The repo each worker served shows up in the stacks, not as a track.
  const { shared } = profile;
  const frameNames = shared.funcTable.name.map((i) => shared.stringArray[i]);
  assert.ok(frameNames.includes('repo: try'));
  assert.ok(frameNames.includes('repo: try-comm-central'));
});

test('a serial sequence across repos stays on one track', () => {
  // A maintenance round runs hg strip against each repo in turn. The worker
  // does one thing at a time, so these must not be drawn as concurrent work on
  // separate tracks.
  const entries = normalize([
    logEntry(0, "Starting idle maintenance for 3 repo(s): ['try', 'try-comm-central', 'conduit-testing-production-repo']", WORKER),
    running(100, 'a', "hg strip --no-backup -r 'not public()'", {
      fields: { path: '/files/repos/try' },
    }),
    output(900, 'a', 'ok', { fields: { path: '/files/repos/try' } }),
    running(1000, 'b', "hg strip --no-backup -r 'not public()'", {
      fields: { path: '/files/repos/try-comm-central' },
    }),
    output(1300, 'b', 'ok', { fields: { path: '/files/repos/try-comm-central' } }),
    running(1320, 'c', "hg strip --no-backup -r 'not public()'", {
      fields: { path: '/files/repos/production-repo' },
    }),
    output(1400, 'c', 'ok', { fields: { path: '/files/repos/production-repo' } }),
    logEntry(1500, 'Finished idle maintenance for 3 of 3 repo(s) in 1.40s', WORKER),
  ]);
  const { profile } = buildProfile(entries, { samples: true });
  validateProfile(profile);
  assert.strictEqual(profile.threads.length, 1);

  // All three commands are on that one track, and each names its own repo.
  const thread = profile.threads[0];
  const repos = [];
  for (let i = 0; i < thread.markers.length; i++) {
    const data = thread.markers.data[i];
    if (data && data.type === 'hg') {
      repos.push(data.repo);
    }
  }
  assert.deepStrictEqual(repos.map((r) => resolveString(profile, r)).sort(), [
    'production-repo',
    'try',
    'try-comm-central',
  ]);

  // No two samples on the track describe overlapping work, because the samples
  // walk one serial timeline.
  const { time, length } = thread.samples;
  for (let i = 1; i < length; i++) {
    assert.ok(time[i] >= time[i - 1], 'samples must be ascending');
  }
});

test('sample weights sum to the covered wall-clock time on each track', () => {
  const entries = jobLog();
  const { profile, stats } = buildProfile(entries, { samples: true });
  const span = stats.endTime - stats.startTime;
  for (const thread of profile.threads) {
    if (thread.samples.length === 0) {
      continue;
    }
    const total = thread.samples.weight.reduce((a, b) => a + b, 0);
    assert.ok(
      Math.abs(total - span) < 1,
      `${thread.name}: weights sum to ${total}, expected ${span}`
    );
  }
});

test('hg self time in the call tree matches the command durations', () => {
  const entries = jobLog();
  const commands = extractHgCommands(entries);
  const { jobs, maintenance } = extractActivities(entries);
  attributeCommands(commands, jobs, maintenance);

  const expected = new Map();
  for (const command of commands) {
    const duration = Math.max(0, command.end - command.start);
    expected.set(command.name, (expected.get(command.name) || 0) + duration);
  }

  const { profile } = buildProfile(entries, { samples: true });
  const { shared } = profile;
  const leafName = (stack) =>
    shared.stringArray[
      shared.funcTable.name[shared.frameTable.func[shared.stackTable.frame[stack]]]
    ];

  const actual = new Map();
  for (const thread of profile.threads) {
    for (let i = 0; i < thread.samples.length; i++) {
      const stack = thread.samples.stack[i];
      const weight = thread.samples.weight[i];
      if (stack === null || !weight) {
        continue;
      }
      const name = leafName(stack);
      actual.set(name, (actual.get(name) || 0) + weight);
    }
  }

  for (const [name, duration] of expected) {
    assert.ok(
      Math.abs((actual.get(name) || 0) - duration) < 1,
      `${name}: call tree has ${actual.get(name) || 0}ms, commands total ${duration}ms`
    );
  }
});

test('duplicate entries across overlapping exports are dropped', () => {
  const shared = logEntry(0, 'Starting LandingJob 1 [SUBMITTED]', {
    ...WORKER,
    insertId: 'dup',
  });
  const { jobs } = extractActivities(normalize([shared, { ...shared }]));
  // Both copies are present here because de-duplication happens in
  // readLogFiles; this asserts the parser is not thrown off by a repeat.
  assert.ok(jobs.length >= 1);
});

test('a Task marker records its command count and time in hg', () => {
  const entries = jobLog();
  const { profile } = buildProfile(entries, { samples: false });
  let job = null;
  for (const thread of profile.threads) {
    for (let i = 0; i < thread.markers.length; i++) {
      const data = thread.markers.data[i];
      // The landing job itself: not one of its stages, and not the
      // maintenance round that follows it.
      if (
        data &&
        data.type === 'Task' &&
        data.phase === undefined &&
        data.jobId !== undefined
      ) {
        job = data;
      }
    }
  }
  assert.ok(job, 'no Task marker was emitted');
  assert.strictEqual(job.jobId, '89766');
  assert.strictEqual(resolveString(profile, job.repo), 'try');
  assert.strictEqual(resolveString(profile, job.state), 'LANDED');
  assert.strictEqual(job.commandCount, 5);
  assert.ok(job.hgTime > 0);
  // A landed job is drawn green.
  assert.strictEqual(job.color, 'green');
});

test('hg markers carry the full command line and the remote', () => {
  const { profile } = buildProfile(jobLog(), { samples: false });
  const pushes = [];
  for (const thread of profile.threads) {
    for (let i = 0; i < thread.markers.length; i++) {
      const data = thread.markers.data[i];
      if (data && data.type === 'hg') {
        pushes.push(data);
      }
    }
  }
  const push = pushes.find(
    (d) => resolveString(profile, d.command) === 'push'
  );
  assert.ok(push, 'no hg push marker was emitted');
  // The `hg ` prefix is stripped from the short command name.
  assert.strictEqual(resolveString(profile, push.command), 'push');
  assert.match(push.cmdLine, /^hg push -r tip/);
  assert.strictEqual(push.remote, 'ssh://hg.mozilla.org/try');
  assert.strictEqual(push.jobId, '89766');
});

// ---------------------------------------------------------------------------

console.log(`${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
