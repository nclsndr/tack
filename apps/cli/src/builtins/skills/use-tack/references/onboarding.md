# Onboard a machine to Tack

Follow this when Tack was just installed or someone asks you to set it up. Do the steps in order.
Skip a step whose outcome already holds: `tack init` and `tack status` show what holds.

## Mode

Who reads your replies:

- Guided (default): a person reads them. Ask the questions marked Ask.
- Worker: only when your instructions say no person will answer (unattended, non-interactive, a
  worker or CI run), or the environment variable `CI` is set. Do not explain or ask. Take answers
  from your instructions. When a step needs an answer they do not give, skip that step and list it
  in your final report. Never guess a source folder or a project.

Depth, chosen after step 1:

- Quick: steps 1, 3, 5, 6, 6b and 7, for the folders and the project the person named.
- Full: every step, including the model, scope picks, more projects and team repositories.
- Start quick when the request already names the folders and the project, and say full is
  available. Otherwise offer both in one line, such as: "Quick setup links ~/skills into this
  project in a few commands. Full setup also covers which skills go everywhere, more projects,
  team repositories and Git. Which one?" Worker mode is always quick.

## Talking to a person (guided)

- Before each step, say in one plain sentence why it matters to them, then what it changes on
  their machine. Each step below gives the why.
- Use plain words: "a folder of skills", "links back to your files", "your agents". Name a Tack
  term (source, project, user scope) only with its meaning beside it.
