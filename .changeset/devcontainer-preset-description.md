---
"@banzhe/dsh-devcontainer": patch
---

Describe a derived preset in one sentence that says where its commands run: "Every command runs inside the repository's Linux Dev Container." for a `devContainer` variant, "Every command runs inside the Docker Sandbox mounted on this workspace." for an `sbx` variant. The shell each variant installs (`bash`) and the path form it accepts (`/workspaces/<repo>/...`) stay documented in the plugin README instead of being restated in every preset description, so the preset roster shows the two tracks side by side and an unchanged source description keeps its own sentence intact.
