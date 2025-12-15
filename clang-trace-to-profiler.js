#!/usr/bin/env node
/**
 * Convert Clang time-trace JSON files to Firefox Profiler format.
 *
 * This script reads Clang's -ftime-trace output and converts the "Source" markers
 * into Firefox Profiler samples. Each header file inclusion becomes a sample with:
 * - Sample count: number of times the header was included
 * - Weight (time): total time spent by compiler processing the header
 *
 * Usage: node clang-trace-to-profiler.js <input.json> <output.json>
 */

const fs = require('fs');
const path = require('path');

/**
 * Parse Clang trace events and extract Source markers with their include hierarchy.
 * @param {Object} traceData - The parsed Clang trace JSON
 * @returns {Array} Array of {file, startTime, endTime, duration, stack} objects
 */
function extractSourceMarkers(traceData) {
  const events = traceData.traceEvents || [];

  // First, collect all begin/end pairs
  const sourceEvents = events.filter(e => e.cat === 'Source' && e.name === 'Source');

  const beginEvents = sourceEvents.filter(e => e.ph === 'b' && e.args && e.args.detail);
  const endEvents = sourceEvents.filter(e => e.ph === 'e');

  // Match begin and end events by their key (pid-tid-id) to create intervals
  const intervals = [];
  const endMap = new Map();

  // Index end events by their key
  for (const endEvent of endEvents) {
    const key = `${endEvent.pid}-${endEvent.tid}-${endEvent.id}`;
    if (!endMap.has(key)) {
      endMap.set(key, []);
    }
    endMap.get(key).push(endEvent);
  }

  // Match each begin with its corresponding end
  for (const beginEvent of beginEvents) {
    const key = `${beginEvent.pid}-${beginEvent.tid}-${beginEvent.id}`;
    const endCandidates = endMap.get(key) || [];

    // Find the end event that matches this begin (should have ts > begin.ts)
    // Since ids are reused, match the closest end event after this begin
    const matchingEnd = endCandidates.find(e => e.ts > beginEvent.ts);

    if (matchingEnd) {
      intervals.push({
        file: beginEvent.args.detail,
        startTime: beginEvent.ts,
        endTime: matchingEnd.ts,
        duration: matchingEnd.ts - beginEvent.ts
      });

      // Remove the matched end to avoid reusing it
      const idx = endCandidates.indexOf(matchingEnd);
      if (idx !== -1) {
        endCandidates.splice(idx, 1);
      }
    }
  }

  // Now build the include hierarchy by looking at which intervals contain which
  // For each interval, find all intervals that contain it (started before and ended after)
  // We create a sample for EVERY Source marker in the input
  const sourceMarkers = [];

  for (const interval of intervals) {
    const stack = [];

    // Find all intervals that contain this one (its include chain)
    for (const other of intervals) {
      if (other !== interval &&
          other.startTime <= interval.startTime &&
          other.endTime >= interval.endTime) {
        stack.push(other);
      }
    }

    // Sort by start time (outermost first)
    stack.sort((a, b) => a.startTime - b.startTime);

    // Add the current file at the end so it appears as the leaf
    stack.push(interval);

    // Calculate self-time: duration minus time spent in directly contained intervals
    // This avoids double-counting when we create samples for every marker
    let childrenTime = 0;
    for (const other of intervals) {
      if (other !== interval &&
          interval.startTime <= other.startTime &&
          interval.endTime >= other.endTime) {
        // Check if this is a DIRECT child (no intermediate intervals)
        let isDirect = true;
        for (const middle of intervals) {
          if (middle !== interval && middle !== other &&
              interval.startTime <= middle.startTime &&
              interval.endTime >= middle.endTime &&
              middle.startTime <= other.startTime &&
              middle.endTime >= other.endTime) {
            isDirect = false;
            break;
          }
        }
        if (isDirect) {
          childrenTime += other.duration;
        }
      }
    }

    const selfTime = interval.duration - childrenTime;

    sourceMarkers.push({
      file: interval.file,
      startTime: interval.startTime,
      endTime: interval.endTime,
      duration: selfTime,  // Use self-time instead of total duration
      stack: stack.map(s => s.file)
    });
  }

  return sourceMarkers;
}