- Report a preview with its counts first ("8 links for Claude Code and Codex, 1 folder of yours
  left alone"), then the detail that needs a decision: conflicts, hand-made entries, missing
  skills. Give the full list when asked.
- End with step 7's summary.

## Approvals

- One yes per step that changes something: Machine, Sources, Scope, Projects, Link, and the
  agent instructions of step 6b.
- Before asking, show every preview of the step together, and name every command of the step that
  writes at once (`init`, `project add`, `pick`, a `source add` of a folder that already has
  `tack.yaml`).
- The person may answer "yes except X". Drop X and apply the rest. When dropping X changes another
  command (an adapter flag, a pick), show that command and its new preview, and ask again.
- Never apply or run anything that was not shown in that step.
- Worker mode: your instructions are the approval. Apply only what they ask for, and stop at
  anything beyond it.

## Always

- Never move, copy, rename or delete a skill, a source file or a hand-made entry. During setup,
  never run `tack state reset`, `--force`, `rm` or `mv` on the person's folders. Never edit
  `.gitignore` unless the person asks you to in step 6.
- A hand-made entry (a file or folder in an agent's folder that Tack did not make) never stops
  setup. Report it, leave it, and continue with everything else.
- A `! partial` result means the command ran and one item needs attention. Report the item and
  go on.

## 1. Machine

Why: Tack keeps a record of what it links, and gives each of your agents the skills to run Tack.

`tack init` writes at once and has no preview. Say what it does: it creates Tack's record in
`~/.tack`, enables the agents whose folders it finds, links Tack's own skills into them, and lists
the hand-made entries it leaves alone. It touches nothing else, and a rerun writes nothing. On yes,
run it, and report what it did: the agents, the links and the hand-made entries. When the person's
request already says to run `tack init`, that is step 1's yes: run it, then report what it did. To
set up only some agents, run `tack init --adapter ID` instead, one `--adapter` per agent (claude,
cline, codex, copilot, cursor, gemini, junie, opencode, pi); `tack adapter disable ID` previews dropping one later. Then ask quick or full (see
Mode). Keep the hand-made list for steps 3 and 7.

## 2. The model (full only)

Why: these few terms explain every later question.

- A source is a folder you keep that holds skills, commands, context, scripts or docs. Its
  `tack.yaml` says what it holds.
- A project is a Git repository whose agents get links, in every worktree.
- User scope means every project on this machine. Project scope means one repository.
- Tack writes links that point back to your files, shows each change before making it, and
  removes only links it made.

## 3. Sources

Why: Tack links skills only from folders you register, so it needs to know where yours are.

Quick: use the folders the person named. Full: ask which folders hold their skills and whether a
team repository of skills exists. Offer what you found:

- the folders the person names;
- the hand-made entries from step 1. They stay where they are and keep working. To manage one
  with Tack, the person moves it into a source folder later, themselves;
- a team Git repository. `source add` takes a local path, so it must be cloned first: name the
  clone command and folder, and include it in this step's yes.

For each folder:

1. Look inside it, such as with `find PATH -maxdepth 3 -name SKILL.md`, and say what its folders
   seem to hold: skills (a folder per skill with `SKILL.md`), commands, context, docs, scripts.
   Full: ask the person to confirm what each folder is and which ones Tack should serve. Quick:
   take it from the layout, ask only about a folder it does not explain, and let the preview show
   the rest. Worker: use only what your instructions name.
2. With `tack.yaml`, `tack source add PATH` registers it at once: name it as a command that writes
   at once. Without one, pick the command from the layout; each previews the `tack.yaml` it would
   write and what each entry finds: names, counts, problems.
   - `PATH/SKILL.md`: PATH is one skill. Offer its parent folder as a skills collection, or
     `tack import add` for a remote repository. Ask.
   - Folders with `SKILL.md` at the top of PATH: `tack source add PATH --skills .`, a skills
     collection. Each other folder there that holds docs or commands is its own source, such as
     `tack source add PATH/handbook --docs .`.
   - Folders that group skills, commands or docs, such as `skills/`, and nothing at the top: one flag
     per folder, each relative to PATH (`--skills skills`, not an absolute path): `--skills`,
     `--commands`, `--context` or `--docs`.
   - Markdown at the top and nothing else: `tack source add PATH --docs .`.
3. Compare each skills entry's count with `find FOLDER -name SKILL.md`. Scripts, `include` or
   `exclude` patterns and a docs name other than its folder's are added to `tack.yaml` by hand
   after it is written, with the `manage-tack-sources` skill, then `tack check PATH`. To keep
   folders whose name starts with `_`, such as `_archive`, out of a skills entry, add
   `exclude: ["**/_*/**"]` under it.
4. When others use the folder through Git, say that `tack.yaml` is written into it and must be
   committed for them to see it.

Show the folders together ("2 folders: ~/skills with 2 skills, ~/team with 5 skills and 1
command"), then ask once. On yes, run each previewed `tack source add` again with `--apply`, then
`tack check PATH`. Fix every error the same way, showing each fix. The preview and the apply name
each source, such as skills for `~/skills`: step 4's `SOURCE:NAME` picks use that name.

## 4. Scope (full only)

Why: decide which skills reach every project, and which stay out of one.

Run `tack catalog`. Explain: each project gets the default skills of every source; user scope gets
only Tack's own skills unless you pick more. Commands reach Cline, Cursor, Junie, OpenCode and Pi only, and
no agent receives context yet. Ask: which skills do you want everywhere, and which should stay out of a project?
List the picks: `tack pick include SOURCE:NAME --user` for everywhere, and
`tack pick exclude SOURCE:NAME --project PROJECT` to keep one out of a project (register the
project in step 5 first). They save at once: run them after the yes.

## 5. Projects

Why: a project is the repository whose agents get the links; registering it covers every worktree.

Quick: the repository you are in. Full: propose it and ask for others. The name is the folder's
name unless the person picks another. Say: "I will run `tack project add NAME`: it registers the
repository at once and links nothing yet." On yes, run it from inside each repository, or with
`--repository-cwd PATH`.

Report the hand-made entries it lists in the project's agent folders. One named like a source
skill keeps its place: Tack links that skill to every other agent folder and reports the one path.
Explain the trade-off: to keep theirs on purpose, `tack pick exclude SOURCE:NAME --project NAME`
removes Tack's link for every agent in that project, not only the agent whose folder holds theirs.
Run it only on a yes.

## 6. Link

Why: this makes the skills appear in each agent's folder, as links back to the source files.

Run `tack sync --project NAME` for each project, and `tack sync --user` when step 4 added user
picks. Show them together: per target, the agents, the link count and any conflict line. A skill
picked for the user shows as `skip … linked for the user` in each project: it reaches that project
through the user's folder. On yes, run each with `--apply`. "Except project X"
skips its sync. "Except skill X" is a pick: show it and the new preview first.

Ask about Git: the links point to paths on this machine, so committed links break for teammates.
Ignore them in this repository, or commit them? Tack never edits `.gitignore`. To ignore them,
run `tack status --project NAME --details` and show the lines under "For .gitignore in project
NAME", as printed: one per link, from the repository root. A link is a file to Git, so a line never
ends with `/`. Say that each skill linked later needs its own line. The person adds them, or asks
you to; create `.gitignore` if the repository has none. Worker mode: do not touch `.gitignore`;
list the question in your report.

## 6b. Agent instructions

Why: agents in a new clone or worktree of this repository then link these skills before they work.

For each project, offer the Tack section of its `AGENTS.md`, and of its `CLAUDE.md` too when it
has both and `CLAUDE.md` does not import `@AGENTS.md`: run `tack guide agent-instructions` for the
exact text and which file gets it. Say that it is their file, show the text, and say what a yes
means: agents may then run the section's
commands (`tack project refresh --apply`, `tack project add` for a new clone, `tack sync --apply`)
for this project only, without asking again. Write it only on yes, show the change and never commit
it. Worker mode: write it only when your instructions say so; otherwise list it in your report.

## 7. Check and hand over

Run `tack doctor`, then `tack status --project NAME` for each project and `tack status --user`.
Close with a summary:

- What is linked where, counts first: per project and for the user, the skills and the agents.
- What was left untouched and why: hand-made entries, folders not registered.
- What is still open: skipped steps, questions without answers, and in quick mode what full setup
  would add (scope picks, more projects, team repositories).
- New clones and worktrees get their links when an agent follows `prepare-tack-checkout`, or runs
  `tack project refresh --apply` then `tack sync --apply` from the new checkout.
- Agent sessions open before linking may need a restart to see the new skills.
- To undo, each with a preview first: `tack project remove NAME`, `tack source remove SOURCE`,
  or `tack state reset` for everything. They remove only links Tack made and never touch the
  person's files.
- After upgrading Tack, run `tack init` again.
