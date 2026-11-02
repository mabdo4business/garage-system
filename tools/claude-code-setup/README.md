# Claude Code setup

Project configuration for Claude Code and the CI workflow. These files belong in `.claude/` and `.github/`,
which remote tools are not allowed to write, so they are kept here and installed by you:

```bash
bash tools/claude-code-setup/install.sh
git add .claude .github && git commit -m "Add Claude Code project configuration and CI"
```

| Installed to                           | Purpose                                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `.claude/settings.json`                | Allows test/lint/build commands; denies reading `.env`, `git push`, `npm publish`; Prettier hook |
| `.claude/hooks/format-file.mjs`        | Formats each file Claude edits                                                                   |
| `.claude/skills/start-story/`          | `/start-story <ID>` — plan, implement, test, review, commit one story                            |
| `.claude/skills/add-migration/`        | Schema-change checklist                                                                          |
| `.claude/skills/add-command/`          | State-changing command checklist                                                                 |
| `.claude/agents/integrity-reviewer.md` | Independent reviewer subagent                                                                    |
| `.github/workflows/ci.yml`             | CI: `npm ci`, `npm run check`, `npm run build`                                                   |

After installing, keep editing the files in `.claude/` directly; this folder is only the starting copy.