/**
 * Get a short name for a file (just the filename, not the full path)
 * This makes the UI more readable
 * @param {string} filePath - The file path
 * @returns {string} The filename or path
 */
function getDisplayName(filePath) {
  return path.basename(filePath);
}

/**
 * Convert source markers to Firefox Profiler format.
 * @param {Array} sourceMarkers - Array of source marker objects with optional compilationUnit
 * @param {string} inputFileName - Name of the input file for metadata
 * @returns {Object} Firefox Profiler format profile
 */
function convertToProfiler(sourceMarkers, inputFileName) {
  // Sort markers by end time (when we'll create the sample)
  sourceMarkers.sort((a, b) => a.endTime - b.endTime);

  if (sourceMarkers.length === 0) {
    console.warn('Warning: No Source markers found in trace file');
  }

  // String table for deduplication
  const stringTable = [''];  // Index 0 is empty string
  const stringMap = new Map([['', 0]]);

  function addString(str) {
    if (stringMap.has(str)) {
      return stringMap.get(str);
    }
    const index = stringTable.length;
    stringTable.push(str);
    stringMap.set(str, index);
    return index;
  }

  // Tables
  const frameTable = {
    address: [],
    inlineDepth: [],
    category: [],
    subcategory: [],
    func: [],
    nativeSymbol: [],
    innerWindowID: [],
    line: [],
    column: [],
    length: 0
  };

  const funcTable = {
    name: [],
    isJS: [],
    relevantForJS: [],
    resource: [],
    fileName: [],
    lineNumber: [],
    columnNumber: [],
    length: 0
  };

  const stackTable = {
    frame: [],
    prefix: [],
    length: 0
  };

  const samples = {
    stack: [],
    time: [],
    weight: [],
    weightType: 'tracing-ms',
    length: 0
  };

  const resourceTable = {
    lib: [],
    name: [],
    host: [],
    type: [],
    length: 0
  };

  // Create a category for compilation
  const categories = [
    {
      name: 'Other',
      color: 'grey',
      subcategories: ['Other']
    },
    {
      name: 'Compilation',
      color: 'blue',
      subcategories: ['Other', 'Header Processing']
    }
  ];

  const compilationCategory = 1;
  const headerSubcategory = 1;

  // Cache for frames, funcs, and stacks
  const frameCache = new Map();
  const funcCache = new Map();
  const stackCache = new Map();

  function getOrCreateFunc(name) {
    if (funcCache.has(name)) {
      return funcCache.get(name);
    }

    const funcIndex = funcTable.length;
    const nameIndex = addString(name);
    funcTable.name.push(nameIndex);
    funcTable.isJS.push(false);
    funcTable.relevantForJS.push(false);
    funcTable.resource.push(-1);
    funcTable.fileName.push(nameIndex);  // fileName is the same as name for our purposes
    funcTable.lineNumber.push(null);
    funcTable.columnNumber.push(null);
    funcTable.length++;

    funcCache.set(name, funcIndex);
    return funcIndex;
  }

  function getOrCreateFrame(name) {
    if (frameCache.has(name)) {
      return frameCache.get(name);
    }

    const funcIndex = getOrCreateFunc(name);
    const frameIndex = frameTable.length;

    frameTable.address.push(-1);
    frameTable.inlineDepth.push(0);
    frameTable.category.push(compilationCategory);
    frameTable.subcategory.push(headerSubcategory);
    frameTable.func.push(funcIndex);
    frameTable.nativeSymbol.push(null);
    frameTable.innerWindowID.push(null);
    frameTable.line.push(null);
    frameTable.column.push(null);
    frameTable.length++;

    frameCache.set(name, frameIndex);
    return frameIndex;
  }

  function getOrCreateStack(frameIndex, prefixStack) {
    const key = `${frameIndex}-${prefixStack !== null ? prefixStack : 'null'}`;
    if (stackCache.has(key)) {
      return stackCache.get(key);
    }

    const stackIndex = stackTable.length;
    stackTable.frame.push(frameIndex);
    stackTable.prefix.push(prefixStack);
    stackTable.length++;

    stackCache.set(key, stackIndex);
    return stackIndex;
  }

  // Convert microseconds to milliseconds
  const startTimeMs = sourceMarkers.length > 0 ? sourceMarkers[0].startTime / 1000 : 0;

  // Process each source marker
  for (const marker of sourceMarkers) {
    // Use the actual include stack from the trace data
    // marker.stack contains the full include hierarchy
    const includeStack = marker.stack;

    // Build the profiler stack from the include hierarchy
    let currentStack = null;

    // If marker has a compilation unit, use it as the root frame
    if (marker.compilationUnit) {
      const frameIndex = getOrCreateFrame(marker.compilationUnit);
      currentStack = getOrCreateStack(frameIndex, null);
    }

    for (const filePath of includeStack) {
      // Use the full path as the frame name
      const frameIndex = getOrCreateFrame(filePath);
      currentStack = getOrCreateStack(frameIndex, currentStack);
    }

    // Add sample at the end time with duration as weight
    const timeMs = marker.endTime / 1000;  // Convert microseconds to milliseconds
    const durationMs = marker.duration / 1000;  // Convert microseconds to milliseconds

    samples.stack.push(currentStack);
    samples.time.push(timeMs);
    samples.weight.push(durationMs);
    samples.length++;
  }

  // Build the profile
  const now = Date.now();
  const profile = {
    meta: {
      interval: 1,
      startTime: now,
      endTime: now + (samples.length > 0 ? samples.time[samples.length - 1] : 0),
      processType: 0,
      product: 'clang-trace-converter',
      stackwalk: 0,
      debug: false,
      version: 28,
      preprocessedProfileVersion: 57,
      categories: categories,
      markerSchema: [],
      sampleUnits: {
        time: 'ms',
        eventDelay: 'ms',
        threadCPUDelta: 'µs'
      },
      symbolicationNotSupported: true,
      sourceCodeIsNotOnSearchfox: true,
      usesOnlyOneStackType: true,
      importedFrom: 'clang-time-trace',
      arguments: inputFileName
    },
    libs: [],
    shared: {
      stringArray: stringTable
    },
    threads: [
      {
        processType: 'default',
        processStartupTime: 0,
        processShutdownTime: null,
        registerTime: 0,
        unregisterTime: null,
        pausedRanges: [],
        name: `Clang compilation: ${path.basename(inputFileName)}`,
        isMainThread: true,
        pid: '0',
        tid: 0,
        samples: samples,
        markers: {
          data: [],
          name: [],
          startTime: [],
          endTime: [],
          phase: [],
          category: [],
          length: 0
        },
        stackTable: stackTable,
        frameTable: frameTable,
        funcTable: funcTable,
        resourceTable: resourceTable,
        nativeSymbols: {
          libIndex: [],
          address: [],
          name: [],
          functionSize: [],
          length: 0
        }
      }
    ]
  };

  return profile;
}

