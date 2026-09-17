#!/usr/bin/env node
/**
 * lando-profiler - turns GCP Cloud Logging exports from the Lando landing
 * workers into Firefox Profiler profiles.
 *
 * The landing workers log a "running hg command #<uuid>: <cmd>" line before
 * each Mercurial invocation and an "output from hg command #<uuid>: ..." line
 * after it, which gives us exact command timings. Commands on a given worker
 * are strictly serialized (verified: zero overlaps across 24h of logs), so
 * when a command produced no output we can still recover its end time from the
 * next event on that worker.
 *
 * Usage:
 *   ./index.js [options] <logs.json...>
 *
 * Options:
 *   -o, --output <file>   Where to write the profile (default lando-profile.json)
 *       --open            Open the profile in profiler.firefox.com
 *       --no-samples      Only emit markers, no synthetic samples
 *   -h, --help
 */

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const { ProfileBuilder, CATEGORY } = require('./profile-format');

// ---------------------------------------------------------------------------
// Log parsing
// ---------------------------------------------------------------------------

/**
 * Cloud Logging entries carry two timestamps: the outer `timestamp` (when the
 * entry was ingested, millisecond resolution) and `jsonPayload.Timestamp` (when
 * the application logged it, nanoseconds). Prefer the latter, and fall back to
 * the former for the plain-stdout entries that have no jsonPayload.
 */
function entryTime(entry) {
  const nanos = entry.jsonPayload && entry.jsonPayload.Timestamp;
  if (nanos !== undefined && nanos !== null) {
    return Number(nanos) / 1e6;
  }
  return Date.parse(entry.timestamp);
}

function readLogFiles(files) {
  const entries = [];
  for (const file of files) {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const array = Array.isArray(parsed) ? parsed : [parsed];
    for (const entry of array) {
      entries.push(entry);
    }
  }

  // GCP exports are newest-first, and we get one file per time window.
  entries.sort((a, b) => entryTime(a) - entryTime(b));

  // The same entry can show up in two overlapping exports.
  const seen = new Set();
  return entries.filter((entry) => {
    if (!entry.insertId) {
      return true;
    }
    if (seen.has(entry.insertId)) {
      return false;
    }
    seen.add(entry.insertId);
    return true;
  });
}

/**
 * The logger that emitted an entry, as a string.
 *
 * Most entries are Lando's own and carry a dotted logger name. A few are the
 * cluster's rather than the application's -- kubelet liveness and readiness
 * probes -- and carry an object instead, which naively stringified to
 * "[object Object]".
 */
function formatSource(source) {
  if (!source) {
    return '';
  }
  if (typeof source === 'string') {
    return source;
  }
  if (typeof source === 'object') {
    const { component, host } = source;
    if (component) {
      return host ? `${component} (${host})` : String(component);
    }
  }
  return '';
}

/** Turns a log entry into the flat shape the rest of the tool works with. */
function normalizeEntry(entry) {
  const payload = entry.jsonPayload || {};
  const fields = payload.Fields || {};
  return {
    time: entryTime(entry),
    message: String(payload.message ?? entry.textPayload ?? ''),
    source: formatSource(payload.source),
    severity: entry.severity || 'INFO',
    host:
      payload.Hostname ||
      (entry.resource && entry.resource.labels && entry.resource.labels.pod_name) ||
      'unknown',
    fields,
  };
}

// ---------------------------------------------------------------------------
// hg commands
// ---------------------------------------------------------------------------

// The id is a UUID in practice, but matched loosely so that an unexpected id
// format drops a command's timing rather than the command itself.
const RE_RUNNING = /^running hg command #(\S+?): (.*)$/s;
const RE_OUTPUT = /^output from hg command #(\S+?): ?(.*)$/s;
const RE_HG_ERROR = /^hg error in cmd: (.*)$/s;

/** `/files/repos/try` -> `try` */
function repoFromPath(repoPath) {
  return repoPath ? path.basename(repoPath) : 'unknown';
}

/**
 * Collapses an hg command line into a stable name, so that the call tree
 * aggregates the thousands of `hg import`/`hg commit` invocations instead of
 * showing each temp-file path and revision separately.
 *
 * `hg log -r . -T '{node}'` -> `hg log`, `hg --quiet revert --no-backup --all`
 * -> `hg revert`, `hg push -r tip ssh://...` -> `hg push`.
 */
function hgCommandName(command) {
  const words = String(command).trim().split(/\s+/);
  const parts = [];
  for (const word of words) {
    if (parts.length === 0) {
      // Skip the leading `hg` and any global flags like `--quiet`.
      if (word === 'hg' || word.startsWith('-')) {
        continue;
      }
      parts.push(word);
      continue;
    }
    // Keep a second bare word for subcommands (e.g. `hg rebase --abort` needs
    // the flag, handled below; `hg pull URL` does not).
    break;
  }
  const subcommand = parts[0] || 'hg';
  // A few commands are worth distinguishing by their mode.
  const modeFlag = words.find((w) =>
    ['--abort', '--continue', '--clean', '--amend'].includes(w)
  );
  return 'hg ' + subcommand + (modeFlag ? ' ' + modeFlag : '');
}

