# ADR-0014: Use controlled in-place Git history sanitation

Decision ID: `DEC-PLT-M00-SEC-001`<br>
Status: Accepted<br>
Date: 2026-08-20<br>
Program: M00 — Architecture Foundation<br>
Parent capability: [#1077](https://github.com/YurGusev/CoffeeOrderSystem/issues/1077)<br>
Decision issue: [#1085](https://github.com/YurGusev/CoffeeOrderSystem/issues/1085)<br>
Target migration stage: `Authority`<br>
Test Changes Allowed: `No`

## Context

Tracked repository history contains credential-bearing environment files and a
vendored Python environment. Deleting them in a normal commit cannot remove
their historical blobs, while a broad rewrite can damage branches, tags, pull
request references and recoverability.

The repository currently has many local worktrees and nonstandard local refs.
GitHub also exposes provider-managed pull-request refs that are read-only to a
normal push. Therefore a rewrite from an existing developer clone, an orphan
branch, or an unreviewed `git push --force --mirror` is not acceptable.

Credential rotation remains a provider-side owner operation. This Decision does
not authorize it and does not authorize any destructive Git operation.

## Decision

### 1. Strategy

Use a **controlled in-place history rewrite** from a disposable private mirror
after credential rotation and current-tree cleanup. This preserves the existing
repository, issues and governance links while allowing exact historical paths
to be removed.

Rejected alternatives:

- a replacement repository creates a second authority and breaks established
  issue/Project/PR continuity;
- an orphan branch leaves old refs and provider caches reachable unless the old
  repository is retired separately;
- rewriting an existing developer clone can accidentally publish local heads,
  stash, reflogs, worktree refs, Codex refs or archive-only tags.

### 2. Exact sanitation paths

The approved path-removal set is exactly:

```text
.env.agent
cognee-docker/.env
python-agent/venv311
```

No glob, basename-only match, secret value, business document, model artifact,
source tree or generated path is implicitly included. A renamed or additional
credential path requires an amendment to this Decision before #1088.

The following are explicitly excluded:

- `bin/docker-compose`, because it is tracked Bash source;
- current C# Orders/AROMA, tests, EF migrations, React, AI/VK, training source
  and manual invoice-recovery paths;
- business XLSX/PDF artifacts until #1087 records a data-owner disposition and
  accepted sanitized replacement where required;
- local-only stash, reflogs, Codex refs, checkpoint refs and archive-only tags.

### 3. Ref scope

At the maintenance freeze, the operator must produce a machine-readable manifest
containing the exact old object ID for every remote-advertised ref.

Writable rewrite scope:

```text
all refs/heads/* advertised by origin at the freeze snapshot
all refs/tags/* advertised by origin at the freeze snapshot
```

Read-only evidence/support scope:

```text
all advertised refs/pull/*
all affected forks and cached commit/PR views known to the owner
```

Only heads and tags listed in the reviewed freeze manifest may be force-updated.
Each push uses an explicit refspec and the manifest's old object ID as a
`--force-with-lease` expectation. A broad push from the normal workspace is
forbidden. Pull-request refs are not writable and must be recorded from
`git-filter-repo` changed-ref evidence for the GitHub Support purge request.

### 4. Preconditions

All conditions are mandatory before #1088 can enter `Ready`:

1. #1086 records owner-confirmed provider-side revocation/rotation and redacted
   audit review for every affected credential class.
2. #1087 removes the three target paths from the current tree, hardens
   prevention policy, and records preserve-until-proof dispositions.
3. The repository owner approves a dated merge freeze and maintenance window.
4. New PR creation and merges are paused for every writable ref in scope.
5. An encrypted, access-controlled pre-rewrite mirror and ref manifest are
   stored outside the working repository.
6. Recovery is rehearsed from a copy of that mirror without publishing old
   history.
7. A pinned `git-filter-repo >= 2.47` and a version-pinned, redaction-safe
   full-history scanner are available in the disposable environment.
8. The owner separately and explicitly approves #1088, the exact freeze
   manifest, temporary protection bypass and force-update operation.

### 5. Rewrite and publication

The disposable mirror runs `git-filter-repo --sensitive-data-removal` with only
the three exact paths. It must produce:

- pre/post head and tag object IDs;
- `.git/filter-repo/changed-refs` or equivalent affected-ref inventory;
- affected `refs/pull/*` count and identifiers without diff content;
- zero-target-path verification across rewritten refs;
- redacted current-tree and full-history scanner summaries.

No force-update occurs until an independent reviewer accepts those artifacts.
Publication then updates only the manifest-approved heads and tags through
explicit per-ref leases. Any unexpected ref change, push rejection outside
provider-managed pull refs, new commit after freeze, or scan finding stops the
operation.

### 6. Provider and collaborator cleanup

After publication:

- restore branch/tag protection immediately;
- verify every approved remote ref against the post-rewrite manifest;
- require fresh clones; old clones must not merge old history back;
- coordinate affected forks with their owners;
- contact GitHub Support with the affected pull-request refs and changed-ref
  evidence to remove cached views/references where eligible;
- execute #1089 from a new clone/object database after the final remote update.

## Consequences

History object IDs for affected commits change. Existing commit links, signed
commits, open PR diffs, forks and local clones may be invalidated. These effects
are accepted only inside the separately approved maintenance window.

Rotating credentials remains the primary security response. History sanitation
reduces residual exposure but cannot clean third-party clones or caches by
itself.

## Rollback and STOP conditions

The protected pre-rewrite mirror is a recovery source, not an ordinary rollback
branch. Restoring it re-exposes compromised history and therefore requires
incident-owner approval. An ordinary revert cannot undo a history rewrite.

STOP on any of the following:

- unknown credential owner or missing revoke/rotate proof;
- ambiguous data ownership or an unapproved target path;
- incomplete branch/tag/pull-ref/fork coverage;
- missing or untested protected mirror;
- scanner output that can disclose matching secret lines;
- ref drift after the freeze manifest;
- absent independent review or explicit #1088 destructive approval;
- inability to restore protections or coordinate fresh clones.

## Verification

Decision acceptance requires only non-mutating verification:

1. compare the three exact paths with canonical M00/M16 sanitation rules;
2. inventory advertised heads, tags and pull refs without fetching secret
   content into evidence;
3. confirm that local-only refs/worktrees cannot enter publication scope;
4. review the runbook's preconditions, redaction, recovery and STOP behavior;
5. validate Markdown links, UTF-8 and MkDocs navigation.

Для проверки исполнимости Decision проведена непубликующая репетиция в свежем
disposable GitHub mirror. Она сохранила набор имён 59 heads, 19 tags и 619
provider-managed pull refs и дала ноль reachable objects по трём exact paths.
Секретные значения и совпавшие строки не выводились.

The rewrite dry-run, force-update, provider purge and fresh-clone evidence belong
to #1088/#1089. Feasibility-rehearsal не является принятым #1088 dry-run и не
разрешает публикацию результата.
