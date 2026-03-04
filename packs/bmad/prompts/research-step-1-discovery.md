# BMAD Research Step 1: Discovery

## Context (pre-assembled by pipeline)

### Concept
{{concept}}

---

## Mission

Conduct a thorough **research discovery** for this concept. Your goal is to gather and organize raw findings across three dimensions:

1. **Concept Classification** — what type of product or tool is this, who is it for, and what domain does it operate in?
2. **Market Findings** — market size, target customers, pricing models, and market trends
3. **Domain Findings** — best practices, industry standards, regulatory requirements, and use cases
4. **Technical Findings** — technical architecture patterns, technology stacks, open source alternatives, and implementation challenges

This raw discovery output will feed directly into a synthesis step that distills the findings into actionable insights.

## Instructions

### 1. Classify the Concept

Before searching, classify the concept:
- **Product type**: Is this a product sold to customers, or an internal tool / developer tooling?
- **Industry vertical**: What industry or sector does it primarily serve (e.g., fintech, healthcare, devtools, SaaS platform, e-commerce)?
- **Tech domain**: What is the primary technical domain (e.g., data pipelines, mobile apps, APIs, AI/ML, infrastructure)?

### 2. Conduct Web Research

Use web search to gather findings across the three dimensions below. Execute approximately 12 searches total — 3-4 per dimension.

**Market dimension queries:**
- `"{{concept}} market size"`
- `"{{concept}} target customers"`
- `"{{concept}} pricing models"`
- `"{{concept}} market trends 2025"`

**Domain dimension queries:**
- `"{{concept}} best practices"`
- `"{{concept}} industry standards"`
- `"{{concept}} regulatory requirements"`
- `"{{concept}} use cases"`

**Technical dimension queries:**
- `"{{concept}} technical architecture"`
- `"{{concept}} technology stack"`
- `"{{concept}} open source alternatives"`
- `"{{concept}} implementation challenges"`

> **Fallback**: If web search is unavailable in your environment, proceed with concept analysis using your training knowledge — acknowledge that findings may not reflect the latest market conditions.

### 3. Organize Findings

For each dimension, summarize the key findings in 2-4 sentences. Be specific: name actual companies, technologies, standards, or regulations where found. Avoid vague generalizations.

## Output Contract

Emit ONLY this YAML block as your final output — no other text, no preamble.

**CRITICAL**: All string values MUST be quoted with double quotes.

```yaml
result: success
concept_classification: "B2B SaaS product targeting mid-market DevOps teams in the cloud infrastructure space"
market_findings: "The cloud infrastructure automation market is valued at $12B in 2024, growing at 18% CAGR. Primary customers are platform engineering teams at companies with 50-500 engineers. Pricing models cluster around per-seat ($30-80/month) and usage-based (per compute hour). Key trend: shift from IaaS to developer-experience platforms."
domain_findings: "Industry standards include Terraform HCL for IaC and GitOps workflows (CNCF). Regulatory requirements vary by industry: SOC 2 Type II is table stakes for enterprise; HIPAA for healthcare customers. Key use cases: multi-cloud deployment, drift detection, cost optimization, and compliance reporting."
technical_findings: "Dominant architectural pattern is event-driven with a control plane / data plane separation. Common stack: Go or Rust for the agent, React for dashboard, PostgreSQL + TimescaleDB for time-series data. Open source alternatives include Pulumi, OpenTofu, and Crossplane. Primary implementation challenges are state reconciliation under network partitions and secret management at scale."
```

If you cannot produce valid output:

```yaml
result: failed
```