/**
 * Recursively find all .json files that have a matching .o file
 * @param {string} dir - Directory to search
 * @returns {Array<string>} Array of JSON file paths
 */
function findMatchingJsonFiles(dir) {
  const results = [];

  function walk(currentDir) {
    let entries;
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch (err) {
      // Skip directories we can't read
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        // Check if there's a matching .o file
        const baseName = entry.name.slice(0, -5); // Remove .json
        const oFile = path.join(currentDir, baseName + '.o');

        if (fs.existsSync(oFile)) {
          results.push(fullPath);
        }
      }
    }
  }

  walk(dir);
  return results;
}

/**
 * Merge multiple source marker arrays into a single profile
 * Adjusts timestamps so each file's samples come after the previous file's samples
 * @param {Array} allSourceMarkers - Array of {file: string, markers: Array} objects
 * @param {string} outputName - Name for the output
 * @returns {Object} Combined Firefox Profiler format profile
 */
function mergeIntoProfile(allSourceMarkers, outputName) {
  // Adjust timestamps so files are laid out sequentially in time
  let timeOffset = 0;

  for (const { file, markers } of allSourceMarkers) {
    if (markers.length === 0) continue;

    // Find the duration of this compilation unit (max endTime across all its markers)
    let maxEndTime = 0;
    for (const marker of markers) {
      if (marker.endTime > maxEndTime) {
        maxEndTime = marker.endTime;
      }
    }

    // Adjust all timestamps for this file
    for (const marker of markers) {
      marker.startTime += timeOffset;
      marker.endTime += timeOffset;
    }

    // Next file starts after this one ends
    timeOffset += maxEndTime;
  }

  // Combine all markers
  const allMarkers = [];
  for (const { file, markers } of allSourceMarkers) {
    allMarkers.push(...markers);
  }

  console.error(`Total markers across all files: ${allMarkers.length}`);

  return convertToProfiler(allMarkers, outputName);
}

