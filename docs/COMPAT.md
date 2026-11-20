# Compatibility notes

> Consolidated host-compatibility notes. These describe **host-side changes**, not plugin defects.
> Current contract: DSH `>=0.1.7-rc.2 <0.3.0-0 || >=0.2.2-0 <0.3.0-0`（0.1.7-rc.2 generation through the 0.2.2 line）, `dsh-log-contract ^0.3.18`（>=0.3.18 <0.4.0）, Node >= 20.

| Symptom | Cause (host-side) | What to do |
|---|---|---|
| Boot loop / recovery screen after a host upgrade | host removed an API the plugin used at boot | open a clean session, restart DSH; plugin degrades instead of blocking |
| Version/checkpoint list empty after upgrade | plugin data bundle not refreshed | `dsh plugin --profile <profile> add dsh-retrace` |
| Title/rename behaves differently | automatic title path guarded differently by the host | rename manually; automatic bootstrap is off by default |
| Recall/edit reports a contract error | host tightened event shape rules | upgrade `dsh-log-contract` to >= 0.3.18 and retry |

Exact error strings and historical details are kept in the project history (CHANGELOG), not in this table.

## Binary files in checkpoint / undo restore

The host file service exposes **text-only mutation primitives** (`writeText`, `patchText`, `deleteFile`, `moveFile`) in both supported generations (0.1.7-rc.2 and 0.2.2-rc.2). Byte reads exist (`readBytes`, `readByteRange`), but there is **no sanctioned byte write** (`writeBytes` is absent from the service and from both backends).

Consequences (by design, never silent):

- A preimage whose bytes are **not valid UTF-8** (or contain NUL) is reported per file as `failed` with reason **`binary-unsupported`**; the target file is **not** rewritten. If the *current* file is binary, the preview row is `skip` with the same reason.
- If a future host adds `fs.writeBytes`, the restore path detects it and writes the exact original bytes (`status: "restored", via: "bytes"`); nothing else changes.
- **Escape hatch**: `restoreExport` bundles every preimage as base64 in the export ZIP (`files[].base64`), so binary files can be restored manually. The export is read-only and never touches the workspace.
