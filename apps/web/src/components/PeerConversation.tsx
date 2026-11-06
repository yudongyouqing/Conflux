import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Send } from "lucide-react";
import { WEB_CONSOLE_ID, type GraphNode } from "@conflux/shared";
import { api } from "../api";
import { usePeerMessages } from "../hooks";
import { targetKey, type Draft } from "../workspace-state";
import { MarkdownText } from "./MarkdownText";
import { MessageDeliveryControl } from "./MessageDeliveryControl";

export interface PeerConversationProps {
  /** The peer's FULL session id — display names never route messages. */
  peerId: string;
  peerNode?: GraphNode;
  active: boolean;
  draft: Draft;
  onDraftChange: (text: string) => void;
  /** Called with the submit-time key/revision so only that snapshot clears. */
  onSubmitted: (targetKey: string, revision: number) => void;
}

interface PeerAskInput {
  to_session: string;
  question: string;
  /** Captured at submit time: typing that continues in flight must survive. */
  revision: number;
}

/**
 * One web-console ↔ peer thread. Speaks exclusively over the existing
 * /web/peer-messages read and /web/ask send paths — a session conversation
 * is never a fake room. The composer is controlled by the workspace so the
 * draft survives view switches and only the exact submitted snapshot is
 * cleared on success.
 */
export function PeerConversation({
  peerId,
  peerNode,
  active,
  draft,
  onDraftChange,
  onSubmitted,
}: PeerConversationProps) {
  const thread = usePeerMessages(peerId, active);
  const queryClient = useQueryClient();
  const peerName = peerNode?.name ?? peerId.slice(0, 8);
  const offline = peerNode && peerNode.status !== "active";

  const ask = useMutation({
    mutationFn: ({ revision: _revision, ...body }: PeerAskInput) => {
      void _revision;
      return api.webAsk(body);
    },
    retry: false,
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ["peer-messages"] });
      queryClient.invalidateQueries({ queryKey: ["messages"] });
      queryClient.invalidateQueries({ queryKey: ["graph"] });
      onSubmitted(targetKey({ kind: "session", id: vars.to_session }), vars.revision);
    },
  });

  const send = () => {
    const question = draft.text.trim();
    if (!question || ask.isPending) return;
    ask.mutate({ to_session: peerId, question, revision: draft.revision });
  };

  const messages = thread.data?.messages ?? [];

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex-1 overflow-y-auto p-4 min-h-0">
        <div className="max-w-3xl mx-auto space-y-2">
          {thread.isLoading && messages.length === 0 && (
            <div className="flex justify-center py-8">
              <Loader2 size={16} className="text-ink-faint animate-spin" />
            </div>
          )}
          {thread.isError && messages.length === 0 && (
            <div role="alert" className="text-center py-8 space-y-2">
              <div className="text-xs text-danger">消息加载失败：{(thread.error as Error).message}</div>
              <button
                type="button"
                onClick={() => thread.refetch()}
                className="px-3 py-1.5 rounded-lg bg-accent-soft text-accent text-xs font-medium hover:bg-accent-soft"
              >
                重试
              </button>
            </div>
          )}
          {thread.isError && messages.length > 0 && (
            <div className="text-2xs text-amber-700 text-center">
              连接中断，显示上次获取的内容
            </div>
          )}
          {!thread.isLoading && messages.length === 0 && (
            <div className="text-xs text-ink-faint text-center py-6">暂无往来消息</div>
          )}
          {messages.map((m) => {
            // Ask and answer are SEPARATE bubbles: the question rides the
            // asker's side, the reply the answerer's — a chat exchange, not
            // a Q/A card.
            const mine = m.from_session === WEB_CONSOLE_ID;
            return (
              <div key={m.id} className="space-y-2">
                <div className={`flex ${mine ? "justify-end" : "justify-start"}`}>
                  <div className="max-w-[85%] sm:max-w-[68%] min-w-0">
                    <div
                      className={`rounded-xl px-3 py-2 text-xs ${
                        mine ? "bg-accent text-on-accent" : "bg-paper text-ink border border-line"
                      }`}
                    >
                      <MarkdownText tone={mine ? "blue" : "light"}>{m.question}</MarkdownText>
                      {mine && m.status === "pending" && (
                        <div className="mt-1 text-2xs text-on-accent/80">等待对方读取…</div>
                      )}
                    </div>
                    <MessageDeliveryControl message={m} />
                  </div>
                </div>
                {m.reply && (
                  <div className={`flex ${mine ? "justify-start" : "justify-end"}`}>
                    <div className="max-w-[68%] rounded-xl px-3 py-2 text-xs bg-paper text-ink border border-line">
                      <MarkdownText>{m.reply}</MarkdownText>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="p-3 bg-surface border-t border-line">
        <div className="flex items-center gap-2 max-w-3xl mx-auto">
          <input
            type="text"
            aria-label={`向 ${peerName} 提问`}
            placeholder={`向 ${peerName} 提问…（回车发送）`}
            value={draft.text}
            onChange={(e) => onDraftChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
            className="flex-1 min-w-0 bg-surface text-ink text-sm rounded-lg px-3 py-2 border border-line placeholder-ink-faint outline-none focus:border-accent"
          />
          <button
            type="button"
            onClick={send}
            disabled={!draft.text.trim() || ask.isPending}
            className="inline-flex items-center gap-1.5 text-sm text-on-accent bg-accent hover:bg-accent-deep rounded-lg px-3 py-2 disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0"
          >
            {ask.isPending ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
            发送
          </button>
        </div>
        {offline && (
          <div className="max-w-3xl mx-auto mt-1 text-2xs text-amber-700">
            {peerName} 当前{peerNode?.status === "ended" ? "已结束" : "离线"}，发送后将按现有规则尝试唤醒
          </div>
        )}
        {ask.isError && (
          <div role="alert" className="max-w-3xl mx-auto text-xs text-danger mt-1">
            发送失败：{(ask.error as Error).message}。草稿已保留，请核对记录后重试
          </div>
        )}
      </div>
    </div>
  );
}
