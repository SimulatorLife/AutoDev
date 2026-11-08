---
targets: ["*"]
description: Harden one untrusted-input boundary with focused runtime validation or schema checks.
---

# Harden one untrusted-input boundary

Identify a concrete hotspot where we deserialize external data or call a function typed as `any`, `unknown`, or otherwise loosely typed without guarding the input shape. Implement a focused hardening layer that adds runtime validation, schema checks, or default value handling so that malformed payloads are rejected or normalized early. Update or add regression coverage capturing the failure before and the guarded path after. Keep the scope small—address one high-impact site with pragmatic validation while preserving existing API behaviour.
