# clang-includes

Analyze C++ compilation times and header dependencies using Clang's `-ftime-trace` output.

This repository provides tools to understand which headers slow down your C++ builds and which files would need recompilation when a header changes (rebuild impact analysis).

## Tools

1. **clang-trace-to-profiler.js** - Converts to Firefox Profiler format for flame graph visualization
2. **clang-trace-to-dashboard.js** - Converts to efficient JSON format for interactive analysis
3. **dashboard.html** - Interactive web dashboard with rebuild impact analysis and drill-down capabilities

## Overview

When building C++ projects, understanding which headers consume the most compilation time is critical for optimization. These tools:

1. **Parse Clang trace files** - Extract "Source" events (header inclusions) from Clang's time-trace output
2. **Reconstruct include hierarchies** - Build the actual include chains based on event timestamps
3. **Enable different analysis modes**:
   - Firefox Profiler: Visual exploration of flame graphs and call trees
   - Dashboard JSON: Custom analytics, rebuild impact analysis, and targeted queries

## Quick Start

### Tool 1: Firefox Profiler Format

Generate profiles for visual exploration in Firefox Profiler:

**Single File:**
```bash
node clang-trace-to-profiler.js input.json output.json
```

**Full Build:**
```bash
node clang-trace-to-profiler.js /path/to/obj-trace firefox-build-profile.json
```

The script recursively finds all `.json` files that have matching `.o` files and merges them into a single profile.

### Tool 2: Dashboard JSON Format

Generate efficient JSON for custom dashboards:

**Full Build:**
```bash
node clang-trace-to-dashboard.js /path/to/obj-trace build-dashboard.json
```

This creates a highly compressed format optimized for:
- Fast loading in web dashboards
- Rebuild impact analysis (which files need recompiling when a header changes)
- Custom queries and analytics
- Timeline visualization

**Example output (for a large C++ project like Firefox):**
```
Total compilation units: 4359
Total includes: 1,334,271
Unique headers: 26,080
File size: 33.24 MB
```

See [JSON_FORMAT.md](JSON_FORMAT.md) for the complete data structure specification.

### Tool 3: HTML Dashboard

Interactive web dashboard for exploring compilation data:

**View the dashboard:**
```bash
# Make sure your-build-dashboard.json exists, then open in browser:
open dashboard.html
# or
firefox dashboard.html
```

