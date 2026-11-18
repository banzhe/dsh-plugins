---
'@banzhe/dsh-picker-browse': patch
---

Add `@banzhe/dsh-picker-browse`: the in-app Select Workspace Directory dialog, forked from the shipped `@deepseek-ai/dsh-client-ui-directory-picker-browse` surface and extended with a drive-letter row in its header. On a Host that lists Windows paths, the dialog probes `C:\` through `Z:\` in parallel when it opens, shows one button per drive that answers, marks the drive holding the current level, and navigates to a drive root on press — the same landing a typed `F:\` and Enter reach. A Host that lists POSIX paths never sees the row. Enable it in place of the shipped row; both fill the same two directory-flow holes. This is the package's first release.
