## Operational Findings

### Run Summaries

**Run: 137441de-96b7-4f96-9c7f-47d8418d1200**
- Succeeded: 49-2, 49-3, 49-8
- Failed: none
- Escalated: 49-1, 49-4, 49-5, 49-6, 49-7
- Total restarts: 1
- Elapsed: 3820s
- Tokens: 174544 in / 12171 out

**Run: 7a7d62b1-8e1b-411e-ba14-5b0ad33b659c**
- Succeeded: 58-6
- Failed: 58-7
- Escalated: none
- Total restarts: 3
- Elapsed: 16542s
- Tokens: 546284 in / 39318 out

### Stall Events

- **stall:41-1:1774203316720**: phase=IN_DEV staleness=611s attempt=1 outcome=recovered
- **stall:41-3:1774203316720**: phase=IN_DEV staleness=611s attempt=1 outcome=recovered
- **stall:41-2:1774203316720**: phase=IN_DEV staleness=611s attempt=1 outcome=recovered
- **stall:58-3:1776742962706**: phase=VERIFICATION_FAILED staleness=947s attempt=1 outcome=recovered
- **stall:58-3:1776745373228**: phase=VERIFICATION_FAILED staleness=918s attempt=2 outcome=recovered
- **stall:58-3:1776747753306**: phase=VERIFICATION_FAILED staleness=906s attempt=3 outcome=recovered
- **stall:58-3:1776748679645**: phase=VERIFICATION_FAILED staleness=911s attempt=3 outcome=max-restarts-escalated
- **stall:58-6:1776790249263**: phase=VERIFICATION_FAILED staleness=942s attempt=1 outcome=recovered
- **stall:58-6:1776798165728**: phase=VERIFICATION_FAILED staleness=919s attempt=3 outcome=recovered
- **stall:58-7:1776798165728**: phase=VERIFICATION_FAILED staleness=919s attempt=3 outcome=recovered
