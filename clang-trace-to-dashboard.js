#!/usr/bin/env node
/**
 * Convert Clang time-trace JSON files to efficient dashboard format.
 *
 * This generates a high-density JSON file optimized for:
 * - Fast loading in web dashboards
 * - Small file size (string tables, frequency-sorted indices)
 * - Rebuild impact analysis
 * - Timeline visualization
 *
 * Usage: node clang-trace-to-dashboard.js <directory> <output.json>
 */

const fs = require('fs');
const path = require('path');

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
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        const baseName = entry.name.slice(0, -5);
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
 * Extract ExecuteCompiler duration from trace events
 * @param {Object} traceData - The parsed Clang trace JSON
 * @returns {number} Duration in microseconds, or 0 if not found
 */
function extractExecuteCompilerDuration(traceData) {
  const events = traceData.traceEvents || [];

  const executeCompilerBegin = events.find(e => e.name === 'ExecuteCompiler' && e.ph === 'B');
  const executeCompilerEnd = events.find(e => e.name === 'ExecuteCompiler' && e.ph === 'E');

  if (executeCompilerBegin && executeCompilerEnd) {
    return executeCompilerEnd.ts - executeCompilerBegin.ts;
  }

  // Fallback: use 'X' (complete) event format
  const executeCompilerComplete = events.find(e => e.name === 'ExecuteCompiler' && e.ph === 'X');
  if (executeCompilerComplete && executeCompilerComplete.dur) {
    return executeCompilerComplete.dur;
  }

  return 0;
}

/**
 * Parse Clang trace events and extract Source markers with timestamps and durations.
 * @param {Object} traceData - The parsed Clang trace JSON
 * @returns {Array} Array of {file, startTime, endTime, duration} objects
 */
function extractSourceMarkers(traceData) {
  const events = traceData.traceEvents || [];

  const sourceEvents = events.filter(e => e.cat === 'Source' && e.name === 'Source');
  const beginEvents = sourceEvents.filter(e => e.ph === 'b' && e.args && e.args.detail);
  const endEvents = sourceEvents.filter(e => e.ph === 'e');

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

    const matchingEnd = endCandidates.find(e => e.ts > beginEvent.ts);

    if (matchingEnd) {
      intervals.push({
        file: beginEvent.args.detail,
        startTime: beginEvent.ts,
        endTime: matchingEnd.ts,
        duration: matchingEnd.ts - beginEvent.ts
      });

      const idx = endCandidates.indexOf(matchingEnd);
      if (idx !== -1) {
        endCandidates.splice(idx, 1);
      }
    }
  }

  return intervals;
}

/**
 * Build include hierarchy from intervals based on timestamp containment
 * @param {Array} intervals - Array of interval objects
 * @returns {Array} Array with parent relationships added
 */
function buildIncludeHierarchy(intervals) {
  const result = [];

  for (const interval of intervals) {
    // Find the immediate parent (smallest interval that contains this one)
    let immediateParent = null;
    let smallestParentDuration = Infinity;

    for (const other of intervals) {
      if (other !== interval &&
          other.startTime <= interval.startTime &&
          other.endTime >= interval.endTime) {
        // This interval contains our interval
        if (other.duration < smallestParentDuration) {
          immediateParent = other;
          smallestParentDuration = other.duration;
        }
      }
    }

    result.push({
      file: interval.file,
      startTime: interval.startTime,
      endTime: interval.endTime,
      duration: interval.duration,
      parentFile: immediateParent ? immediateParent.file : null
    });
  }

  return result;
}

/**
 * Main processing function
 */
