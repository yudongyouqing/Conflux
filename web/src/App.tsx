import { useState, useCallback, useMemo } from "react";
import { Sidebar, type TabId } from "./components/Sidebar";
import { GraphTab } from "./components/GraphTab";
import { MessageTab } from "./components/MessageTab";
import { AgentTab } from "./components/AgentTab";
import { DetailPanel } from "./components/DetailPanel";
import { useGraph } from "./hooks";
import type { Message, GraphNode } from "./types";

export default function App() {
  const [tab, setTab] = useState<TabId>("graph");
  const [selectedSession, setSelectedSession] = useState<GraphNode | null>(null);
  const [selectedMessage, setSelectedMessage] = useState<Message | null>(null);
  const graph = useGraph();

  const nameMap = useMemo(() => {
    const m = new Map<string, string>();
    graph.data?.nodes.forEach((n) => m.set(n.id, n.name));
    return m;
  }, [graph.data]);

  const sessionNameLookup = useCallback(
    (id: string) => nameMap.get(id),
    [nameMap]
  );

  const handleSelectSession = useCallback(
    (sid: string | null) => {
      setSelectedMessage(null);
      if (!sid) {
        setSelectedSession(null);
        return;
      }
      const node = graph.data?.nodes.find((n) => n.id === sid);
      setSelectedSession(node ?? null);
    },
    [graph.data]
  );

  const handleSelectMessage = useCallback((msg: Message | null) => {
    setSelectedSession(null);
    setSelectedMessage(msg);
  }, []);

  return (
    <div className="flex h-full bg-gray-100">
      <Sidebar activeTab={tab} onTabChange={setTab} />
      <div className="flex flex-1 overflow-hidden">
        <main className="flex-1 overflow-hidden">
          {tab === "graph" && (
            <GraphTab
              onSelectSession={handleSelectSession}
              selectedSessionId={selectedSession?.id ?? null}
            />
          )}
          {tab === "messages" && (
            <MessageTab
              onSelectMessage={handleSelectMessage}
              selectedMessageId={selectedMessage?.id ?? null}
            />
          )}
          {tab === "agents" && <AgentTab />}
        </main>
        <aside className="w-80 border-l border-gray-200 bg-white overflow-hidden flex-shrink-0">
          <DetailPanel
            session={selectedSession}
            message={selectedMessage}
            sessionNameLookup={sessionNameLookup}
          />
        </aside>
      </div>
    </div>
  );
}
