---
"@banzhe/dsh-session-topic-map": patch
---

Show independent topic progress in the topic map. Each topic now keeps its own lane: a reply that advances several topics places one node per topic side by side on the same row, and each node links down to the next step of that topic. Maps stored by the previous version are upgraded to this layout the next time they are read, so existing Sessions keep their history without another model call. The plugin is still in unstable development: the stored graph format and the Host/Client interfaces may change between versions, so do not rely on it in production.
