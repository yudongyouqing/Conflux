import type { Agent, GraphNode, RuntimeAgent, RuntimeInstance } from "@conflux/shared";

/**
 * Deterministic projection from the raw agent/preset/instance/session data
 * to the unified assistants page. Association is by IDENTITY ONLY —
 * preset_id, node agent_id, instance session_id — never by name, title or
 * recency. Same-name objects stay separate items; a coding preset and a
 * model agent with equal numeric ids are different keys. Raw objects pass
 * through untouched: no derived summary here contains api_key/extra_env.
 */

export interface CodingAssistantItem {
  key: `coding:${number}`;
  preset: RuntimeAgent;
  instances: RuntimeInstance[];
  sessions: GraphNode[];
}

export interface AssistantCatalog {
  coding: CodingAssistantItem[];
  models: Array<{ key: `model:${number}`; agent: Agent }>;
  /** Instances whose preset no longer exists — control and history stay. */
  orphanInstances: RuntimeInstance[];
}

export function buildAssistantCatalog(
  agents: readonly Agent[],
  presets: readonly RuntimeAgent[],
  instances: readonly RuntimeInstance[],
  nodes: readonly GraphNode[],
): AssistantCatalog {
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  const coding: CodingAssistantItem[] = presets.map((preset) => ({
    key: `coding:${preset.id}` as const,
    preset,
    instances: [],
    sessions: [],
  }));
  const itemByPresetId = new Map(coding.map((item) => [item.preset.id, item]));

  // instances land on their preset by preset_id; preset-less ones are orphans
  const orphanInstances: RuntimeInstance[] = [];
  for (const inst of instances) {
    const item = itemByPresetId.get(inst.preset_id);
    if (item) item.instances.push(inst);
    else orphanInstances.push(inst);
  }

  // session attachment: an instance's real session binding wins over the
  // node's agent_id derivation, and one session never lands twice
  const claimedBy = new Map<string, number>(); // session id → preset id
  for (const item of coding) {
    for (const inst of item.instances) {
      if (inst.session_id && nodeById.has(inst.session_id) && !claimedBy.has(inst.session_id)) {
        claimedBy.set(inst.session_id, item.preset.id);
      }
    }
  }
  for (const item of coding) {
    const viaInstances = item.instances
      .filter((inst) => inst.session_id && claimedBy.get(inst.session_id) === item.preset.id)
      .map((inst) => nodeById.get(inst.session_id!))
      .filter((n): n is GraphNode => !!n);
    const viaAgentId = nodes.filter(
      (n) => n.agent_id === item.preset.id && !claimedBy.has(n.id),
    );
    for (const n of viaAgentId) claimedBy.set(n.id, item.preset.id);
    const seen = new Set<string>();
    item.sessions = [...viaInstances, ...viaAgentId].filter((n) => {
      if (seen.has(n.id)) return false;
      seen.add(n.id);
      return true;
    });
  }

  return {
    coding,
    models: agents.map((agent) => ({ key: `model:${agent.id}` as const, agent })),
    orphanInstances,
  };
}
