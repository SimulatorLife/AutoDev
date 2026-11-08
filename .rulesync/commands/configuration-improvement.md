---
targets: ["*"]
description: Improve one configuration surface for build, lint, test, or CI ergonomics without changing application behavior.
---

# Improve one configuration surface

Select one configuration surface that can improve build, lint, test, or CI ergonomics without changing application behavior. Inspect the target repository's actual manifests, configuration files, and conventions rather than assuming filenames or tools. Consider both existing configuration that could be improved and settings, constants, or behavior currently defined elsewhere that would be better managed through the repository's established configuration mechanisms. Make one concrete, small, reversible improvement—such as clarifying scripts, wiring a missing check, aligning conflicting tool settings, tightening a CI trigger, documenting an environment requirement, or moving hardcoded or misplaced settings into an appropriate existing configuration file. Follow established conventions, avoid unnecessary new configuration files or abstractions, and preserve existing behavior and defaults. Leave dependency churn and broad refactors to their dedicated prompts, and validate the change with the repository's documented commands.