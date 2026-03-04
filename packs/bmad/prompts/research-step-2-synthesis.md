# BMAD Research Step 2: Synthesis

## Context (pre-assembled by pipeline)

### Concept
{{concept}}

### Raw Research Findings
{{raw_findings}}

---

## Mission

Synthesize the raw research findings into a structured, actionable research report. Your goal is to distill the discovery output into five key sections:

1. **Market Context** — the market landscape, sizing, and customer dynamics
2. **Competitive Landscape** — who the key competitors are, their positioning, and differentiation opportunities
3. **Technical Feasibility** — how technically viable this concept is, key technology choices, and build vs. buy considerations
4. **Risk Flags** — specific risks that could threaten success (market, technical, regulatory, execution)
5. **Opportunity Signals** — specific indicators of where this concept has an advantage or untapped potential

This synthesis output feeds directly into the analysis phase to ground the product brief in real-world context.

## Instructions

1. **Market Context**: Synthesize the market dimension findings. Quantify the opportunity where possible. Identify the primary buyer profile and decision-maker. Note any market timing signals (growing, contracting, consolidating).

2. **Competitive Landscape**: Identify named competitors (direct and adjacent). Describe how they are positioned. Identify gaps or differentiation opportunities that the concept could exploit.

3. **Technical Feasibility**: Assess how technically achievable the concept is given the technology landscape. Highlight proven patterns to adopt, and identify areas where the technical approach is risky or unproven.

4. **Risk Flags**: List 3-6 specific, concrete risks. Each risk should name the threat and its potential impact. Avoid generic risks like "execution risk" — be specific (e.g., "Compliance with HIPAA BAA requirements may add 3-6 months to enterprise sales cycles").

5. **Opportunity Signals**: List 3-6 specific indicators that suggest this concept has real potential. These should be grounded in the research findings, not wishful thinking.

## Output Contract

Emit ONLY this YAML block as your final output — no other text, no preamble.

**CRITICAL**: All string values MUST be quoted with double quotes. List items in `risk_flags` and `opportunity_signals` must also be double-quoted.

```yaml
result: success
market_context: "The cloud infrastructure automation market is a $12B opportunity growing at 18% CAGR, driven by the shift from DevOps to platform engineering. Primary buyers are VPs of Engineering and Platform Engineering leads at Series B+ startups and mid-market companies. Market is in early growth phase with high willingness to pay for workflow automation."
competitive_landscape: "Direct competitors are Terraform Cloud (HashiCorp/IBM), Spacelift, and Scalr — all targeting the same DevOps persona. Pulumi competes on developer experience with a code-first approach. Differentiation opportunity: none of the incumbent tools offer AI-assisted drift detection or natural-language policy authoring. Open source (OpenTofu) commoditizes the IaC layer, making the control plane the primary value surface."
technical_feasibility: "High feasibility using proven patterns: Go agent with event-driven control plane (used by Argo CD, Flux), React dashboard, and PostgreSQL for state. Primary technical risk is distributed state reconciliation under network partitions. Build recommendation: agent core in Go, leverage existing Terraform/OpenTofu compatibility, avoid building a custom DSL."
risk_flags:
  - "Regulatory: HIPAA and SOC 2 Type II compliance are table stakes for enterprise sales — adds 4-6 months to first enterprise close"
  - "Competitive: HashiCorp's BSL license change accelerated OpenTofu adoption — if IBM reverses the decision, momentum could shift back"
  - "Technical: Distributed state reconciliation under network partitions is an unsolved problem that all incumbents struggle with — high engineering cost"
  - "Market: Per-seat pricing erodes at scale (>500 engineers) — customers will demand volume discounts or switch to usage-based pricing"
opportunity_signals:
  - "AI-native workflows: no incumbent offers natural-language policy authoring or AI-assisted remediation — clear whitespace"
  - "OpenTofu migration wave: 30%+ of Terraform users are evaluating alternatives following the BSL license change — timing is favorable"
  - "Platform engineering trend: Gartner predicts 80% of large orgs will have platform engineering teams by 2026 — growing buyer segment"
  - "Developer experience gap: incumbent UIs are functional but dated — a modern, keyboard-first interface is a differentiator"
```

If you cannot produce valid output:

```yaml
result: failed
```
