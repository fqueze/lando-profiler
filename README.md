# lando-profiler

Turns GCP Cloud Logging exports from the [Lando](https://lando.moz.tools/)
landing workers into [Firefox Profiler](https://profiler.firefox.com) profiles, so
that "where does landing time actually go?" becomes a call tree and a timeline
instead of 24 hours of log lines.

## Usage

```sh
# The GCP exports are usually named like -24.json, so pass them after `--`.
node index.js --open -- -24.json -18.json -12.json -6.json

# Or just write the profile out and load it into profiler.firefox.com by hand.
node index.js -o lando-profile.json -- *.json
```

Options:

| Option | Meaning |
| --- | --- |
| `-o, --output <file>` | Where to write the profile (default `lando-profile.json`) |
| `--open` | Serve the profile from a throwaway local server and open it in the profiler |
| `--no-samples` | Emit only markers, no synthetic samples |
| `--profiler-origin <url>` | Front end to open; also `$PROFILER_ORIGIN`. Use `http://localhost:4242` for a local profiler checkout |

The input is whatever the GCP Logs Explorer "Download JSON" button produces: a
JSON array of log entries. Several files can be passed at once; they are merged,
sorted by timestamp and de-duplicated on `insertId`, so overlapping exports are
fine.

## What it reads

The landing workers log enough to reconstruct their timeline exactly:

- **`running hg command #<uuid>: <cmd>`** / **`output from hg command #<uuid>: ...`**
  bracket a Mercurial invocation, keyed by a UUID, which gives an exact duration
  for the commands that log output — about half of them; see below for the rest.
- **`Starting LandingJob <id> [SUBMITTED]`** / **`Finished processing LandingJob
  <id> [LANDED]`** bracket each job.
- **`Starting idle maintenance for N repo(s): [...]`** /
  **`Finished idle maintenance for ...`** bracket the housekeeping the worker
  does between jobs.
- **`Queue size for worker try is N (...)`** every ~10s becomes a counter track.
  Note this depth is per *worker*, not per repo: one worker serves every repo it
  is configured for (`LandingWorker try [RUNNING] [3 repos]`) and the log reports
  a single number for all of them, so there is no per-repo breakdown to be had.
- `ERROR`/`WARNING` entries, including the `Fields.exc` traceback, become
  markers.

`Fields.path` tells us which repo clone a command ran against, and the
`<repo>/mots.yaml found` line tells us which repo a job is landing to.

### Inferred end times

Only commands that print something log an `output from hg command` line, so
roughly half of them have no explicit end. Commands on a worker are strictly
serialized, though — verified across 24h of logs, zero overlaps — so the next
log line from that worker bounds the previous command. Those commands are marked
`End time inferred: yes` in their tooltip.

An inferred end is an upper bound, but a tight one, since the next line is
usually the following `running hg command`. The commands affected are the ones
that are silent by design (`commit`, `purge`, `revert`, `export`); anything that
talks to a remote prints its output and so is timed exactly. The run summary
reports how many commands fell back to inference.

## What it produces

**Tracks.** One track per worker pod, and nothing finer.

A landing worker does one thing at a time. Verified across a 24h export: no hg
command overlaps another, and no job or maintenance round overlaps another. So everything the worker did belongs on a single serial timeline. An
earlier version of this tool gave each repo clone its own track, which drew a
maintenance round running `hg strip` against `try`, then `try-comm-central`, then
`production-repo` as three things happening at once. The repo is a level in the
stack instead, where it still lets you split time by repo without implying
concurrency.

**Markers.** `Task` and `hg` for the work, plus `LogError`, `WorkerState` and
`Paused` for the worker's diagnostics.

`Task` is anything the worker set out to do, at every level of the nesting: a
landing job or a round of idle maintenance, then the repo being worked on, then
the stage that is running. All the levels share the name so the nesting reads as
one thing, and so that `hg` sorts last and lands at the bottom of the chart:

```
Task     Landing job 89766        Task     Idle maintenance
Task     repo: try                Task     repo: try
Task     Push                     hg       strip
hg       push
```

A landing's marker is labelled with its job id, and carries a `Details` link to
its page in the Lando web UI (`https://lando.moz.tools/landings/<id>/`;
override the origin with `$LANDO_ORIGIN`).

Colour on a `Task` means "this is how it ended", and only tasks that ended carry
one, through `colorField`: green for `LANDED`, red for `FAILED`, orange for
`DEFERRED`, and grey for an idle maintenance round or a job the log window cut
off — the two cases with no outcome to report. The repo and stage levels are
left uncoloured, because they are levels of the nesting rather than outcomes;
giving them a hue of their own made a row of them change colour every few
pixels, which said nothing the label did not and drowned out the failures. On a
a normal day nearly all of them are green, so the few that are not are what you
want to spot.

Two stages carry no hg commands at all: `Unknown (before first hg)` and
`Unknown (after push)`. Every job has one of each, and together they were a tenth
of all job time in the export this was built against — so they are named rather
than left as holes in the stack chart, which would read as the worker idling.

What they are is an open question; the log is silent in both windows. What the
data does show is that the cost tracks the *repository*, not the step: on `try`
each stretch is ~6.5s, while on `try-comm-central` the same steps take ~0.8s.
On try-comm-central the post-push bookkeeping that does get logged — saving the
push, notifying Pulse — is all logged within 0.25s of the push output, so it is
not what fills the gap. That points at something proportional to the size of the
working directory rather than to the job, but the logs do not say what, which is
why the markers do not claim to know.

The two stages that move patches say how many: `Apply patches (7 patches)`,
`Export patches (3 patches)`. That is the count of patches, not of commands —
applying a patch takes an `hg import` and an `hg commit`, so a 7-patch stage
runs 14 of them. (The import and commit counts agree for every job in a 24h
export, so either would serve; `import` is the one that applies the patch.)

`hg` carries `command` (the subcommand alone, e.g. `push` — the `hg ` prefix is
the same on every marker and only eats room in the chart label) and `cmdLine`
(the whole command line), plus the repo, the remote, the output and any error.

Only the top-level tasks — the landings and the maintenance rounds — appear in
the timeline overview strip. The levels nested under them are named `Task` too,
but typed `Subtask` so they resolve to a schema that leaves them out: the strip
is one thin row for a whole day, and the subtasks, hg commands and log errors
under them turned it into a solid band. The front end picks a marker's schema
from its payload `type` rather than its name, which is what makes that split
possible without breaking the nesting.

The three diagnostic kinds keep names of their own, since they are genuinely
different things and the marker table is easier to read for it. What they share
is the `Debugging` *category*, which is what keeps them out of the way of the
activity markers. Most of it is noise: on a typical day the bulk is
`hg strip: abort: empty revision set`, which just means there was nothing to
strip.

Task and hg markers are `isStackBased`, so the marker chart nests them.
Repeated field values — repo names, outcomes, subcommands, stages — are declared
`unique-string` and interned, so they are stored once in the profile's string
table rather than once per marker.

**Categories.** Categories colour two different things, and the two need
different granularity:

- **Stack frames** drive the timeline's activity graph and the call tree, so
  they get a colour per pipeline stage: `Prepare repo` (orange), `Pull`
  (lightblue), `Apply patches` (yellow), `Export patches` (brown), `Push`
  (blue), `Inspect repo` (lightred), `Repo maintenance` (magenta). Both the
  stage frame and the `hg` command under it carry the stage's category, since
  the leaf is where the activity graph spends most of its pixels.
- **Markers** all share one `Activity` category. The marker chart groups
  stack-based markers by category, so giving each stage its own stopped a task,
  its stage and its hg command from nesting under each other — they were drawn
  as separate blocks. `Activity` also sorts before `Debugging`, so the work
  comes first.

Plus `Debugging` (red) for the worker's own diagnostics and failing commands,
`Waiting for work` (transparent, so idle gaps draw as nothing) and the
format-required grey `Other`.

Conflating the two is an easy mistake to make in both directions: per-stage
marker categories break the nesting, and one flat frame category turns the whole
timeline purple. `test.js` pins both halves.

**Samples.** The logs are not a sampling profiler, but the call tree and stack
chart are the most useful views for apportioning time. Since the intervals above
are well-nested, the tool walks their boundaries rather than ticking a clock:
between two consecutive boundaries the innermost interval does not change, so
that segment is one run of work with a single stack. Weights are
`weightType: 'tracing-ms'` and sum to each segment's exact duration, so the call
tree reads as exact wall-clock milliseconds.

Two details make that sparse sample set render correctly, both of which follow
from how the activity graph paints: a sample covers from halfway back to the
previous sample to halfway on to the next, scaled by `cpuDelta / elapsed`.

- **Each segment is bracketed by a sample at both of its ends**, rather than one
  sample per boundary. Otherwise every segment's colour spreads half way into
  each neighbour: measured by regenerating that export with one sample per
  segment, a work sample painted up to 13 minutes past the end of its own
  segment, against 0 with the brackets. The closing sample sits one millisecond short of the
  next segment's start, so the two do not tie.
- **Each sample carries a `threadCPUDelta`.** With no CPU figures the front end
  assumes every sample is 100% busy. A segment is either running a command or
  idle, so the figure is known exactly: the segment's duration when work is
  running, zero when nothing is.

Both come from measured boundaries; no samples are invented to fill time: there
are two per segment, and nothing in between.

Stacks are `LandingJob` → `repo: <name>` → phase → `hg <subcommand>`, or
`Idle maintenance` → `repo: <name>` → `hg <subcommand>` for the housekeeping.

The job frame carries no job id: a frame name is what the call tree and the
flame graph aggregate on, so a per-job name gave every job its own sliver
instead of showing where landing time goes across the day. Per-job detail lives
on the `Task` marker, so a whole export collapses to a few dozen frames.

So the non-inverted tree answers "how is landing time split across the phases?",
inverting it answers "which hg command dominates?", and the marker chart or
marker table is where you go to find a specific slow job.

**Counter track.** Landing queue depth over time, one per worker.

## Reading the profile

- **Invert the call stack** to rank hg subcommands by total time across the
  whole export.
- **Leave it uninverted** to drill from a slow job into the phase and command
  responsible.
- **Search the marker table** to slice by anything in an `hg` payload — the
  output text is in there, so `waiting for lock` finds pushes that blocked on
  the remote repository lock, and `abort:` finds failing commands.
- **Select a range** in the timeline to restrict the call tree to it; the queue
  counter track shows when the worker was backed up.

## Files

- `index.js` — log parsing, activity reconstruction and profile assembly.
- `profile-format.js` — a small builder for the Firefox Profiler processed
  format (v69), with the shared string/func/frame/stack tables. Reusable for
  other log-to-profile tools.
- `test.js` — parsing and profile-structure tests: `node test.js`.

## Verifying a change

`test.js` checks the format invariants, but the authoritative check is to load
the profile with a real client. `profiler-cli`, built from a profiler checkout,
is the quickest one:

```sh
cd ../profiler && NODE_ENV=production node scripts/build-profiler-cli.mjs
cd -
node ../profiler/profiler-cli/dist/profiler-cli.js load lando-profile.json
node ../profiler/profiler-cli/dist/profiler-cli.js counter list
node ../profiler/profiler-cli/dist/profiler-cli.js thread functions --search 'hg '
```

It exercises the same code the web front end does, so it catches the kind of
breakage a structural check misses — a required field the front end dereferences
while building the UI, for instance.

## Notes on the profile format

The tool emits `preprocessedProfileVersion: 69`, where the stack, frame, func
and string tables live in a single top-level `shared` object and stack prefixes
are stored as offsets (`prefixOffset[i] === i - prefix`, `0` for roots). Stacks
are therefore always interned parent-first, which keeps every prefix at a lower
index than its children.

Two things that are easy to get wrong when writing this format by hand, both of
which the front end only trips over well after loading:

- **Every column of the shared tables must be present, even when the table is
  empty.** Sharing a profile always rewrites source contents, so a `sources`
  table missing its `content` column throws in the Share dialog rather than at
  load time.
- **Counters need a `display` config** (required since v63). The upgraders
  back-fill it only for profiles declaring an older version, so a profile that
  claims to be current has to supply its own.
