# Compatibility notes

> Consolidated host-compatibility notes. These describe **host-side changes**, not plugin defects.
> Current contract: DSH `>=0.1.5 <0.3.0`, `dsh-log-contract ^0.3.18`（>=0.3.18 <0.4.0）, Node >= 20.

| Symptom | Cause (host-side) | What to do |
|---|---|---|
| Boot loop / recovery screen after a host upgrade | host removed an API the plugin used at boot | open a clean session, restart DSH; plugin degrades instead of blocking |
| Version/checkpoint list empty after upgrade | plugin data bundle not refreshed | `dsh plugin --profile <profile> add dsh-retrace` |
| Title/rename behaves differently | automatic title path guarded differently by the host | rename manually; automatic bootstrap is off by default |
| Recall/edit reports a contract error | host tightened event shape rules | upgrade `dsh-log-contract` to >= 0.3.18 and retry |

Exact error strings and historical details are kept in the project history (CHANGELOG), not in this table.