**Note:** Modern browsers block loading local JSON files from `file://` URLs. You have two options:
1. **Firefox Nightly**: Set `security.fileuri.strict_origin_policy` to `false` in `about:config`
2. **Any browser**: Start a local web server (see [Troubleshooting](#troubleshooting) section)

The dashboard provides two main views:

1. **Headers View** - Sorted by rebuild impact
   - Rebuild Impact %: How much of the build would need to recompile if this header changes
   - Include Count: Number of times this header is included across all CUs
   - Max Include Tree Size: Maximum number of headers transitively included by this header
   - **Tree view**: Click any header to expand and see which files directly include it (recursively)
   - **Profile links**: Click values to open Firefox Profiler filtered on that header

2. **Compilation Units View** - Sorted by time spent in includes
   - Build Time: Total compilation time
   - % in Includes: Percentage of build time spent in header processing
   - Include Tree Size: Total number of headers included
   - Time in Includes: Time spent processing headers (with profile links)
   - **Tree view**: Click any CU to expand and see its direct includes, then expand those recursively
   - All profile links open in Firefox Profiler with automatic filtering

Both views support:
- **Search/filter functionality** - Find specific files quickly
- **Sortable columns** - Click any column header to sort
- **Visual bars** - Showing relative magnitudes
- **URL sharing** - Selected view and search terms are stored in URL hash for easy sharing
- **SDK filtering** - Option to show only SDK files directly included by your code (checked by default)

## Which Tool to Use?

### Use HTML Dashboard (dashboard.html) when:
- ✅ You want to **identify headers with highest rebuild impact**
- ✅ You need to **answer "which files should I optimize?"**
- ✅ You want **sortable, filterable tables** of headers and compilation units
- ✅ You need to **drill down into specific CUs** with profiler links
- ✅ You want a **quick, interactive way** to explore the data

**Pros:** Fast, interactive, shows rebuild impact, integrates with profiler
**Cons:** Requires running a local web server for loading the JSON file

### Use Firefox Profiler (clang-trace-to-profiler.js) when:
- ✅ You want to **explore visually** with flame graphs and call trees
- ✅ You need to **quickly identify** the most expensive headers
- ✅ You want to see **temporal distribution** of compilation
- ✅ You're doing **initial investigation** of build performance

**Pros:** Easy to use, powerful visualization, no coding required
**Cons:** Large file size (~500MB-1GB), slower loading, limited custom queries

### Use Dashboard JSON (clang-trace-to-dashboard.js) when:
- ✅ You need **rebuild impact analysis** (which files to recompile when a header changes)
- ✅ You want to build **custom dashboards** with specific metrics
- ✅ You need **fast loading** and low memory usage
- ✅ You want to **query the data programmatically** (e.g., find all CUs that include X)
- ✅ You need **detailed timeline reconstruction** for specific compilation units

**Pros:** Small file size (~33MB), fast loading, flexible queries, complete data
**Cons:** Requires building a custom HTML/JS dashboard to visualize

### Use All Three!
Generate all formats for comprehensive analysis:
```bash
# Generate dashboard JSON for interactive analysis
node clang-trace-to-dashboard.js /path/to/obj-trace build-dashboard.json

# Open the HTML dashboard
open dashboard.html

# Optionally, generate full profiler format for deep exploration
node clang-trace-to-profiler.js /path/to/obj-trace build-profile.json
```

Recommended workflow:
1. **Start with HTML dashboard** - Quickly identify high-impact headers and problematic CUs
2. **Use profile links** - Drill down into specific compilation units with automatic filtering
3. **Generate full profile** (optional) - For comprehensive flame graph analysis of entire build

## How It Works

### 1. Source Marker Extraction

Clang's time-trace output contains begin/end event pairs for each header inclusion:

```json
{"ph":"b", "ts":3470, "cat":"Source", "args":{"detail":"features.h"}}
{"ph":"e", "ts":4274, "cat":"Source"}
```

The script matches these pairs to create intervals representing time spent processing each header.

### 2. Include Hierarchy Reconstruction

Include hierarchies are built purely from timestamps using interval containment:
- If interval A fully contains interval B (A.start ≤ B.start AND A.end ≥ B.end), then A includes B

Example hierarchy:
```
Unified_cpp_dom_canvas1.cpp
  └─ ClientWebGLExtensions.h
      └─ ClientWebGLContext.h
          └─ memory
              └─ stl_algobase.h
                  └─ c++config.h
```

### 3. Self-Time Calculation

To avoid double-counting, each header's weight represents **self-time** (time spent in that header excluding nested includes):

```
self_time = total_duration - sum(direct_children_duration)
```

This ensures that when aggregating across the flame graph, times sum correctly.

### 4. Sequential Timeline Layout

When merging multiple files, timestamps are adjusted so each compilation unit's samples appear sequentially in the timeline:

```
File 1: [0ms ─────────── 1000ms]
File 2:                  [1000ms ─────────── 2500ms]
File 3:                                      [2500ms ─────────── 3200ms]
```

This spreads the data evenly across the profile timeline for better visualization.

### 5. Compilation Unit Tracking

In directory mode, each sample's stack is prefixed with the compilation unit name (filename without `.json`):

```
Unified_cpp_dom_canvas1      ← Compilation unit (root frame)
  └─ WebGL2Context.cpp        ← Source file
      └─ WebGL2Context.h      ← Header chain
          └─ WebGLContext.h
```

This lets you see which compilation units are responsible for including expensive headers.

## Generated Profile Statistics

### Example Statistics

**Single compilation unit:**
- Hundreds to thousands of samples (one per header inclusion)
- Hundreds of unique files included
- Unique include chains showing dependency paths

**Large project build:**
- Millions of samples across entire build
- Tens of thousands of unique files
- Thousands of compilation units
- Hours of aggregated compilation time

## Using Firefox Profiler

1. Open https://profiler.firefox.com/
2. Click "Load a profile from file"
3. Select your generated `.json` file

### Key Views

#### Flame Graph
- **Width** = cumulative time across all inclusions
- **Height** = include hierarchy depth
- **Color** = compilation category
- Identify the widest bars to find most expensive headers

#### Call Tree
- **Total Time** = sum of time for all inclusions under this path
- **Self Time** = time spent in this specific header only
- **Sample Count** = number of times this header was included
- Sort by "Total Time" or "Self Time" to find optimization targets

#### Timeline
- See temporal distribution of compilation units
- Each compilation unit appears as a sequential block
- Useful for understanding build parallelization opportunities

### Analysis Strategies

**Find expensive headers:**
```
Sort Call Tree by "Self Time" descending
→ Shows headers that take longest to compile individually
```

**Find frequently included headers:**
```
Sort Call Tree by "Sample Count" descending
→ Shows headers included most often across the build
```

**Find total impact:**
```
Sort Call Tree by "Total Time" descending
→ Shows headers with highest cumulative cost (frequency × duration)
```

**Trace include chains:**
```
Expand a node in Call Tree
→ See which compilation units and headers lead to this inclusion
```

**Identify optimization candidates:**
```
High sample count + High self time = Prime candidate for:
  - Splitting into smaller headers
  - Moving template implementations to .cpp
  - Reducing dependencies
  - Adding forward declarations
```

## Output Format

The generated profiles use Firefox Profiler's processed profile format (version 57):

- **Samples**: Weighted by self-time (in milliseconds)
- **Stacks**: Represent include hierarchies
- **Frames**: Individual headers
- **Functions**: Header file paths
- **Category**: "Compilation" with "Header Processing" subcategory

## File Structure

```
obj-trace/
├── clang-trace-to-profiler.js       # Main converter script
├── firefox-build-profile.json       # Full build profile (~500MB-1GB)
├── canvas3-profile.json             # Single file examples
├── single-file-test.json
└── dom/
    └── canvas/
        ├── Unified_cpp_dom_canvas2.json  # Clang trace input
        ├── Unified_cpp_dom_canvas2.o     # Matching object file
        └── ...
```

## Clang Trace Generation

To generate trace files during your build:

### Using CMake
```bash
cmake -DCMAKE_CXX_FLAGS="-ftime-trace" -DCMAKE_C_FLAGS="-ftime-trace" ..
make
```

### Using make directly
```bash
make CXXFLAGS="-ftime-trace" CFLAGS="-ftime-trace"
```

Clang will generate a `.json` file alongside each `.o` file containing detailed timing information.

## Requirements

- Node.js (tested with v16+)
- No external dependencies - uses only Node.js built-ins:
  - `fs` - file system operations
  - `path` - path manipulation

## Limitations

### Current Limitations
1. **Self-time calculation is O(n²)** - For files with many includes, calculating direct children can be slow
2. **Memory intensive** - Large build profiles require significant memory
3. **Only processes "Source" events** - Other Clang events (template instantiation, parsing, etc.) are ignored
4. **No deduplication** - Same header included from different paths counted separately

### Known Edge Cases
1. **Precompiled headers** - Not represented in time-trace output
2. **Header guards** - Subsequent inclusions of guarded headers may have zero duration

## Use Cases

### Build Optimization
- Identify headers that should be split or refactored
- Find unnecessary dependencies
- Measure impact of header changes on build time
- Guide decisions about forward declarations vs includes

### Code Review
- Understand build-time impact of new headers
- Compare before/after profiles when refactoring
- Validate that optimizations actually reduce build time

### Education
- Visualize C++ compilation model
- Understand include hierarchies
- Learn which standard library headers are expensive

### Research
- Study large-scale C++ codebases
- Analyze build system characteristics
- Identify common patterns in compilation bottlenecks

## Example Analysis

### Finding the Most Expensive Header

1. Load your generated profile in Firefox Profiler
2. Switch to "Call Tree" view
3. Sort by "Total Time" descending
4. Top entries show headers with highest total impact

Example finding:
```
iostream         - 45,000ms total (15,234 inclusions)
  → Includes many heavy stdlib headers
  → Consider using <iosfwd> or specific stream headers
```

### Tracing an Expensive Include Chain

1. Find expensive header in Call Tree
2. Expand its parent nodes
3. Follow chain back to compilation units
4. Identifies which source files cause the inclusion

This helps you understand why certain headers are included frequently and where to add forward declarations to break expensive dependency chains.

## Troubleshooting

### Dashboard won't load JSON file (CORS error)

**Issue**: Browser console shows "CORS" or "Cross-Origin" error when loading `dashboard.html`

**Solution**: Start a local web server in the `obj-trace` directory:
```bash
# Python 3
python3 -m http.server 8000

# Python 2
python -m SimpleHTTPServer 8000

# Node.js (if you have npx)
npx http-server -p 8000
```

Then open: `http://localhost:8000/dashboard.html`

**Why**: Modern browsers block loading local JSON files from `file://` URLs for security. A local web server serves files over `http://` which doesn't have this restriction.

### Out of memory error

**Issue**: Node.js runs out of memory processing large builds
**Solution**: Increase heap size: `node --max-old-space-size=8192 clang-trace-to-profiler.js ...`

### Missing compilation units

**Issue**: Fewer files processed than expected
**Solution**: Script only processes `.json` files with matching `.o` files. Check that both exist.

## Credits

Originally created for analyzing Mozilla Firefox build times, this tool works with any C++ project using Clang's `-ftime-trace` feature.

**Tools Used:**
- Clang `-ftime-trace` - Compilation time tracing
- Firefox Profiler - Visualization and analysis
- Node.js - Profile generation

**References:**
- [Clang Time Trace Documentation](https://clang.llvm.org/docs/analyzer/developer-docs/PerformanceInvestigation.html#performance-analysis-using-ftime-trace)
- [Firefox Profiler Format](https://github.com/firefox-devtools/profiler/blob/main/docs-developer/processed-profile-format.md)
- [Chrome Trace Event Format](https://docs.google.com/document/d/1CvAClvFfyA5R-PhYUmn5OOQtYMH4h6I0nSsKchNAySU/)

## License

This project is licensed under the Mozilla Public License Version 2.0 - see the [LICENSE](LICENSE) file for details.
