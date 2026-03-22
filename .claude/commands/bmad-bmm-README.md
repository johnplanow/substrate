# BMM Workflows

## Available Workflows in bmm

**create-product-brief**
- Path: `_bmad/bmm/workflows/1-analysis/create-product-brief/workflow.md`
- Create product brief through collaborative discovery. Use when the user says "lets create a product brief" or "help me create a project brief"

**domain-research**
- Path: `_bmad/bmm/workflows/1-analysis/research/workflow-domain-research.md`
- Conduct domain and industry research. Use when the user says "lets create a research report on [domain or industry]"

**market-research**
- Path: `_bmad/bmm/workflows/1-analysis/research/workflow-market-research.md`
- Conduct market research on competition and customers. Use when the user says "create a market research report about [business idea]".

**technical-research**
- Path: `_bmad/bmm/workflows/1-analysis/research/workflow-technical-research.md`
- Conduct technical research on technologies and architecture. Use when the user says "create a technical research report on [topic]".

**create-prd**
- Path: `_bmad/bmm/workflows/2-plan-workflows/create-prd/workflow-create-prd.md`
- Create a PRD from scratch. Use when the user says "lets create a product requirements document" or "I want to create a new PRD"

**edit-prd**
- Path: `_bmad/bmm/workflows/2-plan-workflows/create-prd/workflow-edit-prd.md`
- Edit an existing PRD. Use when the user says "edit this PRD".

**validate-prd**
- Path: `_bmad/bmm/workflows/2-plan-workflows/create-prd/workflow-validate-prd.md`
- Validate a PRD against standards. Use when the user says "validate this PRD" or "run PRD validation"

**create-ux-design**
- Path: `_bmad/bmm/workflows/2-plan-workflows/create-ux-design/workflow.md`
- Plan UX patterns and design specifications. Use when the user says "lets create UX design" or "create UX specifications" or "help me plan the UX"

**check-implementation-readiness**
- Path: `_bmad/bmm/workflows/3-solutioning/check-implementation-readiness/workflow.md`
- Validate PRD, UX, Architecture and Epics specs are complete. Use when the user says "check implementation readiness".

**create-architecture**
- Path: `_bmad/bmm/workflows/3-solutioning/create-architecture/workflow.md`
- Create architecture solution design decisions for AI agent consistency. Use when the user says "lets create architecture" or "create technical architecture" or "create a solution design"

**create-epics-and-stories**
- Path: `_bmad/bmm/workflows/3-solutioning/create-epics-and-stories/workflow.md`
- Break requirements into epics and user stories. Use when the user says "create the epics and stories list"

**quick-dev**
- Path: `_bmad/bmm/workflows/bmad-quick-flow/quick-dev/workflow.md`
- Implement a Quick Tech Spec for small changes or features. Use when the user provides a quick tech spec and says "implement this quick spec" or "proceed with implementation of [quick tech spec]"

**quick-spec**
- Path: `_bmad/bmm/workflows/bmad-quick-flow/quick-spec/workflow.md`
- Very quick process to create implementation-ready quick specs for small changes or features. Use when the user says "create a quick spec" or "generate a quick tech spec"

**generate-project-context**
- Path: `_bmad/bmm/workflows/generate-project-context/workflow.md`
- Create project-context.md with AI rules. Use when the user says "generate project context" or "create project context"


## Execution

When running any workflow:
1. LOAD the workflow.md file at the path shown above
2. READ its entire contents and follow its directions exactly
3. Save outputs after EACH section

## Modes
- Normal: Full interaction
- #yolo: Skip optional steps