/** The remote a push/pull talks to, for the marker tooltip. */
function remoteFromCommand(command) {
  const match = /\b((?:ssh|https?):\/\/[^\s']+)/.exec(String(command));
  return match ? match[1] : undefined;
}

/**
 * Pairs up `running`/`output` lines into commands with start and end times.
 *
 * Commands are serialized per worker, so an unterminated command is ended by
 * the next log line from that worker. That is an upper bound on its duration,
 * but since the next line is usually the following `running hg command` it is
 * a tight one. Such commands are flagged `inferredEnd`.
 */
function extractHgCommands(entries) {
  const commandsById = new Map();
  const inFlightByHost = new Map();
  const commands = [];

  const closeInFlight = (host, time) => {
    const pending = inFlightByHost.get(host);
    if (pending && pending.end === null) {
      pending.end = time;
      pending.inferredEnd = true;
    }
    inFlightByHost.delete(host);
  };

  for (const entry of entries) {
    const running = RE_RUNNING.exec(entry.message);
    if (running) {
      // The previous command on this worker must have finished by now.
      closeInFlight(entry.host, entry.time);

      const command = {
        id: running[1],
        command: running[2],
        name: hgCommandName(running[2]),
        repo: repoFromPath(entry.fields.path),
        repoPath: entry.fields.path,
        host: entry.host,
        hgPid: entry.fields.hg_pid,
        start: entry.time,
        end: null,
        inferredEnd: false,
        output: undefined,
        error: undefined,
      };
      commandsById.set(command.id, command);
      inFlightByHost.set(entry.host, command);
      commands.push(command);
      continue;
    }

    const output = RE_OUTPUT.exec(entry.message);
    if (output) {
      const command = commandsById.get(output[1]);
      if (command) {
        command.end = entry.time;
        command.output = output[2];
        if (inFlightByHost.get(command.host) === command) {
          inFlightByHost.delete(command.host);
        }
      }
      continue;
    }

    const hgError = RE_HG_ERROR.exec(entry.message);
    if (hgError) {
      // Error lines carry the command_id in Fields but not in the message.
      const command = commandsById.get(entry.fields.command_id);
      if (command) {
        command.end = entry.time;
        command.error = hgError[1].trim();
        if (inFlightByHost.get(command.host) === command) {
          inFlightByHost.delete(command.host);
        }
      }
      continue;
    }

    // Any other line from this worker also bounds the in-flight command.
    closeInFlight(entry.host, entry.time);
  }

  for (const [host, pending] of inFlightByHost) {
    if (pending.end === null) {
      // Last command of the log; we have no idea when it ended.
      pending.end = pending.start;
      pending.inferredEnd = true;
    }
    void host;
  }

  return commands;
}

// ---------------------------------------------------------------------------
// Landing jobs and idle maintenance
// ---------------------------------------------------------------------------

const RE_JOB_START = /^Starting LandingJob (\d+) \[(\w+)\]/;
const RE_JOB_END = /^Finished processing LandingJob (\d+) \[(\w+)\]/;
const RE_MAINT_START = /^Starting idle maintenance for (\d+) repo\(s\): \[(.*)\]/;
const RE_MAINT_END =
  /^Finished idle maintenance for (\d+) of (\d+) repo\(s\) in ([\d.]+)s/;
const RE_MAINT_BUDGET =
  /^Idle maintenance budget \((\d+)s\) reached after (\d+) of (\d+) repo\(s\)/;
const RE_QUEUE = /^Queue size for worker (\S+) is (\d+) \((\d+) on open trees, (\d+) behind closed trees\)/;
const RE_WORKER_STATE = /^LandingWorker (\S+) \[(\w+)\] \[(\d+) repos\]/;
const RE_PAUSED = /^(\S+) paused, waiting (\d+) seconds/;
const RE_MOTS = /^(\S+)\/mots\.yaml found, setting reviewer data\./;

/**
 * Walks the log and produces the higher-level intervals: landing jobs, idle
 * maintenance rounds, queue-size readings and worker state changes.
 */
function extractActivities(entries) {
  const jobs = [];
  const maintenance = [];
  const queueReadings = [];
  const workerStates = [];
  const notes = [];

  const openJobs = new Map();
  const openMaintByHost = new Map();

  for (const entry of entries) {
    const { message, time, host } = entry;

    let match = RE_JOB_START.exec(message);
    if (match) {
      // A worker handles one job at a time; a new start closes any stale job.
      const stale = openJobs.get(host);
      if (stale) {
        stale.end = time;
        stale.state = 'INCOMPLETE';
      }
      const job = {
        id: match[1],
        initialState: match[2],
        host,
        start: time,
        end: null,
        state: null,
        repo: undefined,
        errors: [],
      };
      openJobs.set(host, job);
      jobs.push(job);
      continue;
    }

    match = RE_JOB_END.exec(message);
    if (match) {
      const job = openJobs.get(host);
      if (job && job.id === match[1]) {
        job.end = time;
        job.state = match[2];
        openJobs.delete(host);
      }
      continue;
    }

    match = RE_MAINT_START.exec(message);
    if (match) {
      const round = {
        host,
        start: time,
        end: null,
        repos: match[2]
          .split(',')
          .map((r) => r.trim().replace(/^'|'$/g, ''))
          .filter(Boolean),
        requested: Number(match[1]),
        completed: null,
        budgetReached: false,
      };
      openMaintByHost.set(host, round);
      maintenance.push(round);
      continue;
    }

    match = RE_MAINT_END.exec(message);
    if (match) {
      const round = openMaintByHost.get(host);
      if (round) {
        round.end = time;
        round.completed = Number(match[1]);
        openMaintByHost.delete(host);
      }
      continue;
    }

    match = RE_MAINT_BUDGET.exec(message);
    if (match) {
      const round = openMaintByHost.get(host);
      if (round) {
        round.budgetReached = true;
        round.budgetSeconds = Number(match[1]);
      }
      continue;
    }

    match = RE_QUEUE.exec(message);
    if (match) {
      queueReadings.push({
        host,
        time,
        worker: match[1],
        size: Number(match[2]),
        openTrees: Number(match[3]),
        closedTrees: Number(match[4]),
      });
      continue;
    }

    match = RE_WORKER_STATE.exec(message);
    if (match) {
      workerStates.push({
        host,
        time,
        worker: match[1],
        state: match[2],
        repoCount: Number(match[3]),
      });
      continue;
    }

    match = RE_PAUSED.exec(message);
    if (match) {
      notes.push({
        host,
        time,
        kind: 'paused',
        // The worker says how long it is about to wait, so the marker can be
        // an interval rather than an instant. The pauses repeat every 10s for
        // as long as the tree stays closed.
        duration: Number(match[2]) * 1000,
        label: `${match[1]} paused, waiting ${match[2]}s`,
        message,
      });
      continue;
    }

    match = RE_MOTS.exec(message);
    if (match) {
      // This line tells us which repo the running job is landing to.
      const job = openJobs.get(host);
      if (job && !job.repo) {
        job.repo = repoFromPath(match[1]);
      }
      continue;
    }

    if (entry.severity === 'ERROR' || entry.severity === 'WARNING') {
      const job = openJobs.get(host);
      const note = {
        host,
        time,
        kind: entry.severity.toLowerCase(),
        label: summarize(message) || entry.source || entry.severity,
        message,
        source: entry.source,
        error: entry.fields.exc && entry.fields.exc.error,
        traceback: entry.fields.exc && entry.fields.exc.traceback,
      };
      notes.push(note);
      if (job) {
        job.errors.push(note);
      }
    }
  }

  for (const job of openJobs.values()) {
    if (job.end === null) {
      job.end = job.start;
      job.state = 'UNTERMINATED';
    }
  }
  for (const round of openMaintByHost.values()) {
    if (round.end === null) {
      round.end = round.start;
    }
  }

  return { jobs, maintenance, queueReadings, workerStates, notes };
}

/**
 * A one-line summary of a log message, for a marker label.
 *
 * Not simply the first line: the most common error in these logs is
 *
 *     hg error in cmd: hg strip --no-backup -r not public():
 *     abort: empty revision set
 *
 * whose first line is only the command that failed, and whose second says what
 * went wrong. So the lines are joined, which makes the summary self-contained
 * and the full message redundant for all but a handful of entries.
 */
function summarize(text) {
  const line = String(text)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' ');
  return line.length > 200 ? line.slice(0, 199) + '…' : line;
}

function truncate(text, max = 2000) {
  const s = String(text);
  return s.length > max ? s.slice(0, max) + '…' : s;
}

// ---------------------------------------------------------------------------
// Attribution: which job/maintenance round does each hg command belong to?
// ---------------------------------------------------------------------------

/**
 * Assigns each hg command to the job or maintenance round that was running on
 * the same worker at the time, and infers each job's repo from its commands
 * when the mots.yaml line was absent.
 */
function attributeCommands(commands, jobs, maintenance) {
  const byHost = new Map();
  const push = (host, item) => {
    if (!byHost.has(host)) {
      byHost.set(host, { jobs: [], maintenance: [] });
    }
    return byHost.get(host);
  };
  for (const job of jobs) {
    push(job.host).jobs.push(job);
    job.commands = [];
  }
  for (const round of maintenance) {
    push(round.host).maintenance.push(round);
    round.commands = [];
  }
  for (const buckets of byHost.values()) {
    buckets.jobs.sort((a, b) => a.start - b.start);
    buckets.maintenance.sort((a, b) => a.start - b.start);
  }

  const findContaining = (list, time) => {
    // Binary search for the last interval starting at or before `time`.
    let low = 0;
    let high = list.length - 1;
    let found = null;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (list[mid].start <= time) {
        found = list[mid];
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return found && found.end >= time ? found : null;
  };

  for (const command of commands) {
    const buckets = byHost.get(command.host);
    if (!buckets) {
      continue;
    }
    const job = findContaining(buckets.jobs, command.start);
    if (job) {
      command.job = job;
      job.commands.push(command);
      continue;
    }
    const round = findContaining(buckets.maintenance, command.start);
    if (round) {
      command.maintenance = round;
      round.commands.push(command);
    }
  }

  for (const job of jobs) {
    if (!job.repo) {
      // Fall back to the repo most of the job's commands ran against.
      const counts = new Map();
      for (const command of job.commands) {
        counts.set(command.repo, (counts.get(command.repo) || 0) + 1);
      }
      let best;
      let bestCount = 0;
      for (const [repo, count] of counts) {
        if (count > bestCount) {
          best = repo;
          bestCount = count;
        }
      }
      // A job cut off by the end of the log window can have no commands at
      // all, in which case its repo is genuinely unknown. Left null so that it
      // goes on the worker track instead of conjuring a repo track for it.
      job.repo = best || null;
    }
  }
}

/**
 * Shortest untraced stretch inside a job worth showing, in milliseconds. Below
 * this a gap is the delay between a command finishing and the next one being
 * logged rather than anything the worker did.
 */
const UNTRACED_THRESHOLD = 250;

/**
 * Marks a stretch inside a job where the worker logged nothing, so the stack
 * chart shows unaccounted-for time instead of a hole. `after` is the command
 * the gap follows, or null when it follows the start of the job.
 */
/**
 * The label for an untraced stretch. Deliberately vague, because the logs do
 * not say what happens in these windows -- they contain no lines at all.
 *
 * What the data does show: the cost tracks the repository, not the step. On
 * `try` both stretches take ~6.5s; on `try-comm-central`, for the same steps,
 * ~0.8s. And on try-comm-central the post-push bookkeeping that *is* logged
 * (saving the push, notifying Pulse) accounts for only 0.2s of it. So this is
 * time spent on the working directory rather than on the job, and naming it
 * "unlogged" is as much as the log supports.
 */
function untracedLabel(after) {
  return after === null ? 'Unknown (before first hg)' : 'Unknown (after push)';
}

/**
 * The hg command that stands for one patch in a given stage, where there is
 * one. A stage's patch count is how many times it ran.
 *
 * `Apply patches` runs `hg import` then `hg commit` per patch -- verified over
 * a 24h export: the two counts agree for all 385 jobs -- so either would do and
 * `import` is the one that applies the patch. `Export patches` runs one
 * `hg export` per patch.
 */
const PATCH_COMMAND = {
  'Apply patches': 'hg import',
  'Export patches': 'hg export',
};

/**
 * The category a *stack frame* is drawn in, by pipeline stage. Frames drive the
 * timeline's activity graph and the call tree, which want a colour per stage.
 * Markers are not coloured this way: they all share `Activity` so that the
 * marker chart can nest them. See CATEGORIES in profile-format.js.
 */
function phaseCategory(phase) {
  return CATEGORY[phase] ?? CATEGORY.Activity;
}

/**
 * The call-tree frames for a job: `LandingJob` then the repo it lands to.
 *
 * The job frame is deliberately identical for every job. A frame name is what
 * the call tree and the flame graph merge on, so putting the job id here gave
 * every job its own frame and the flame graph became one sliver per job instead
 * of a profile of where landing time goes. The id lives on the LandingJob
 * marker, which is where per-job detail belongs.
 *
 * The repo does get a frame, since a worker serves several and it is worth
 * being able to split the time by repo. It sits in the stack rather than in a
 * track of its own because the worker only ever works on one repo at a time.
 */
const JOB_FRAME_NAME = 'Task';

function repoFrameName(repo) {
  return `repo: ${repo}`;
}

function jobPath(job) {
  const path = [[JOB_FRAME_NAME, CATEGORY.Activity]];
  if (job.repo) {
    path.push([repoFrameName(job.repo), CATEGORY.Activity]);
  }
  return path;
}

/**
 * Groups a job's hg commands into the phases of the landing pipeline, so the
 * call tree shows "where did this job spend its time" rather than a flat list
 * of a hundred `hg import` calls.
 */
function commandPhase(command) {
  switch (command.name) {
    // Reverting, purging and stripping happen both before a job starts and as
    // cleanup after it, so they share one phase.
    case 'hg revert':
    case 'hg purge':
    case 'hg strip':
    case 'hg rebase --abort':
    case 'hg update --clean':
    // Run once per repo at worker startup, to drop locks a previous incarnation
    // of the worker left behind.
    case 'hg debuglocks':
      return 'Prepare repo';
    case 'hg pull':
      return 'Pull';
    case 'hg import':
    case 'hg commit':
      return 'Apply patches';
    case 'hg push':
      return 'Push';
    case 'hg export':
      return 'Export patches';
    case 'hg log':
    case 'hg identify':
      return 'Inspect repo';
    default:
      return 'Other hg';
  }
}



// ---------------------------------------------------------------------------
// Profile construction
// ---------------------------------------------------------------------------

/**
 * The colour a Task marker is drawn in, keyed by how the task ended. The value
 * has to be one of the front end's GraphColor names.
 */
const TASK_COLORS = {
  LANDED: 'green',
  FAILED: 'red',
  DEFERRED: 'orange',
  // A task the log window cut off, so we never saw how it ended.
  UNTERMINATED: 'grey',
  INCOMPLETE: 'grey',
  // Idle maintenance, which is housekeeping rather than a landing.
  MAINTENANCE: 'grey',
};

/**
 * Every level of the activity nesting is a marker *named* `Task`: a task, the
 * repo it is working on, the stage that is running, then the `hg` command doing
 * the work. Sharing the name makes the nesting read as one thing rather than as
 * unrelated marker kinds, and leaves `hg` last alphabetically so it sorts to
 * the bottom of the chart.
 *
 * The schema is chosen by the payload's `type`, not by the marker name, so the
 * nested levels can use a `Subtask` schema while still being called `Task`.
 * The only difference that makes is `display`: a top-level task belongs in the
 * timeline overview, but the ~3900 subtasks under them do not -- they turned
 * the timeline strip into a solid band.
 */
const SUBTASK_FIELDS = [
  { key: 'name', label: 'Task', format: 'unique-string' },
  { key: 'jobId', label: 'Job ID', format: 'string' },
  { key: 'repo', label: 'Repo', format: 'unique-string' },
  { key: 'commandCount', label: 'hg commands', format: 'integer' },
  { key: 'phase', label: 'Stage', format: 'unique-string' },
  { key: 'patchCount', label: 'Patches', format: 'integer' },
];

const MARKER_SCHEMA = [
  {
    name: 'Task',
    // `name` already reads as "Landing job 89766" or "Push", so it carries the
    // job id for a landing and stands alone for a stage. The outcome is not in
    // the label because a stage has none, and it would render as an empty pair
    // of brackets on every stage marker.
    tooltipLabel: '{marker.data.name}',
    tableLabel: '{marker.data.name}',
    chartLabel: '{marker.data.name}',
    display: ['marker-chart', 'marker-table', 'timeline-overview'],
    isStackBased: true,
    // Green when a landing succeeded, red when it failed, grey for
    // maintenance; see TASK_COLORS.
    colorField: 'color',
    fields: [
      { key: 'name', label: 'Task', format: 'unique-string' },
      { key: 'state', label: 'Outcome', format: 'unique-string' },
      { key: 'url', label: 'Details', format: 'url' },
      { key: 'jobId', label: 'Job ID', format: 'string' },
      { key: 'repo', label: 'Repo', format: 'unique-string' },
      { key: 'initialState', label: 'Initial state', format: 'unique-string' },
      { key: 'commandCount', label: 'hg commands', format: 'integer' },
      { key: 'hgTime', label: 'Time in hg', format: 'duration' },
      { key: 'errorCount', label: 'Errors logged', format: 'integer' },
      { key: 'worker', label: 'Worker', format: 'unique-string' },
      { key: 'repos', label: 'Repos', format: 'unique-string' },
      { key: 'requested', label: 'Repos requested', format: 'integer' },
      { key: 'completed', label: 'Repos completed', format: 'integer' },
      { key: 'budgetReached', label: 'Budget reached', format: 'unique-string' },
      { key: 'phase', label: 'Stage', format: 'unique-string' },
      { key: 'patchCount', label: 'Patches', format: 'integer' },
      // Read for the marker's colour, not for display.
      { key: 'color', label: 'Colour', format: 'string', hidden: true },
    ],
  },
  {
    // Nested under a Task, and named `Task` too; see the comment above. Absent
    // from the timeline overview, which only has room for the top-level tasks.
    name: 'Subtask',
    tooltipLabel: '{marker.data.name}',
    tableLabel: '{marker.data.name}',
    chartLabel: '{marker.data.name}',
    display: ['marker-chart', 'marker-table'],
    isStackBased: true,
    fields: SUBTASK_FIELDS,
  },
  {
    name: 'hg',
    tooltipLabel: 'hg {marker.data.command}',
    tableLabel: '{marker.data.cmdLine}',
    // The `hg ` prefix is the same on every marker, so it is left out of the
    // chart label where horizontal room is scarce.
    chartLabel: '{marker.data.command}',
    display: ['marker-chart', 'marker-table'],
    isStackBased: true,
    fields: [
      { key: 'command', label: 'Command', format: 'unique-string' },
      { key: 'cmdLine', label: 'Full command line', format: 'string' },
      { key: 'repo', label: 'Repo', format: 'unique-string' },
      { key: 'remote', label: 'Remote', format: 'url' },
      { key: 'jobId', label: 'Job ID', format: 'string' },
      { key: 'hgPid', label: 'hg pid', format: 'string' },
      { key: 'output', label: 'Output', format: 'string' },
      { key: 'error', label: 'Error', format: 'string' },
      { key: 'inferredEnd', label: 'End time inferred', format: 'unique-string' },
    ],
    // Worth saying, because it is the one duration in the profile that is not
    // measured directly. "A Mercurial command" is not, so it is left out.
    description:
      'A command that logged no output has its end time inferred from the next log line.',
  },
  // The worker's own diagnostics. These keep names of their own, because they
  // are genuinely different things and the marker table is easier to read for
  // it; what they share is the Debugging *category*, which is what keeps them
  // out of the way of the activity markers.
  {
    name: 'LogError',
    tooltipLabel: '{marker.data.label}',
    tableLabel: '{marker.data.label}',
    chartLabel: '{marker.data.label}',
    // Not in the timeline overview: most of these are benign (see the README),
    // so a mark per error would say "something is wrong here" 364 times a day
    // about nothing.
    display: ['marker-chart', 'marker-table'],
    fields: [
      { key: 'label', label: 'Message', format: 'string' },
      { key: 'severity', label: 'Severity', format: 'unique-string' },
      { key: 'source', label: 'Logger', format: 'unique-string' },
      { key: 'error', label: 'Exception', format: 'string' },
      { key: 'traceback', label: 'Traceback', format: 'string' },
      { key: 'full', label: 'Full message', format: 'string' },
    ],
  },
  {
    name: 'WorkerState',
    tooltipLabel: 'Worker {marker.data.worker} {marker.data.state}',
    tableLabel: 'Worker {marker.data.worker} {marker.data.state}',
    chartLabel: '{marker.data.state}',
    display: ['marker-chart', 'marker-table'],
    fields: [
      { key: 'worker', label: 'Worker', format: 'unique-string' },
      { key: 'state', label: 'State', format: 'unique-string' },
      { key: 'repoCount', label: 'Repos', format: 'integer' },
    ],
  },
  {
    name: 'Paused',
    tooltipLabel: '{marker.data.label}',
    tableLabel: '{marker.data.label}',
    chartLabel: '{marker.data.label}',
    display: ['marker-chart', 'marker-table'],
    fields: [
      { key: 'label', label: 'Message', format: 'string' },
      { key: 'seconds', label: 'Declared wait', format: 'seconds' },
    ],
    // Not obvious from the name why the worker would pause.
    description: 'The worker waiting for a closed tree to reopen.',
  },
];
/**
 * Builds the counter track showing the landing queue depth over time.
 *
 * The queue is per worker, not per repo: a single worker serves every repo it
 * is configured for (the `LandingWorker try [RUNNING] [3 repos]` line), and the
 * log reports one depth for all of them. So there is one counter per worker,
 * named after the worker, and it is attached to that worker's own track rather
 * than to any one repo track.
 */
function buildQueueCounters(queueReadings, startTime, pidForWorker) {
  const byWorker = new Map();
  for (const reading of queueReadings) {
    if (!byWorker.has(reading.worker)) {
      byWorker.set(reading.worker, []);
    }
    byWorker.get(reading.worker).push(reading);
  }

  const counters = [];
  for (const [worker, readings] of byWorker) {
    readings.sort((a, b) => a.time - b.time);
    const samples = { time: [], count: [], number: [], length: 0 };
    // Counter tracks in the profiler accumulate deltas, so emit the difference
    // between consecutive readings.
    let previous = 0;
    for (const reading of readings) {
      samples.time.push(reading.time - startTime);
      samples.count.push(reading.size - previous);
      samples.number.push(1);
      samples.length++;
      previous = reading.size;
    }
    counters.push({
      name: `Landing queue (worker ${worker})`,
      category: 'Other',
      description:
        `Landing jobs queued for worker ${worker}, across every repo it ` +
        `serves. The log reports a single queue depth per worker.`,
      ...pidForWorker(worker),
      samples,
      // Required since format v63; nothing back-fills it for a profile that
      // declares the current version. The queue is a level rather than a rate,
      // so it is graphed as the accumulation of the deltas emitted above.
      display: {
        graphType: 'line-accumulated',
        unit: 'jobs',
        color: 'blue',
        markerSchemaLocation: null,
        sortWeight: 50,
        label: `Landing queue (worker ${worker})`,
        tooltipRows: [
          {
            type: 'value',
            source: 'accumulated',
            format: { unit: 'number' },
            label: 'Jobs queued',
          },
        ],
      },
    });
  }
  return counters;
}

function buildProfile(entries, options) {
  const commands = extractHgCommands(entries);
  const { jobs, maintenance, queueReadings, workerStates, notes } =
    extractActivities(entries);
  attributeCommands(commands, jobs, maintenance);

  const times = [];
  for (const entry of entries) {
    if (Number.isFinite(entry.time)) {
      times.push(entry.time);
    }
  }
  const startTime = Math.min(...times);
  const endTime = Math.max(...times);

  const profile = new ProfileBuilder({
    product: 'Lando landing workers',
    // Nominal: the samples below are weighted by duration, not ticked.
    interval: 1,
    startTime,
    markerSchema: MARKER_SCHEMA,
  });
  profile.meta.endTime = endTime;
  profile.meta.logType = 'lando';

  // One track per worker, and nothing finer.
  //
  // A landing worker does one thing at a time: verified across a 24h export,
  // none of the 12235 hg commands overlap another, and no job or maintenance
  // round overlaps another. An earlier layout gave each repo clone its own
  // track, which drew a single serial sequence -- a maintenance round running
  // `hg strip` against try, then try-comm-central, then production-repo -- as
  // if three things happened at once. The repo belongs in the stack instead,
  // where it groups the work without implying concurrency.
  const hosts = [...new Set(entries.map((e) => e.host))].sort();
  const hostPid = new Map(hosts.map((host, i) => [host, 1000 + i]));

  const threads = new Map();
  let nextTid = 1;
  const threadFor = (host) => {
    let thread = threads.get(host);
    if (thread) {
      return thread;
    }
    thread = profile.addThread({
      name: 'worker',
      processName: host,
      pid: hostPid.get(host) ?? 1000,
      tid: nextTid++,
      isMainThread: true,
      showMarkersInTimeline: true,
    });
    thread.lando = { host, intervals: [] };
    threads.set(host, thread);
    return thread;
  };

  // Created up front so that tracks come out in a stable order rather than in
  // whichever order the log happens to mention the workers.
  for (const host of hosts) {
    threadFor(host);
  }

  const rel = (t) => t - startTime;

  // -- Markers, and the intervals the synthetic samples are derived from.

  for (const job of jobs) {
    const thread = threadFor(job.host);
    const hgTime = job.commands.reduce(
      (sum, c) => sum + Math.max(0, c.end - c.start),
      0
    );
    const state = job.state || 'UNKNOWN';
    thread.addMarker(
      'Task',
      rel(job.start),
      rel(job.end),
      {
        type: 'Task',
        // The id is what identifies a landing, so it goes in the label the
        // chart and the tooltip are built from.
        name: thread.stringIndex(`Landing job ${job.id}`),
        url: landoJobUrl(job.id),
        jobId: job.id,
        repo: job.repo ? thread.stringIndex(job.repo) : undefined,
        state: thread.stringIndex(state),
        initialState: thread.stringIndex(job.initialState),
        commandCount: job.commands.length,
        hgTime,
        errorCount: job.errors.length,
        worker: thread.stringIndex(job.host),
        color: TASK_COLORS[state] || 'grey',
      },
      CATEGORY.Activity
    );
    thread.lando.intervals.push({
      start: job.start,
      end: job.end,
      path: jobPath(job),
    });

    // Group the job's commands into contiguous runs of the same phase.
    const sorted = job.commands.slice().sort((a, b) => a.start - b.start);
    let group = null;
    const flush = () => {
      if (!group) {
        return;
      }
      // "Apply patches (7 patches)" says more at a glance than the duration
      // alone, since a stage's cost is mostly a function of how much it moves.
      const patchCount = group.patchCount;
      const label =
        patchCount > 0
          ? `${group.phase} (${patchCount} patch${patchCount === 1 ? '' : 'es'})`
          : group.phase;
      thread.addMarker(
        'Task',
        rel(group.start),
        rel(group.end),
        {
          type: 'Subtask',
          name: thread.stringIndex(label),
          phase: thread.stringIndex(group.phase),
          patchCount: patchCount > 0 ? patchCount : undefined,
          jobId: job.id,
          commandCount: group.count,
          // Deliberately no colour. A colour per stage turned a row of stage
          // markers into a different hue every few pixels, which carries no
          // information the label does not already give: the outcome colours on
          // the task above are the ones worth seeing at a glance.
        },
        CATEGORY.Activity
      );
      group = null;
    };
    for (const command of sorted) {
      const phase = commandPhase(command);
      const isPatch = PATCH_COMMAND[phase] === command.name;
      if (group && group.phase === phase) {
        group.end = Math.max(group.end, command.end);
        group.count++;
        group.patchCount += isPatch ? 1 : 0;
      } else {
        flush();
        group = {
          phase,
          start: command.start,
          end: command.end,
          count: 1,
          patchCount: isPatch ? 1 : 0,
        };
      }
      command.phase = phase;
    }
    flush();

    // The stretches inside a job where the worker logged nothing at all. In a
    // 24h export these are 9.9% of all job time and every job has two of them.
    // Left implicit they are holes in the stack chart, which reads as the
    // worker idling; naming them says "we do not know" instead. See
    // untracedLabel for what the data does and does not tell us.
    const addUntraced = (from, to, after) => {
      if (to - from < UNTRACED_THRESHOLD) {
        return;
      }
      const label = untracedLabel(after);
      thread.addMarker(
        'Task',
        rel(from),
        rel(to),
        {
          type: 'Subtask',
          name: thread.stringIndex(label),
          phase: thread.stringIndex(label),
          jobId: job.id,
        },
        CATEGORY.Activity
      );
      thread.lando.intervals.push({
        start: from,
        end: to,
        path: [...jobPath(job), [label, CATEGORY.Other]],
      });
    };

    let previousEnd = job.start;
    let previousName = null;
    for (const command of sorted) {
      addUntraced(previousEnd, command.start, previousName);
      previousEnd = Math.max(previousEnd, command.end);
      previousName = command.name;
    }
    addUntraced(previousEnd, job.end, previousName);
  }

  for (const round of maintenance) {
    // Maintenance touches several repos; show it on the worker track.
    const thread = threadFor(round.host);
    thread.addMarker(
      'Task',
      rel(round.start),
      rel(round.end),
      {
        type: 'Task',
        name: thread.stringIndex('Idle maintenance'),
        state: thread.stringIndex('MAINTENANCE'),
        repos: thread.stringIndex(round.repos.join(', ')),
        requested: round.requested,
        completed: round.completed === null ? undefined : round.completed,
        budgetReached: thread.stringIndex(round.budgetReached ? 'yes' : 'no'),
        color: TASK_COLORS.MAINTENANCE,
      },
      CATEGORY.Activity
    );
    thread.lando.intervals.push({
      start: round.start,
      end: round.end,
      path: [['Idle maintenance', CATEGORY['Repo maintenance']]],
    });

    // A Task per repo the round actually touched, so the marker chart nests the
    // same way the stack does: round -> repo -> hg command. Their spans come
    // from the commands, since the log says which repos were asked for but not
    // when each one was worked on.
    const byRepo = new Map();
    for (const command of round.commands) {
      const span = byRepo.get(command.repo);
      if (span) {
        span.start = Math.min(span.start, command.start);
        span.end = Math.max(span.end, command.end);
        span.count++;
      } else {
        byRepo.set(command.repo, {
          start: command.start,
          end: command.end,
          count: 1,
        });
      }
    }
    for (const [repo, span] of byRepo) {
      thread.addMarker(
        'Task',
        rel(span.start),
        rel(span.end),
        {
          type: 'Subtask',
          name: thread.stringIndex(repoFrameName(repo)),
          repo: thread.stringIndex(repo),
          commandCount: span.count,
          // Deliberately no colour, like the stage markers: a repo is a level
          // of the nesting rather than an outcome, so there is nothing for a
          // colour to say. Grey is reserved for a task that genuinely has no
          // outcome to report.
        },
        CATEGORY.Activity
      );
    }
  }

  for (const command of commands) {
    const thread = threadFor(command.host);
    const phase = command.phase || commandPhase(command);
    // A failing command is the one thing worth pulling out of Activity in the
    // marker chart. Frames keep their stage colour regardless, below.
    const category = command.error ? CATEGORY.Debugging : CATEGORY.Activity;
    const frameCategory = phaseCategory(phase);
    thread.addMarker(
      'hg',
      rel(command.start),
      rel(command.end),
      {
        type: 'hg',
        // Without the `hg ` prefix, which is the same on every one of these and
        // only eats room in the chart label.
        command: thread.stringIndex(command.name.replace(/^hg /, '')),
        cmdLine: truncate(command.command, 4000),
        repo: thread.stringIndex(command.repo),
        remote: remoteFromCommand(command.command),
        jobId: command.job ? command.job.id : undefined,
        hgPid: command.hgPid,
        output: command.output ? truncate(command.output) : undefined,
        error: command.error ? truncate(command.error) : undefined,
        inferredEnd: command.inferredEnd
          ? thread.stringIndex('yes')
          : undefined,
      },
      category
    );

    const path = [];
    if (command.job) {
      path.push(...jobPath(command.job));
      path.push([phase, frameCategory]);
    } else if (command.maintenance) {
      path.push(['Idle maintenance', CATEGORY['Repo maintenance']]);
      path.push([repoFrameName(command.repo), CATEGORY['Repo maintenance']]);
    } else {
      path.push(['Unattributed hg', CATEGORY.Other]);
    }
    // The leaf frame carries the stage colour, not the marker's category: this
    // is the frame the activity graph spends most of its pixels on.
    path.push([
      command.name,
      command.error ? CATEGORY.Debugging : frameCategory,
    ]);
    thread.lando.intervals.push({ start: command.start, end: command.end, path });
  }

  for (const state of workerStates) {
    const thread = threadFor(state.host);
    thread.addMarker(
      'WorkerState',
      rel(state.time),
      null,
      {
        type: 'WorkerState',
        worker: thread.stringIndex(state.worker),
        state: thread.stringIndex(state.state),
        repoCount: state.repoCount,
      },
      CATEGORY.Debugging
    );
  }

  for (const note of notes) {
    const thread = threadFor(note.host);
    if (note.kind === 'paused') {
      thread.addMarker(
        'Paused',
        rel(note.time),
        rel(note.time + note.duration),
        {
          type: 'Paused',
          label: note.label,
          seconds: note.duration / 1000,
        },
        CATEGORY.Debugging
      );
    } else {
      thread.addMarker(
        'LogError',
        rel(note.time),
        null,
        {
          type: 'LogError',
          label: note.label,
          severity: thread.stringIndex(note.kind === 'warning' ? 'WARNING' : 'ERROR'),
          source: note.source ? thread.stringIndex(note.source) : undefined,
          error: note.error ? truncate(note.error) : undefined,
          traceback: note.traceback ? truncate(note.traceback, 4000) : undefined,
          // Only when the label had to drop something: otherwise it is the
          // same text twice in the tooltip.
          full: note.label.endsWith('…')
            ? truncate(note.message, 4000)
            : undefined,
        },
        CATEGORY.Debugging
      );
    }
  }

  // -- Synthetic samples.
  //
  // The logs are not a sampling profiler, but the call tree and the stack chart
  // are the most useful views for "where does landing time go". The intervals
  // collected above are already well-nested, so instead of ticking a clock we
  // walk their boundaries: between two consecutive boundaries the innermost
  // covering interval does not change, so the segment between them is exactly
  // one run of work, and one sample describes it. Weights are
  // `weightType: 'tracing-ms'` and hold the segment's duration, so the call
  // tree reads as exact wall-clock milliseconds.
  //
  // Each sample also carries a `threadCPUDelta`, which is what makes a sample
  // set this sparse render correctly. The activity graph paints a sample from
  // halfway back to the previous sample to halfway on to the next, and scales
  // the fill by cpuDelta/elapsed over that span -- so without CPU figures every
  // sample is assumed 100% busy and a 26-minute `hg push` beside a one-second
  // command drew as a ramp bleeding into its neighbours. Since a segment is
  // either running a command or idle, the CPU figure is known exactly: the
  // segment's full duration when work is running, zero when nothing is.
  if (options.samples) {
    const idleStack = profile.shared.stackForPath([['idle', CATEGORY['Waiting for work']]]);

    for (const thread of profile.threads) {
      const intervals = (thread.lando && thread.lando.intervals) || [];
      thread.samples.weightType = 'tracing-ms';
      thread.samples.weight = [];
      if (intervals.length === 0) {
        continue;
      }

      const boundaries = new Set([startTime, endTime]);
      for (const item of intervals) {
        boundaries.add(item.start);
        boundaries.add(Math.max(item.start, item.end));
      }
      const times = [...boundaries].sort((a, b) => a - b);

      intervals.sort((a, b) => a.start - b.start);
      const segments = [];
      let lastSampleTime = startTime;
      let cursor = 0;
      let active = [];
      for (let i = 0; i < times.length - 1; i++) {
        const from = times[i];
        const to = times[i + 1];
        while (cursor < intervals.length && intervals[cursor].start <= from) {
          active.push(intervals[cursor++]);
        }
        // A segment is covered by an interval only if the interval is still
        // open at its start; zero-length intervals cover nothing.
        active = active.filter((item) => item.end > from);

        // The innermost interval is the one with the deepest path.
        let best = null;
        for (const item of active) {
          if (!best || item.path.length > best.path.length) {
            best = item;
          }
        }

        let stack = idleStack;
        if (best) {
          if (best.stack === undefined) {
            best.stack = profile.shared.stackForPath(best.path);
          }
          stack = best.stack;
        }

        // The CPU delta belongs to the span *ending* at a sample, so this
        // segment's figure is attached to the sample that closes it, below.
        segments.push({ time: from, stack, duration: to - from, busy: !!best });
      }

      // Each segment is bracketed by a sample at each of its ends, both
      // carrying the segment's own stack. That is what keeps a segment's colour
      // inside the segment: the graph paints a sample from halfway back to the
      // previous sample to halfway on to the next, so with a single sample per
      // boundary every segment's colour would spread half way into each
      // neighbour -- a 26 minute `hg push` next to a one second command painted
      // six minutes of push colour over the idle gap beside it.
      //
      // The closing sample sits one millisecond short of the next segment's
      // start: at the same timestamp it would tie with the next segment's
      // opening sample, and half of this segment would be filled by the next
      // one's colour instead.
      let previousBusy = false;
      for (const segment of segments) {
        const open = segment.time;
        const close = Math.max(open, segment.time + segment.duration - 1);
        // threadCPUDelta describes the span *ending* at a sample, so the
        // opening sample reports the previous segment and the closing sample
        // reports this one. In microseconds, per meta.sampleUnits.
        thread.addSample(
          open - startTime,
          segment.stack,
          previousBusy ? 1000 * (open - lastSampleTime) : 0
        );
        thread.samples.weight.push(close === open ? segment.duration : 0);

        if (close !== open) {
          thread.addSample(
            close - startTime,
            segment.stack,
            segment.busy ? 1000 * (close - open) : 0
          );
          // The whole segment's duration hangs off its closing sample, so the
          // call tree still totals exact wall-clock time.
          thread.samples.weight.push(segment.duration);
          lastSampleTime = close;
        } else {
          lastSampleTime = open;
        }
        previousBusy = segment.busy;
      }
    }
  }

  // Drop tracks carrying neither markers nor samples, so that an empty repo
  // track does not take up room in the timeline. Done before the counters are
  // built, because a counter's `mainThreadIndex` indexes into this array.
  profile.threads = profile.threads.filter(
    (thread) => thread.markers.length > 0 || thread.samples.length > 0
  );

  const counters = buildQueueCounters(queueReadings, startTime, (worker) => {
    // Queue readings name the worker ("try"), not the pod, so find the pod
    // that logged them and hang the counter off that pod's track.
    const reading = queueReadings.find((r) => r.worker === worker);
    const host = reading ? reading.host : hosts[0];
    const mainThreadIndex = profile.threads.indexOf(threads.get(host));
    return {
      pid: String(hostPid.get(host) ?? 1000),
      mainThreadIndex: mainThreadIndex === -1 ? 0 : mainThreadIndex,
    };
  });

  const result = profile.finish();
  if (counters.length) {
    result.counters = counters;
  }

  return {
    profile: result,
    stats: {
      entries: entries.length,
      commands: commands.length,
      inferredEnds: commands.filter((c) => c.inferredEnd).length,
      jobs: jobs.length,
      maintenance: maintenance.length,
      notes: notes.length,
      hosts,
      threads: result.threads.length,
      startTime,
      endTime,
    },
  };
}

// ---------------------------------------------------------------------------
// Opening the profile in the UI
// ---------------------------------------------------------------------------

/**
 * Where a landing job's details live in the Lando web UI. Verified against
 * lando.moz.tools: /landings/<id>/ shows the job, its revisions and the
 * resulting push.
 */
const LANDO_ORIGIN = process.env.LANDO_ORIGIN || 'https://lando.moz.tools';

function landoJobUrl(jobId) {
  return `${LANDO_ORIGIN}/landings/${jobId}/`;
}

const DEFAULT_PROFILER_ORIGIN =
  process.env.PROFILER_ORIGIN || 'https://profiler.firefox.com';

/**
 * The profiler front end fetches the profile itself, so serve it from a
 * throwaway loopback server and hand the front end that URL via `/from-url/`.
 * The server shuts down once the body has actually drained.
 */
function openInProfiler(profileJson, profilerOrigin) {
  // Serialized once: this is megabytes of JSON.
  const body = Buffer.from(profileJson, 'utf8');
  let delivered = false;

  const server = http.createServer((request, response) => {
    // A CORS preflight carries no body and must not be answered with one.
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'Access-Control-Allow-Origin': profilerOrigin,
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Max-Age': '86400',
      });
      response.end();
      return;
    }

    response.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      // Byte count, not character count: the profile contains non-ASCII text.
      'Content-Length': body.length,
      'Access-Control-Allow-Origin': profilerOrigin,
    });

    if (request.method === 'HEAD') {
      response.end();
      return;
    }

    // res.end() only queues the write; closing the server before it drains
    // would truncate the response mid-body.
    response.end(body, () => {
      delivered = true;
    });
  });

  // Bound to the IPv4 loopback explicitly: 'localhost' can resolve to ::1, and
  // the bare IPv6 address makes a URL the front end cannot fetch.
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    const localUrl = `http://127.0.0.1:${port}/lando-profile.json`;
    // `thread=0` makes the front end take the track layout from the URL, which
    // skips the pass that reorders tracks by activity score.
    const url =
      `${profilerOrigin}/from-url/${encodeURIComponent(localUrl)}` +
      '/marker-chart/?thread=0';
    console.log(`Opening ${url}`);
    console.log(`If the browser does not open, visit that URL.`);
    openUrl(url);

    const started = Date.now();
    const poll = setInterval(() => {
      if (delivered || Date.now() - started > 60000) {
        clearInterval(poll);
        server.close();
      }
    }, 100);
  });
}

