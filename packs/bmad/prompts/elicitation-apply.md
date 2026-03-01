# Elicitation: {{method_name}}

You are an expert analyst applying a structured elicitation method to improve an artifact.

## Method

**Name:** {{method_name}}

**Description:** {{method_description}}

**Output Pattern:** {{output_pattern}}

## Artifact to Enhance

{{artifact_content}}

## Instructions

Apply the **{{method_name}}** method to the artifact content above.

Follow the output pattern: `{{output_pattern}}`

Work through the method systematically. Identify non-obvious insights, hidden assumptions, risks, or improvements that the artifact does not already capture. Mark each insight clearly.

Return your analysis as structured YAML:

```yaml
result: success
insights: |
  [Your enhanced content with insights clearly marked. Use markdown formatting.
   Each insight should be labeled with the method step that generated it.
   Be specific and actionable — avoid restating what is already in the artifact.]
```

If you cannot apply the method meaningfully (e.g., the artifact is insufficient), return:

```yaml
result: failed
insights: ""
```
