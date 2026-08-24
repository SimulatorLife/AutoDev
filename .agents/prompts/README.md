# AutoDev generic prompts

Prompts in this directory are repository-agnostic. They may be selected by the
central scheduler or invoked manually through `run-prompt.yml`.

Repository-specific prompts do **not** belong here. Each target repository may
own Markdown prompts under `.agents/prompts/*.md`; invoke those with
`prompt_scope: target` and a target-relative `prompt_path`.

A prompt is plain Markdown and should describe one bounded task. It must not
assume a particular repository layout, package manager, framework, or test
command unless that assumption is part of the task's explicit target profile.
