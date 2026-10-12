---
name: performance
description: Making code faster or lighter - slow pages, queries, builds, frame drops, high memory or CPU. Use when the user reports slowness or asks to optimize.
---

# Performance

## Measure first
- Define the metric and target (latency p95, frame time, memory, build time, bundle size) and a repeatable way to measure it.
- Measure before changing anything: profiler, timing logs, `EXPLAIN` for queries, browser performance tools, Unity Profiler, benchmarks. Optimize the measured hotspot, not the suspected one.

## Usual big wins
- Algorithmic: O(n^2) loops over growing data, repeated searches that want a map/set, recomputation that wants caching or memoization.
- I/O: N+1 queries, missing indexes, chatty network calls (batch them), synchronous I/O on hot paths, missing pagination/streaming.
- Allocation: per-frame or per-request allocations, large copies, string concatenation in loops, boxing; pool or reuse objects in tight loops (games especially).
- Rendering (web): unnecessary re-renders, layout thrashing, huge bundles (code-split, tree-shake), unoptimized images.
- Concurrency: run independent work in parallel; don't block the main/UI thread.

## Guardrails
- Keep behavior identical; keep the code readable. Don't micro-optimize cold code.
- Re-measure after each change and report before/after numbers with the method used. If a change doesn't help, revert it.
