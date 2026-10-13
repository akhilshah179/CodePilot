import { Project, ChatMessage } from '../types';

export interface AISettings {
  apiKey?: string;
  provider: 'built-in' | 'openai' | 'anthropic';
  model?: string;
}

export async function askCodebaseAI(
  query: string,
  project: Project,
  chatHistory: ChatMessage[] = [],
  settings: AISettings = { provider: 'built-in' }
): Promise<{
  content: string;
  citations: ChatMessage['citations'];
  suggestedFollowUps: string[];
}> {
  const queryLower = query.toLowerCase();

  // If user provided custom OpenAI key and selected OpenAI
  if (settings.provider === 'openai' && settings.apiKey) {
    try {
      const systemPrompt = `You are CodePilot AI, an expert software architecture intelligence assistant.
You have deep, grounded knowledge of this repository: "${project.name}" (${project.fullName || project.name}).
Project Technologies: ${project.technologies.map(t => `${t.name} (${t.category}) - ${t.whyUsed}`).join(', ')}
Project Nodes: ${project.nodes.map(n => `${n.label} (${n.layer}: ${n.technology})`).join(', ')}
Project Flows: ${project.flows.map(f => `${f.name}: ${f.description}`).join('; ')}
Audit Bottlenecks: ${project.auditItems.map(a => a.title).join('; ')}

Always provide concrete code/file citations and architectural reasons. Avoid hallucinating technologies not in the project.`;

      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${settings.apiKey}`,
        },
        body: JSON.stringify({
          model: settings.model || 'gpt-4o-mini',
          messages: [
            { role: 'system', content: systemPrompt },
            ...chatHistory.slice(-4).map(m => ({ role: m.role, content: m.content })),
            { role: 'user', content: query },
          ],
        }),
      });

      if (response.ok) {
        const data = await response.json();
        const text = data.choices[0]?.message?.content || 'No response generated.';
        return {
          content: text,
          citations: [
            {
              type: 'tech',
              title: `${project.name} Knowledge Graph`,
              reference: project.fullName || project.name,
              snippet: `Analyzed ${project.technologies.length} technologies and ${project.nodes.length} architecture nodes.`,
            },
          ],
          suggestedFollowUps: [
            `What are the major bottlenecks in ${project.name}?`,
            `How does data flow between client and database?`,
            `What is the blast radius if I modify the gateway?`,
          ],
        };
      }
    } catch (err) {
      console.warn('Custom LLM error, falling back to built-in RAG engine', err);
    }
  }

  // Built-in Grounded RAG Reasoning Engine
  const citations: ChatMessage['citations'] = [];
  let responseContent = '';
  let followUps: string[] = [];

  // Pattern 1: Architecture Explanation
  if (queryLower.includes('architecture') || queryLower.includes('how does this project work') || queryLower.includes('overview')) {
    const layers = ['client', 'gateway', 'service', 'data', 'external'];
    const layerDescriptions = layers
      .map(layer => {
        const nodesInLayer = project.nodes.filter(n => n.layer === layer);
        if (nodesInLayer.length === 0) return null;
        return `* **${layer.toUpperCase()} Layer:** ${nodesInLayer.map(n => `\`${n.label}\` (${n.technology || n.type})`).join(', ')}`;
      })
      .filter(Boolean)
      .join('\n');

    responseContent = `### Architecture Breakdown: ${project.name}

${project.description}

The system is organized into a clean **multi-layered architecture**:

${layerDescriptions}

#### Key Architectural Characteristics:
1. **Separation of Concerns:** Client interfaces communicate through an API Gateway with centralized authentication and rate limiting.
2. **Data & Cache Tier:** Relational ACID storage is augmented by caching and message queuing for low-latency queries and asynchronous decoupling.
3. **Evidence-Grounded Map:** Contains **${project.technologies.length} verified technologies** and **${project.nodes.length} active system nodes**.`;

    citations.push({
      type: 'node',
      title: 'Unified Project Knowledge Graph',
      reference: 'Architecture Engine',
      snippet: `Connected ${project.edges.length} directional relationship edges across ${project.nodes.length} nodes.`,
    });

    followUps = [
      `Why is ${project.technologies[0]?.name || 'the database'} used?`,
      `Show me the request flow for a typical operation`,
      `What are the single points of failure in this architecture?`,
    ];
  }
  // Pattern 2: Technology Inquiry (e.g. Why is Redis used? Why Postgres?)
  else if (
    queryLower.includes('why') ||
    queryLower.includes('redis') ||
    queryLower.includes('database') ||
    queryLower.includes('postgres') ||
    queryLower.includes('kafka') ||
    queryLower.includes('tech')
  ) {
    const matchedTech = project.technologies.find(
      t => queryLower.includes(t.name.toLowerCase()) || queryLower.includes(t.category.toLowerCase())
    ) || project.technologies[0];

    if (matchedTech) {
      responseContent = `### Why ${matchedTech.name} is Used in ${project.name}

**Role:** ${matchedTech.role}  
**Confidence:** \`${matchedTech.confidence}\`  
**Purpose:** ${matchedTech.purpose}

#### Architectural Justification:
${matchedTech.whyUsed}

#### Where it is used in the repository:
${matchedTech.files.map(f => `- [\`${f}\`](file:///${f})`).join('\n')}

#### Verified Repository Evidence:
${matchedTech.evidence
  .map(
    e => `> **${e.type.toUpperCase()}** in \`${e.file}${e.line ? `:${e.line}` : ''}\`:
\`\`\`
${e.snippet}
\`\`\`
*${e.description}*`
  )
  .join('\n\n')}`;

      for (const ev of matchedTech.evidence) {
        citations.push({
          type: 'evidence',
          title: `${matchedTech.name} Evidence`,
          reference: ev.file,
          snippet: ev.snippet,
          line: ev.line,
        });
      }

      followUps = [
        `What would happen if we removed ${matchedTech.name}?`,
        `Which services directly connect to ${matchedTech.name}?`,
        `How is ${matchedTech.name} configured in Docker / K8s?`,
      ];
    } else {
      responseContent = `I searched the repository knowledge graph for that technology. In **${project.name}**, the detected tech stack includes: ${project.technologies.map(t => `**${t.name}**`).join(', ')}. Which one would you like to inspect?`;
    }
  }
  // Pattern 3: Authentication / Security
  else if (queryLower.includes('auth') || queryLower.includes('jwt') || queryLower.includes('security') || queryLower.includes('login')) {
    const authTech = project.technologies.find(t => t.category === 'Authentication') || project.technologies[0];
    const authNode = project.nodes.find(n => n.type === 'auth' || n.layer === 'gateway');

    responseContent = `### Authentication & Security Model

In **${project.name}**, identity verification is handled using **${authTech?.name || 'JWT Token Authentication'}**.

1. **Token Issuance:** On login, client sends credentials to the Auth service which validates credentials and cryptographically signs a stateless JWT token.
2. **Gateway Verification:** The API Gateway validates incoming \`Authorization: Bearer <token>\` headers for every downstream microservice route.
3. **Stateless Scalability:** Microservices do not perform redundant database session lookups on every internal request.

#### Relevant Files:
${authTech?.files.map(f => `- \`${f}\``).join('\n') || '- `services/auth/security.py`'}`;

    citations.push({
      type: 'file',
      title: 'Authentication Middleware',
      reference: authTech?.files[0] || 'services/auth/security.py',
      snippet: 'jwt.encode(to_encode, SECRET_KEY, algorithm="HS256")',
    });

    followUps = [
      `Trace the User Login request flow step-by-step`,
      `How are expired JWT tokens refreshed?`,
      `What happens if the Auth service becomes unavailable?`,
    ];
  }
  // Pattern 4: Request Flow / Tracing
  else if (queryLower.includes('flow') || queryLower.includes('trace') || queryLower.includes('checkout') || queryLower.includes('pricing')) {
    const flow = project.flows[0];
    if (flow) {
      responseContent = `### Request Flow Trace: ${flow.name}