/**
 * A missing opener makes spawn emit 'error' asynchronously rather than throw,
 * and an unhandled 'error' event would take the process down.
 */
function openUrl(url) {
  const command =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'start'
        : 'xdg-open';
  let child;
  try {
    child = spawn(command, [url], { detached: true, stdio: 'ignore' });
  } catch {
    return;
  }
  child.on('error', () => {});
  child.on('spawn', () => child.unref());
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = {
    files: [],
    output: 'lando-profile.json',
    open: false,
    samples: true,
    profilerOrigin: DEFAULT_PROFILER_ORIGIN,
  };
  let noMoreOptions = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (noMoreOptions) {
      options.files.push(arg);
      continue;
    }
    switch (arg) {
      // The GCP exports are often named like `-24.json`, so allow the usual
      // separator to stop option parsing.
      case '--':
        noMoreOptions = true;
        break;
      case '-h':
      case '--help':
        options.help = true;
        break;
      case '-o':
      case '--output':
        options.output = argv[++i];
        break;
      case '--open':
        options.open = true;
        break;
      case '--no-samples':
        options.samples = false;
        break;
      case '--profiler-origin':
        options.profilerOrigin = argv[++i];
        break;
      default:
        if (arg.startsWith('-') && arg !== '-') {
          throw new Error(`Unknown option: ${arg}`);
        }
        options.files.push(arg);
    }
  }
  return options;
}

