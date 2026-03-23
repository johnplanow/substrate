/**
 * Unit tests for parseGraph() — stories 42-1 and 42-2
 *
 * Covers (story 42-1):
 *  AC1 — graph-level attribute extraction (goal, label, defaultMaxRetries)
 *  AC2 — ts-graphviz used for parsing (no custom tokenizer)
 *  AC3 — all graph-level attributes accessible with camelCase names
 *  AC4 — malformed DOT throws descriptive error
 *  AC5 — comments are stripped (handled natively by ts-graphviz)
 *  AC6 — all tests pass (verified by npm run test:fast)
 *
 * Covers (story 42-2):
 *  AC1 — all 17 node attributes extracted with correct types
 *  AC2 — all 6 edge attributes extracted with correct types
 *  AC3 — quoted and unquoted attribute values resolve correctly
 *  AC4 — node default values applied when attributes are absent
 *  AC5 — edge default values applied when attributes are absent
 *  AC6 — parseGraph() returns populated nodes map and edges array
 *  AC7 — all unit tests pass
 */

import { describe, it, expect } from 'vitest'
import { parseGraph } from '../parser.js'

// ---------------------------------------------------------------------------
// AC1: Graph-level attribute extraction (goal, label, defaultMaxRetries)
// ---------------------------------------------------------------------------

describe('parseGraph — AC1: basic graph-level attributes', () => {
  it('extracts goal, label, and defaultMaxRetries from digraph', () => {
    const dot = `
      digraph MyPipeline {
        graph [goal="Build app", label="My Pipeline", default_max_retries=2]
      }
    `
    const graph = parseGraph(dot)
    expect(graph.goal).toBe('Build app')
    expect(graph.label).toBe('My Pipeline')
    expect(graph.defaultMaxRetries).toBe(2)
  })

  it('returns correct graph id', () => {
    const dot = 'digraph BuildPipeline {}'
    const graph = parseGraph(dot)
    expect(graph.id).toBe('BuildPipeline')
  })
})

// ---------------------------------------------------------------------------
// AC2: ts-graphviz used for parsing (structural verification)
// ---------------------------------------------------------------------------

