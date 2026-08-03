# Project Agent Scope Suggestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the approved project-agent scope proposal to `suggestion-box.md` without changing runtime behavior.

**Architecture:** This is a documentation-only change. Add one lower-priority suggestion that summarizes the approved discovery, precedence, and confirmation behavior, then renumber the existing lower-priority items so heading numbers remain sequential.

**Tech Stack:** Markdown, Git.

## Global Constraints

- Describe compatibility with Pi's bundled subagent example, not an official Pi standard.
- Keep `user` as the default scope.
- Preserve the built-in `generic` profile as reserved.
- Project profiles override same-named user profiles only in `both` scope.
- Project profile launches require confirmation by default and fail closed when confirmation is unavailable.
- Do not change source code, tests, `README.md`, or package behavior now.
- Require the future feature implementation to update `README.md` with scope, precedence, discovery, and confirmation behavior.

---

### Task 1: Add the project-agent scope suggestion

**Files:**

- Modify: `suggestion-box.md:157-195`
- Reference: `docs/superpowers/specs/2026-08-02-project-agent-scope-design.md`

**Interfaces:**

- Consumes: The approved scope, precedence, and security rules in `docs/superpowers/specs/2026-08-02-project-agent-scope-design.md`.
- Produces: A new lower-priority suggestion titled `Support project-scoped agent profiles`, with the existing lower-priority headings renumbered from 9–12 to 10–13.

- [ ] **Step 1: Insert the approved suggestion**

Immediately after `## Lower-priority wishes`, insert this exact section:

````markdown
### 9. Support project-scoped agent profiles

The agent Markdown schema already matches Pi's bundled subagent example. Extend profile discovery, rather than reformatting profile files, so callers can select a top-level `agentScope` of `user`, `project`, or `both` on `subagent_agents` and `subagent_start`.

Keep `user` as the default. For `project`, discover the nearest `.pi/agents/` directory from the parent session's working directory. For `both`, let a project profile override a user profile with the same name. Keep the built-in `generic` profile reserved and expose each selected profile's `builtin`, `user`, or `project` source without exposing prompts or file paths.

Project profiles are repository-controlled prompts. Confirm once before launching any selected project profiles in a batch. Reject the complete launch when confirmation is declined or unavailable, while allowing a user-controlled `confirmProjectAgents: false` setting for trusted automation.

Use one shared scoped-discovery interface for listing and launching profiles. Preserve the existing background start, status, wait, cancellation, and collection model; do not add the bundled example's synchronous or chain behavior as part of this work.

When implemented, update `README.md` to document the three scopes, default `user` behavior, nearest project-profile discovery, project-over-user precedence, reserved `generic` profile, source labels, and project-agent confirmation configuration.
````

- [ ] **Step 2: Renumber the existing lower-priority headings**

Make these exact heading replacements:

```text
### 9. Optional writable-path restrictions
→ ### 10. Optional writable-path restrictions

### 10. Better support for report artifacts
→ ### 11. Better support for report artifacts

### 11. Clearer result terminology
→ ### 12. Clearer result terminology

### 12. Expose notification and collection state in status
→ ### 13. Expose notification and collection state in status
```

Do not change the text under those existing headings.

- [ ] **Step 3: Verify the Markdown structure and scope**

Run:

```bash
rg -n '^## |^### ' suggestion-box.md
git diff --check
git diff -- suggestion-box.md
```

Expected:

- Lower-priority headings are sequential from 9 through 13.
- The new section says the existing file schema already matches Pi's bundled example.
- The new section includes all three scopes, project-over-user precedence, reserved `generic`, source labels, confirmation, fail-closed behavior, and the trusted-automation setting.
- The new section requires the future implementation to document the complete user-facing behavior in `README.md`.
- No files other than `suggestion-box.md` are included in the implementation diff.
- `git diff --check` exits successfully with no output.

- [ ] **Step 4: Commit the documentation change**

```bash
git add suggestion-box.md
git commit -m "docs: suggest project agent scopes"
```
