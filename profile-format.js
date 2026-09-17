/**
 * Minimal builder for the Firefox Profiler "processed profile" format (v69).
 *
 * In v69 the stack/frame/func/string tables live in a single top-level `shared`
 * object, shared by every thread. Stack prefixes are stored as *offsets*
 * (`prefixOffset[i] === i - prefix`, and 0 for roots), so a stack's prefix must
 * always have a lower index than the stack itself, which the push order here
 * guarantees.
 */

const PROCESSED_PROFILE_VERSION = 69;
const GECKO_PROFILE_VERSION = 36;

/**
 * The categories colour the timeline and the call tree, so they name the kinds
 * of work a landing worker actually does rather than the Gecko defaults.
 *
 * 'Other' must stay at index 0: a grey category is required by the format, and
 * the first one is used as the fallback for anything uncategorised.
 */
/**
 * Categories colour two different things, which need different granularity:
 *
 * - Stack frames, which drive the timeline's activity graph and the call tree.
 *   Those want a colour per pipeline stage, so the shape of a task is readable
 *   at a glance.
 * - Markers. The marker chart groups stack-based markers by category, so every
 *   activity marker has to share ONE category or a task, its stage and its hg
 *   command are drawn as separate blocks instead of nested. That category is
 *   `Activity`, which also sorts before `Debugging`.
 *
 * So the stage categories below are for frames only; markers use `Activity`.
 */
const CATEGORIES = [
  { name: 'Other', color: 'grey', subcategories: ['Other'] },
  { name: 'Waiting for work', color: 'transparent', subcategories: ['Other'] },
  { name: 'Activity', color: 'purple', subcategories: ['Other'] },
  { name: 'Prepare repo', color: 'orange', subcategories: ['Other'] },
  { name: 'Pull', color: 'lightblue', subcategories: ['Other'] },
  { name: 'Apply patches', color: 'yellow', subcategories: ['Other'] },
  { name: 'Export patches', color: 'brown', subcategories: ['Other'] },
  { name: 'Push', color: 'blue', subcategories: ['Other'] },
  { name: 'Inspect repo', color: 'lightred', subcategories: ['Other'] },
  { name: 'Repo maintenance', color: 'magenta', subcategories: ['Other'] },
  { name: 'Debugging', color: 'red', subcategories: ['Other'] },
];

const CATEGORY = {};
CATEGORIES.forEach((c, i) => {
  CATEGORY[c.name] = i;
});

const MARKER_PHASE = {
  INSTANT: 0,
  INTERVAL: 1,
  INTERVAL_START: 2,
  INTERVAL_END: 3,
};

class StringTable {
  constructor() {
    this.array = [];
    this._indexes = new Map();
  }

  indexForString(s) {
    let index = this._indexes.get(s);
    if (index === undefined) {
      index = this.array.length;
      this.array.push(s);
      this._indexes.set(s, index);
    }
    return index;
  }
}

/**
 * Holds the tables that are shared across all threads of a profile.
 */
class SharedData {
  constructor() {
    this.stringTable = new StringTable();

    this.funcTable = {
      name: [],
      isJS: [],
      relevantForJS: [],
      resource: [],
      source: [],
      lineNumber: [],
      columnNumber: [],
      originalLocation: [],
      length: 0,
    };
    this.frameTable = {
      address: [],
      inlineDepth: [],
      category: [],
      subcategory: [],
      func: [],
      nativeSymbol: [],
      innerWindowID: [],
      line: [],
      column: [],
      originalLocation: [],
      length: 0,
    };
    this.stackTable = { frame: [], prefixOffset: [], length: 0 };

    this._funcIndexes = new Map();
    this._frameIndexes = new Map();
    this._stackIndexes = new Map();
  }

  funcIndex(name) {
    let index = this._funcIndexes.get(name);
    if (index !== undefined) {
      return index;
    }
    index = this.funcTable.length++;
    this.funcTable.name.push(this.stringTable.indexForString(name));
    this.funcTable.isJS.push(false);
    this.funcTable.relevantForJS.push(false);
    this.funcTable.resource.push(-1);
    this.funcTable.source.push(null);
    this.funcTable.lineNumber.push(null);
    this.funcTable.columnNumber.push(null);
    this.funcTable.originalLocation.push(null);
    this._funcIndexes.set(name, index);
    return index;
  }

  frameIndex(name, category = 0) {
    const key = category + ' ' + name;
    let index = this._frameIndexes.get(key);
    if (index !== undefined) {
      return index;
    }
    index = this.frameTable.length++;
    this.frameTable.address.push(-1);
    this.frameTable.inlineDepth.push(0);
    this.frameTable.category.push(category);
    this.frameTable.subcategory.push(0);
    this.frameTable.func.push(this.funcIndex(name));
    this.frameTable.nativeSymbol.push(null);
    this.frameTable.innerWindowID.push(null);
    this.frameTable.line.push(null);
    this.frameTable.column.push(null);
    this.frameTable.originalLocation.push(null);
    this._frameIndexes.set(key, index);
    return index;
  }

  /** Returns the stack index for `name` appended to the stack `prefix`. */
  stackIndex(name, category = 0, prefix = null) {
    const frame = this.frameIndex(name, category);
    const key = prefix + ' ' + frame;
    let index = this._stackIndexes.get(key);
    if (index !== undefined) {
      return index;
    }
    index = this.stackTable.length++;
    this.stackTable.frame.push(frame);
    // A prefix always has a lower index than the stack pointing at it.
    this.stackTable.prefixOffset.push(prefix === null ? 0 : index - prefix);
    this._stackIndexes.set(key, index);
    return index;
  }