describe('parseGraph — AC2: ts-graphviz used for parsing', () => {
  it('parses valid DOT with various syntaxes without error', () => {
    // Quoted strings, unquoted numbers, empty attribute block, subgraph — all
    // forms supported by ts-graphviz should parse cleanly.
    const dot = `
      digraph G {
        graph [goal="ok"]
        A -> B [label="step1"]
        B -> C
      }
    `
    expect(() => parseGraph(dot)).not.toThrow()
  })

  it('parses DOT with node shape attributes without error', () => {
    const dot = `
      digraph {
        graph [goal="test"]
        start [shape=Mdiamond]
        end   [shape=Msquare]
        start -> end
      }
    `
    expect(() => parseGraph(dot)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// AC3: All graph-level attributes accessible with camelCase names
// ---------------------------------------------------------------------------

describe('parseGraph — AC3: full graph-level attribute set', () => {
  it('maps all five optional graph-level attributes to camelCase fields', () => {
    const dot = `
      digraph Pipeline {
        graph [
          model_stylesheet="styles.yaml"
          retry_target="nodeRetry"
          fallback_retry_target="nodeFallback"
          default_fidelity="high"
          goal="Complete feature"
          label="Feature pipeline"
          default_max_retries=3
        ]
      }
    `
    const graph = parseGraph(dot)
    expect(graph.modelStylesheet).toBe('styles.yaml')
    expect(graph.retryTarget).toBe('nodeRetry')
    expect(graph.fallbackRetryTarget).toBe('nodeFallback')
    expect(graph.defaultFidelity).toBe('high')
    expect(graph.goal).toBe('Complete feature')
    expect(graph.label).toBe('Feature pipeline')
    expect(graph.defaultMaxRetries).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// AC4: Malformed DOT throws descriptive error
// ---------------------------------------------------------------------------

describe('parseGraph — AC4: malformed DOT error handling', () => {
  it('throws an Error starting with "DOT parse error:" for unterminated attribute block', () => {
    const malformed = 'digraph { [missing_node'
    expect(() => parseGraph(malformed)).toThrow(/^DOT parse error:/)
  })

  it('throws an Error starting with "DOT parse error:" for missing opening brace', () => {
    const malformed = 'digraph missing_brace goal="test" }'
    expect(() => parseGraph(malformed)).toThrow(/^DOT parse error:/)
  })
})

// ---------------------------------------------------------------------------
// AC5: Comments are stripped (handled by ts-graphviz natively)
// ---------------------------------------------------------------------------

describe('parseGraph — AC5: comment handling', () => {
  it('parses DOT with // line comments without error', () => {
    const dot = `
      // This is a pipeline
      digraph CommentedGraph {
        // Graph-level attributes
        graph [goal="test goal"]
      }
    `
    const graph = parseGraph(dot)
    expect(graph.goal).toBe('test goal')
  })

  it('parses DOT with /* */ block comments without error', () => {
    const dot = `
      /* Block comment at top */
      digraph BlockCommented {
        graph [
          /* inline block comment */
          goal="block test"
          label="Block Test"
        ]
      }
    `
    const graph = parseGraph(dot)
    expect(graph.goal).toBe('block test')
    expect(graph.label).toBe('Block Test')
  })

  it('parses DOT with mixed comments without error', () => {
    const dot = `
      // line comment
      /* block comment */
      digraph Mixed {
        graph [goal="mixed"] // trailing comment
      }
    `
    const graph = parseGraph(dot)
    expect(graph.goal).toBe('mixed')
  })
})

// ---------------------------------------------------------------------------
// Default values
// ---------------------------------------------------------------------------

describe('parseGraph — default values for bare digraph', () => {
  it('returns sensible defaults for bare digraph {}', () => {
    const graph = parseGraph('digraph {}')
    expect(graph.defaultMaxRetries).toBe(0)
    expect(graph.goal).toBe('')
    expect(graph.label).toBe('')
    expect(graph.modelStylesheet).toBe('')
    expect(graph.retryTarget).toBe('')
    expect(graph.fallbackRetryTarget).toBe('')
    expect(graph.defaultFidelity).toBe('')
    expect(graph.id).toBe('')
    expect(graph.nodes.size).toBe(0)
    expect(graph.edges).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// outgoingEdges / startNode / exitNode method stubs
// ---------------------------------------------------------------------------

describe('parseGraph — Graph methods', () => {
  it('outgoingEdges returns empty array when no edges exist', () => {
    const graph = parseGraph('digraph { graph [goal="test"] }')
    expect(graph.outgoingEdges('anyNode')).toEqual([])
  })

  it('startNode throws when no nodes exist', () => {
    const graph = parseGraph('digraph {}')
    expect(() => graph.startNode()).toThrow('no start node')
  })

  it('exitNode throws when no nodes exist', () => {
    const graph = parseGraph('digraph {}')
    expect(() => graph.exitNode()).toThrow('no exit node')
  })
})

// ===========================================================================
// Story 42-2: Node and Edge Attribute Extraction
// ===========================================================================

// ---------------------------------------------------------------------------
// AC1 + AC3: Node attribute extraction — all 17 attributes with correct types
// ---------------------------------------------------------------------------

describe('node attribute extraction — AC1: all 17 attributes with correct types', () => {
  it('extracts all 17 node attributes with correct types', () => {
    const dot = `
      digraph G {
        my_node [
          label="My Label"
          shape=box
          type="agent"
          prompt="Implement the feature"
          max_retries=5
          goal_gate=true
          retry_target="retry_node"
          fallback_retry_target="fallback_node"
          fidelity="high"
          thread_id="thread-1"
          class="agent-class"
          timeout=30
          llm_model="gpt-4"
          llm_provider="openai"
          reasoning_effort="high"
          auto_status=false
          allow_partial=true
        ]
      }
    `
    const graph = parseGraph(dot)
    const node = graph.nodes.get('my_node')!
    expect(node).toBeDefined()

    // string fields
    expect(typeof node.label).toBe('string')
    expect(node.label).toBe('My Label')
    expect(typeof node.shape).toBe('string')
    expect(node.shape).toBe('box')
    expect(typeof node.type).toBe('string')
    expect(node.type).toBe('agent')
    expect(typeof node.prompt).toBe('string')
    expect(node.prompt).toBe('Implement the feature')
    expect(typeof node.retryTarget).toBe('string')
    expect(node.retryTarget).toBe('retry_node')
    expect(typeof node.fallbackRetryTarget).toBe('string')
    expect(node.fallbackRetryTarget).toBe('fallback_node')
    expect(typeof node.fidelity).toBe('string')
    expect(node.fidelity).toBe('high')
    expect(typeof node.threadId).toBe('string')
    expect(node.threadId).toBe('thread-1')
    expect(typeof node.class).toBe('string')
    expect(node.class).toBe('agent-class')
    expect(typeof node.llmModel).toBe('string')
    expect(node.llmModel).toBe('gpt-4')
    expect(typeof node.llmProvider).toBe('string')
    expect(node.llmProvider).toBe('openai')
    expect(typeof node.reasoningEffort).toBe('string')
    expect(node.reasoningEffort).toBe('high')

    // number fields
    expect(typeof node.maxRetries).toBe('number')
    expect(node.maxRetries).toBe(5)
    expect(typeof node.timeout).toBe('number')
    expect(node.timeout).toBe(30)

    // boolean fields
    expect(typeof node.goalGate).toBe('boolean')
    expect(node.goalGate).toBe(true)
    expect(typeof node.autoStatus).toBe('boolean')
    expect(node.autoStatus).toBe(false)
    expect(typeof node.allowPartial).toBe('boolean')
    expect(node.allowPartial).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// AC3: Quoted and unquoted attribute values resolve correctly
// ---------------------------------------------------------------------------

describe('node attribute extraction — AC3: quoted and unquoted values', () => {
  it('resolves unquoted shape=box and quoted prompt correctly', () => {
    const dot = `
      digraph G {
        n1 [shape=box prompt="Implement the feature"]
      }
    `
    const graph = parseGraph(dot)
    const node = graph.nodes.get('n1')!
    expect(node.shape).toBe('box')
    expect(node.prompt).toBe('Implement the feature')
  })
})

// ---------------------------------------------------------------------------
// AC4: Node default values applied when attributes are absent
// ---------------------------------------------------------------------------

describe('node attribute extraction — AC4: default values', () => {
  it('applies correct defaults when no attributes are set', () => {
    const dot = `digraph G { my_node [] }`
    const graph = parseGraph(dot)
    const node = graph.nodes.get('my_node')!
    expect(node).toBeDefined()

    // shape defaults to "box"
    expect(node.shape).toBe('box')
    // goalGate defaults to false
    expect(node.goalGate).toBe(false)
    // autoStatus defaults to true
    expect(node.autoStatus).toBe(true)
    // allowPartial defaults to false
    expect(node.allowPartial).toBe(false)
    // string fields default to ""
    expect(node.label).toBe('')
    expect(node.type).toBe('')
    expect(node.prompt).toBe('')
    expect(node.retryTarget).toBe('')
    expect(node.fallbackRetryTarget).toBe('')
    expect(node.fidelity).toBe('')
    expect(node.threadId).toBe('')
    expect(node.class).toBe('')
    expect(node.llmModel).toBe('')
    expect(node.llmProvider).toBe('')
    expect(node.reasoningEffort).toBe('')
    // timeout defaults to 0
    expect(node.timeout).toBe(0)
  })

  it('applies graph.defaultMaxRetries when node max_retries is absent', () => {
    const dot = `
      digraph G {
        graph [default_max_retries=3]
        my_node []
      }
    `
    const graph = parseGraph(dot)
    const node = graph.nodes.get('my_node')!
    expect(node.maxRetries).toBe(3)
  })

  it('uses node-level max_retries when explicitly set, overriding graph default', () => {
    const dot = `
      digraph G {
        graph [default_max_retries=3]
        my_node [max_retries=7]
      }
    `
    const graph = parseGraph(dot)
    const node = graph.nodes.get('my_node')!
    expect(node.maxRetries).toBe(7)
  })
})

// ---------------------------------------------------------------------------
// AC6: parseGraph() returns populated nodes map and edges array
// ---------------------------------------------------------------------------

describe('node attribute extraction — AC6: populated nodes map and edges array', () => {
  it('returns 3 nodes and 2 edges for a 3-node, 2-edge graph', () => {
    const dot = `
      digraph G {
        A -> B
        B -> C
      }
    `
    const graph = parseGraph(dot)
    expect(graph.nodes.size).toBe(3)
    expect(graph.edges.length).toBe(2)
  })

  it('keys nodes map by node id', () => {
    const dot = `
      digraph G {
        nodeA [label="A"]
        nodeB [label="B"]
        nodeC [label="C"]
      }
    `
    const graph = parseGraph(dot)
    expect(graph.nodes.has('nodeA')).toBe(true)
    expect(graph.nodes.has('nodeB')).toBe(true)
    expect(graph.nodes.has('nodeC')).toBe(true)
    expect(graph.nodes.get('nodeA')!.label).toBe('A')
  })
})

// ---------------------------------------------------------------------------
// AC2 + AC3: Edge attribute extraction — all 6 attributes with correct types
// ---------------------------------------------------------------------------

describe('edge attribute extraction — AC2: all 6 attributes with correct types', () => {
  it('extracts all 6 edge attributes with correct types', () => {
    const dot = `
      digraph G {
        A -> B [
          label="step1"
          condition="status=pass"
          weight=3
          fidelity="high"
          thread_id="thread-2"
          loop_restart=true
        ]
      }
    `
    const graph = parseGraph(dot)
    expect(graph.edges.length).toBe(1)
    const edge = graph.edges[0]!

    // string fields
    expect(typeof edge.label).toBe('string')
    expect(edge.label).toBe('step1')
    expect(typeof edge.condition).toBe('string')
    expect(edge.condition).toBe('status=pass')
    expect(typeof edge.fidelity).toBe('string')
    expect(edge.fidelity).toBe('high')
    expect(typeof edge.threadId).toBe('string')
    expect(edge.threadId).toBe('thread-2')

    // number fields
    expect(typeof edge.weight).toBe('number')
    expect(edge.weight).toBe(3)

    // boolean fields
    expect(typeof edge.loopRestart).toBe('boolean')
    expect(edge.loopRestart).toBe(true)
  })
})

describe('edge attribute extraction — AC3: quoted and unquoted values', () => {
  it('resolves unquoted number weight=3 and quoted condition="status=pass"', () => {
    const dot = `
      digraph G {
        A -> B [weight=3 condition="status=pass"]
      }
    `
    const graph = parseGraph(dot)
    const edge = graph.edges[0]!
    expect(edge.weight).toBe(3)
    expect(edge.condition).toBe('status=pass')
  })
})

// ---------------------------------------------------------------------------
// AC5: Edge default values applied when attributes are absent
// ---------------------------------------------------------------------------

describe('edge attribute extraction — AC5: default values', () => {
  it('applies correct defaults for a bare A -> B edge', () => {
    const dot = `digraph G { A -> B }`
    const graph = parseGraph(dot)
    expect(graph.edges.length).toBe(1)
    const edge = graph.edges[0]!
    expect(edge.label).toBe('')
    expect(edge.condition).toBe('')
    expect(edge.weight).toBe(0)
    expect(edge.fidelity).toBe('')
    expect(edge.threadId).toBe('')
    expect(edge.loopRestart).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// AC6: Edge fromNode / toNode
// ---------------------------------------------------------------------------

describe('edge attribute extraction — AC6: fromNode and toNode', () => {
  it('sets fromNode and toNode correctly for A -> B', () => {
    const dot = `digraph G { A -> B }`
    const graph = parseGraph(dot)
    const edge = graph.edges[0]!
    expect(edge.fromNode).toBe('A')
    expect(edge.toNode).toBe('B')
  })

  it('creates two edges with correct fromNode/toNode for chained A -> B -> C', () => {
    const dot = `digraph G { A -> B -> C }`
    const graph = parseGraph(dot)
    expect(graph.edges.length).toBe(2)
    expect(graph.edges[0]!.fromNode).toBe('A')
    expect(graph.edges[0]!.toNode).toBe('B')
    expect(graph.edges[1]!.fromNode).toBe('B')
    expect(graph.edges[1]!.toNode).toBe('C')
  })
})
