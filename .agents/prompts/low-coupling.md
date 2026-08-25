# Reduce one unstable dependency coupling

Audit the target repository for one unstable coupling, such as deep private imports, an internal-module dependency, or a high-level component constructing a low-level adapter directly. Replace it with the smallest stable public contract, facade, or dependency boundary that preserves behavior. Do not assume a module naming convention or add an abstraction without a concrete consumer. Update tests/docs as needed and validate the affected path.
