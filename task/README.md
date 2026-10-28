# Open tasks

Work that was planned during the holistic code review but not implemented.

| #                                              | Task                                       | Status                                          | Why it's open                                                                                                                                                                             |
| ---------------------------------------------- | ------------------------------------------ | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [001](./001-network-egress-policy.md)          | Network egress policy                      | **Not implemented — declined by the assistant** | Generation was stopped by a safety classifier; the assistant cannot produce it                                                                                                            |
| [002](./002-recon-and-sandbox-escape-rules.md) | Reconnaissance & sandbox-escape heuristics | **Not implemented — declined by the assistant** | An implementation attempt was stopped by a safety classifier; the assistant cannot produce it. The spec in the file was written before that stop and remains usable by a human maintainer |

Context: these came out of reviewing the plugin against Cohere's October 2026 write-up on concerning agent
behaviour in an open-weight model (<https://cohere.com/blog/concerning-behaviour-popular-open-weight-ai-model>).
The hosts named in that article are illustrative only and must **not** be hardcoded; detection is by
behaviour class, with any host lists coming from user configuration.