function main() {
  if (process.argv.length < 4) {
    console.error('Usage: node clang-trace-to-dashboard.js <directory> <output.json>');
    console.error('');
    console.error('Converts Clang -ftime-trace JSON files to efficient dashboard format.');
    process.exit(1);
  }

  const inputDir = process.argv[2];
  const outputFile = process.argv[3];

  if (!fs.existsSync(inputDir)) {
    console.error(`Error: Directory '${inputDir}' not found`);
    process.exit(1);
  }

  console.error(`Searching for .json files with matching .o files in ${inputDir}...`);
  const jsonFiles = findMatchingJsonFiles(inputDir);
  console.error(`Found ${jsonFiles.length} matching JSON files`);

  if (jsonFiles.length === 0) {
    console.error('No matching .json/.o file pairs found');
    process.exit(1);
  }

  // Data structures for building the output
  const compilationUnitsData = []; // [{name, buildTime, includes: [...]}]
  const fileUsageCount = new Map(); // file -> count

  console.error('Processing files...');
  let processedCount = 0;

  for (const jsonFile of jsonFiles) {
    try {
      const traceData = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
      const intervals = extractSourceMarkers(traceData);

      if (intervals.length === 0) continue;

      const includesWithHierarchy = buildIncludeHierarchy(intervals);

      // Sort by start time (chronological order)
      includesWithHierarchy.sort((a, b) => a.startTime - b.startTime);

      // Get build time from ExecuteCompiler marker
      const buildTime = extractExecuteCompilerDuration(traceData);

      // Count file usages
      for (const inc of includesWithHierarchy) {
        fileUsageCount.set(inc.file, (fileUsageCount.get(inc.file) || 0) + 1);
        if (inc.parentFile) {
          fileUsageCount.set(inc.parentFile, (fileUsageCount.get(inc.parentFile) || 0) + 1);
        }
      }

      compilationUnitsData.push({
        name: path.basename(jsonFile, '.json'),
        buildTime: buildTime,
        includes: includesWithHierarchy
      });

      processedCount++;
      if (processedCount % 100 === 0) {
        console.error(`  Processed ${processedCount}/${jsonFiles.length} files...`);
      }
    } catch (err) {
      console.error(`  Warning: Failed to process ${jsonFile}: ${err.message}`);
    }
  }

  console.error(`Successfully processed ${processedCount} files`);
  console.error('Building output structure...');

  // Build sorted file table (by usage frequency)
  const filesArray = Array.from(fileUsageCount.entries())
    .sort((a, b) => b[1] - a[1]) // Sort by count descending
    .map(([file, _]) => file);

  const fileToId = new Map();
  filesArray.forEach((file, idx) => {
    fileToId.set(file, idx);
  });

  // Sort compilation units by total include count (number of includes)
  compilationUnitsData.sort((a, b) => b.includes.length - a.includes.length);

  // Build compilation units arrays
  const compilationUnits = {
    names: [],
    buildTimes: []
  };

  for (const cu of compilationUnitsData) {
    compilationUnits.names.push(cu.name);
    compilationUnits.buildTimes.push(Math.round(cu.buildTime / 1000)); // Convert to ms
  }

  // Build includes arrays (parallel arrays indexed by compilation unit)
  // Use differential compression for startTimes
  const includes = {
    fileIds: [],
    startTimes: [],
    durations: [],
    parentFileIds: []
  };
  let totalIncludes = 0;

  for (let cuId = 0; cuId < compilationUnitsData.length; cuId++) {
    const cu = compilationUnitsData[cuId];

    const fileIds = [];
    const startTimes = [];
    const durations = [];
    const parentFileIds = [];

    let prevStartTime = 0;

    for (const inc of cu.includes) {
      fileIds.push(fileToId.get(inc.file));

      // Differential compression for startTimes (in ms)
      const startTimeMs = Math.round(inc.startTime / 1000);
      startTimes.push(startTimeMs - prevStartTime);
      prevStartTime = startTimeMs;

      durations.push(Math.round(inc.duration / 1000)); // Convert to ms
      parentFileIds.push(
        inc.parentFile ? fileToId.get(inc.parentFile) : -1
      );
      totalIncludes++;
    }

    includes.fileIds.push(fileIds);
    includes.startTimes.push(startTimes);
    includes.durations.push(durations);
    includes.parentFileIds.push(parentFileIds);
  }

  // Build output structure
  const output = {
    metadata: {
      generatedAt: new Date().toISOString(),
      totalCompilationUnits: compilationUnitsData.length,
      totalIncludes: totalIncludes,
      totalUniqueHeaders: filesArray.length,
      description: 'Clang compilation time analysis for Firefox'
    },
    compilationUnits: compilationUnits,
    tables: {
      files: filesArray
    },
    includes: includes
  };

  console.error('Writing output...');
  console.error(`  Total compilation units: ${output.metadata.totalCompilationUnits}`);
  console.error(`  Total includes: ${output.metadata.totalIncludes}`);
  console.error(`  Unique headers: ${output.metadata.totalUniqueHeaders}`);

  fs.writeFileSync(outputFile, JSON.stringify(output));

  const fileSizeMB = (fs.statSync(outputFile).size / (1024 * 1024)).toFixed(2);
  console.error(`Done! Output file: ${outputFile} (${fileSizeMB} MB)`);
}

main();