/**
 * Main function
 */
function main() {
  if (process.argv.length < 3) {
    console.error('Usage: node clang-trace-to-profiler.js <input.json|directory> [output.json]');
    console.error('');
    console.error('Converts Clang -ftime-trace JSON files to Firefox Profiler format.');
    console.error('');
    console.error('If input is a directory, recursively finds all .json files with matching .o files');
    console.error('and merges them into a single profile.');
    console.error('');
    console.error('If output.json is not specified, writes to stdout.');
    process.exit(1);
  }

  const input = process.argv[2];
  const outputFile = process.argv[3];

  if (!fs.existsSync(input)) {
    console.error(`Error: Input '${input}' not found`);
    process.exit(1);
  }

  const stat = fs.statSync(input);
  let profile;

  if (stat.isDirectory()) {
    // Directory mode - find and merge all matching .json files
    console.error(`Searching for .json files with matching .o files in ${input}...`);
    const jsonFiles = findMatchingJsonFiles(input);
    console.error(`Found ${jsonFiles.length} matching JSON files`);

    if (jsonFiles.length === 0) {
      console.error('No matching .json/.o file pairs found');
      process.exit(1);
    }

    const allSourceMarkers = [];
    let processedCount = 0;

    for (const jsonFile of jsonFiles) {
      try {
        const traceData = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
        const sourceMarkers = extractSourceMarkers(traceData);

        if (sourceMarkers.length > 0) {
          // Add compilation unit name (filename without .json extension) to each marker
          const compilationUnit = path.basename(jsonFile, '.json');
          for (const marker of sourceMarkers) {
            marker.compilationUnit = compilationUnit;
          }

          allSourceMarkers.push({ file: jsonFile, markers: sourceMarkers });
          processedCount++;

          if (processedCount % 100 === 0) {
            console.error(`  Processed ${processedCount}/${jsonFiles.length} files...`);
          }
        }
      } catch (err) {
        console.error(`  Warning: Failed to process ${jsonFile}: ${err.message}`);
      }
    }

    console.error(`Successfully processed ${processedCount} files`);
    console.error('Merging into single profile...');
    profile = mergeIntoProfile(allSourceMarkers, 'Firefox Build');

  } else {
    // Single file mode
    console.error(`Reading ${input}...`);
    const traceData = JSON.parse(fs.readFileSync(input, 'utf8'));

    console.error('Extracting Source markers...');
    const sourceMarkers = extractSourceMarkers(traceData);
    console.error(`Found ${sourceMarkers.length} source markers`);

    console.error('Converting to Firefox Profiler format...');
    profile = convertToProfiler(sourceMarkers, input);
  }

  console.error(`Profile contains:`);
  console.error(`  - ${profile.threads[0].samples.length} samples`);
  console.error(`  - ${profile.threads[0].funcTable.length} unique files`);
  console.error(`  - ${profile.threads[0].stackTable.length} unique stacks`);

  const output = JSON.stringify(profile);

  if (outputFile) {
    console.error(`Writing to ${outputFile}...`);
    fs.writeFileSync(outputFile, output);
    console.error('Done!');
    console.error('');
    console.error(`Open in Firefox Profiler: https://profiler.firefox.com/from-url/${encodeURIComponent('file://' + path.resolve(outputFile))}`);
  } else {
    console.log(output);
  }
}

main();
