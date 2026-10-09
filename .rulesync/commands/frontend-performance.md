---
targets: ["*"]
description: Profile and optimize frontend/dashboard performance, eliminate bottlenecks, and prevent regressions.
---

# Audit and optimize frontend performance

Profile, diagnose, and optimize the frontend/UI/dashboard to eliminate significant performance bottlenecks, stalls, and unnecessary latency. For example, view/tab/page navigation taking several seconds; something like should feel instantaneous to the user. Systematically investigate initial load, navigation, rendering, re-renders, component mounting, state management, data fetching, network requests, caching, bundle size, and main-thread blocking. Use profiling and measurements to identify root causes rather than guessing. Prioritize the highest-impact bottlenecks and implement targeted, maintainable fixes using appropriate techniques such as memoization, lazy loading, request deduplication, caching, virtualization, and reduced unnecessary work. Preserve existing functionality, avoid premature optimization or added complexity, and add unit, integration, or performance regression tests where appropriate. **Benchmark before and after changes**, verify improvements under representative conditions, and report the bottlenecks resolved, optimizations made, and measured time savings (absolute and percentage), including remaining performance issues.