  /** Interns a full stack given as an array of [name, category] pairs. */
  stackForPath(path) {
    let stack = null;
    for (const [name, category] of path) {
      stack = this.stackIndex(name, category, stack);
    }
    return stack;
  }

  finish() {
    return {
      stackTable: this.stackTable,
      frameTable: this.frameTable,
      funcTable: this.funcTable,
      resourceTable: { lib: [], name: [], host: [], type: [], length: 0 },
      nativeSymbols: {
        libIndex: [],
        address: [],
        name: [],
        functionSize: [],
        length: 0,
      },
      stringArray: this.stringTable.array,
      // Empty, but every column has to be present: the sanitization the Share
      // button runs reads `sources.content`, and a missing column throws.
      sources: {
        length: 0,
        id: [],
        filename: [],
        startLine: [],
        startColumn: [],
        sourceMapURL: [],
        content: [],
      },
      sourceLocationTable: { source: [], line: [], column: [], length: 0 },
    };
  }
}

class Thread {
  constructor(
    shared,
    {
      name,
      pid,
      tid,
      isMainThread = false,
      processName,
      showMarkersInTimeline = true,
    }
  ) {
    this.shared = shared;
    this.name = name;
    this.pid = String(pid);
    this.tid = tid;
    this.isMainThread = isMainThread;
    this.processName = processName;
    this.showMarkersInTimeline = showMarkersInTimeline;

    this.samples = {
      stack: [],
      time: [],
      weight: null,
      weightType: 'samples',
      length: 0,
    };
    // Filled in only by tracks that report CPU use; see addSample.
    this.cpuDeltas = null;
    this.markers = {
      data: [],
      name: [],
      startTime: [],
      endTime: [],
      phase: [],
      category: [],
      length: 0,
    };
  }

  /**
   * Adds a sample. `cpuDelta` is the CPU time, in the profile's
   * `sampleUnits.threadCPUDelta` unit, used between the *previous* sample and
   * this one -- that is what the front end's activity graph expects, and it is
   * what lets a sparse sample set still render an accurate graph.
   */
  /**
   * Interns a string and returns its index, for marker fields declared with the
   * `unique-string` format. Repeated values are stored once in the profile's
   * string table rather than once per marker.
   */
  stringIndex(s) {
    return this.shared.stringTable.indexForString(s);
  }

  addSample(time, stack, cpuDelta) {
    this.samples.stack.push(stack);
    this.samples.time.push(time);
    this.samples.length++;
    if (cpuDelta !== undefined) {
      if (this.cpuDeltas === null) {
        // Backfill the samples added before the first CPU figure.
        this.cpuDeltas = new Array(this.samples.length - 1).fill(0);
      }
      this.cpuDeltas.push(cpuDelta);
    }
  }

  /**
   * Adds an interval marker, or an instant marker when `endTime` is null.
   */
  addMarker(name, startTime, endTime, data = null, category = 0) {
    this.markers.name.push(this.shared.stringTable.indexForString(name));
    this.markers.startTime.push(startTime);
    this.markers.endTime.push(endTime);
    this.markers.phase.push(
      endTime === null ? MARKER_PHASE.INSTANT : MARKER_PHASE.INTERVAL
    );
    this.markers.category.push(category);
    this.markers.data.push(data);
    this.markers.length++;
  }

  finish() {
    const thread = {
      processType: 'default',
      processStartupTime: 0,
      processShutdownTime: null,
      registerTime: 0,
      unregisterTime: null,
      pausedRanges: [],
      name: this.name,
      isMainThread: this.isMainThread,
      pid: this.pid,
      tid: this.tid,
      samples: this.samples,
      markers: this.markers,
      showMarkersInTimeline: this.showMarkersInTimeline,
    };
    if (this.cpuDeltas !== null) {
      this.samples.threadCPUDelta = this.cpuDeltas;
    }
    if (this.processName !== undefined) {
      thread.processName = this.processName;
    }
    return thread;
  }
}

class ProfileBuilder {
  constructor({ product, interval = 1, startTime = 0, markerSchema = [] }) {
    this.shared = new SharedData();
    this.threads = [];
    this.meta = {
      interval,
      startTime,
      processType: 0,
      categories: CATEGORIES,
      product,
      stackwalk: 0,
      version: GECKO_PROFILE_VERSION,
      preprocessedProfileVersion: PROCESSED_PROFILE_VERSION,
      // There are no native frames to resolve, so the front end should not
      // offer to symbolicate. This also hides the "Symbols: Profile is
      // symbolicated" row from the metadata panel, which reads oddly for a
      // profile built out of log lines.
      symbolicationNotSupported: true,
      markerSchema,
      // 'ms' is not one of the accepted CPU units, so the deltas are emitted
      // in microseconds: a fully busy span of N ms reports N * 1000, which the
      // front end divides by the elapsed ms to get 100%.
      sampleUnits: { time: 'ms', eventDelay: 'ms', threadCPUDelta: 'µs' },
    };
  }

  addThread(options) {
    const thread = new Thread(this.shared, options);
    this.threads.push(thread);
    return thread;
  }

  finish() {
    return {
      meta: this.meta,
      libs: [],
      pages: [],
      shared: this.shared.finish(),
      threads: this.threads.map((t) => t.finish()),
    };
  }
}

module.exports = {
  ProfileBuilder,
  CATEGORY,
  CATEGORIES,
  MARKER_PHASE,
  PROCESSED_PROFILE_VERSION,
};
