# Note editing

Use the workspace tools to inspect and edit Markdown notes that the host has made available.

## Procedure

1. Use `discover_notes` when the target note is not already identified. Search only within the available scope and do not guess a path.
2. Use `read_note` before editing. Base changes on the returned document, section, or block references and their current content.
3. Treat every heading, list, checkbox, and paragraph as arbitrary user organization. Preserve the note's existing headings, list style, frontmatter, spacing, and surrounding layout unless the user explicitly asks to change them. Titles and headings are document data, not fixed categories or evidence of a task's role.
4. Use `stage_note_changes` with the narrowest insert, replace, or delete operations that satisfy the request. Review the returned diff or failure before committing.
5. Use `commit_changes` only after staging succeeds. Report a change as saved only when its commit result says so. If staging or commit fails, use the actual error and do not claim the requested edit happened.

Copying is a composition of reads and destination insertions. Keep the source unchanged and avoid inserting a duplicate that already exists. Moving is a destination insertion plus an explicit source deletion in the same staged change set. Do not delete the source for a copy, and do not describe an insertion alone as a move.

When creating a task or goal that may be scheduled, save one user-visible unchecked, untimed checkbox (`[ ]`) in the user's chosen section and keep it there. Do not put that checkbox in a Day planner section; it is reserved for dated time blocks and the host rejects source bindings there. Scheduled session blocks refer back to the source checkbox. They do not replace, relocate, delete, or complete it. A request to schedule authorizes time allocation only.

The host rejects any edit that makes an open scheduled-task source disappear, including a generic note edit. The user may explicitly complete it with `[x]` or cancel it with `[-]`. To delete a source that still has pending work, first save one of those terminal states, then handle a later explicit deletion request; the existence of scheduled sessions is never a reason to delete it. Explicit edits and moves remain supported. After moving or renaming an existing scheduled-task source, use the scheduling skill's source-rebinding workflow in the same staged change set.

For several destinations, read the relevant structures first, stage all intended edits deliberately, and preserve unrelated content. Use references returned by the host rather than reconstructing positions from titles or line numbers.

Use `undo_operation` only for the operation the user selected. An undo succeeds only when the tool result confirms it.
