You have access to skills; read them and use those applicable.

Ensure to update any documentation and tests accordingly to your changes.

Don't add any legacy support or wrappers; just remove obsolete paths, collapse transitional layers, migrate remaining call sites to the new APIs, delete deprecated utilities, update tests to reflect the new ownership boundaries, and ensure the workspace responsibilities/boundaries strictly match the target/documented split without compatibility shims.

Never make 'band-aid' fixes; always address the issues/bugs at the source instead of trying to catch/fix downstream, even if this results in a larger diff/churn.

When fixing performance test failures, do NOT relax the criteria; always optimize the codebase's implementation as/where possible to allow performance test to pass against their existing constraints. Don't lower the performance requirements/thresholds just so that the tests are green; actually make the proper optimizations.

Other agents/processes may be making simultaneous edits/changes to this codebase. Do not be alarmed or stop; just focus on your own task and do not discard those external changes.