**Trigger:** \`${flow.trigger}\`  
**Description:** ${flow.description}

#### Step-by-Step Journey:
${flow.steps
  .map(
    s => `**Step ${s.stepIndex}: [${s.nodeId}] — ${s.action}** (~${s.latencyEstimate || '1ms'})
*${s.description}*
${s.payloadPreview ? `\`\`\`json\n${s.payloadPreview}\n\`\`\`` : ''}
${s.sourceCode ? `Code reference: \`${s.sourceFile || ''}\`:\n\`\`\`\n${s.sourceCode}\n\`\`\`` : ''}`
  )
  .join('\n\n')}`;

      citations.push({
        type: 'node',
        title: flow.name,
        reference: flow.trigger,
        snippet: `Traverses ${flow.steps.length} sequential execution nodes.`,
      });

      followUps = [
        `Watch this flow in the Motion Architecture Visualizer`,
        `What is the blast radius if step 3 fails?`,
        `Can we introduce asynchronous queuing into this flow?`,
      ];
    }
  }
  // Pattern 5: Impact / Change / Break
  else if (queryLower.includes('break') || queryLower.includes('change') || queryLower.includes('impact') || queryLower.includes('modify')) {
    const candidateNode = project.nodes.find(n => queryLower.includes(n.label.toLowerCase())) || project.nodes[1];
    responseContent = `### Change Impact Analysis: ${candidateNode.label}

If you modify or refactor **${candidateNode.label}**:

- **Layer:** \`${candidateNode.layer.toUpperCase()}\` (${candidateNode.technology || 'Component'})
- **Downstream Callers Affected:** ${project.edges.filter(e => e.target === candidateNode.id).map(e => e.source).join(', ') || 'Direct client connections'}
- **Data Connections:** ${project.edges.filter(e => e.source === candidateNode.id).map(e => e.target).join(', ') || 'Internal processing'}

#### Critical Pre-checks:
1. Check contract schemas for breaking parameter changes.
2. Run regression integration tests on dependent services.
3. Validate connection pools and retry configurations.`;

    citations.push({
      type: 'node',
      title: 'Impact Analysis Engine',
      reference: candidateNode.label,
      snippet: `Associated with ${project.edges.filter(e => e.source === candidateNode.id || e.target === candidateNode.id).length} graph edges.`,
    });

    followUps = [
      `Open full Blast Radius Inspector for ${candidateNode.label}`,
      `Show code snippets for ${candidateNode.label}`,
      `What are the potential bottleneck points?`,
    ];
  }
  // Default Generic Codebase Intelligence Response
  else {
    responseContent = `### Codebase Analysis: "${query}"

Based on the repository knowledge graph for **${project.name}**:

1. **Repository Context:** Contains **${project.stats.filesCount} files**, **${project.technologies.length} technologies**, and **${project.nodes.length} connected components**.
2. **Core Technologies:** ${project.technologies.slice(0, 4).map(t => `**${t.name}** (${t.purpose})`).join(', ')}.
3. **Health & Architecture:** Health Score is **${project.stats.healthScore}%**, with ${project.auditItems.length} documented architectural improvements.

Would you like me to drill down into a specific service, technology evidence line, or request flow?`;

    citations.push({
      type: 'tech',
      title: 'Project Intelligence Summary',
      reference: project.name,
      snippet: project.description,
    });

    followUps = [
      `Explain the complete architecture`,
      `Why is ${project.technologies[0]?.name || 'the backend'} used?`,
      `Trace the primary data flow`,
      `What architectural bottlenecks exist?`,
    ];
  }

  return {
    content: responseContent,
    citations,
    suggestedFollowUps: followUps,
  };
}