const USAGE = `Usage: lando-profiler [options] <logs.json...>

Turns GCP Cloud Logging exports from the Lando landing workers into a Firefox
Profiler profile.

Options:
  -o, --output <file>   Where to write the profile (default lando-profile.json)
      --open            Open the profile in profiler.firefox.com
      --no-samples      Only emit markers, no synthetic samples
      --profiler-origin <url>
                        Profiler front end to open (default
                        https://profiler.firefox.com, or $PROFILER_ORIGIN)
  -h, --help            Show this help
`;

function formatDuration(ms) {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  if (ms < 60000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  return `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`;
}

function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  if (options.help || options.files.length === 0) {
    console.log(USAGE);
    process.exit(options.help ? 0 : 1);
  }

  const raw = readLogFiles(options.files);
  const entries = raw.map(normalizeEntry).filter((e) => Number.isFinite(e.time));
  if (entries.length === 0) {
    console.error('No log entries with usable timestamps were found.');
    process.exit(1);
  }

  const { profile, stats } = buildProfile(entries, options);
  const json = JSON.stringify(profile);
  fs.writeFileSync(options.output, json);

  console.log(`Read ${stats.entries} log entries from ${options.files.length} file(s)`);
  console.log(
    `  ${new Date(stats.startTime).toISOString()} to ${new Date(
      stats.endTime
    ).toISOString()} (${formatDuration(stats.endTime - stats.startTime)})`
  );
  console.log(`  workers: ${stats.hosts.join(', ')}`);
  console.log(`  ${stats.jobs} landing jobs, ${stats.maintenance} maintenance rounds`);
  console.log(
    `  ${stats.commands} hg commands (${stats.inferredEnds} with an inferred end time)`
  );
  console.log(`  ${stats.notes} errors/warnings`);
  console.log(
    `Wrote ${options.output} (${(json.length / 1e6).toFixed(1)} MB, ${
      stats.threads
    } tracks)`
  );

  if (options.open) {
    openInProfiler(json, options.profilerOrigin);
  }
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = {
  readLogFiles,
  normalizeEntry,
  extractHgCommands,
  extractActivities,
  attributeCommands,
  buildProfile,
  hgCommandName,
  commandPhase,
};
