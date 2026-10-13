import React, { useState, useRef, useEffect } from 'react';
import { Project, ChatMessage } from '../../types';
import { askCodebaseAI } from '../../services/aiService';
import {
  MessageSquare,
  Send,
  Sparkles,
  Bot,
  User,
  Radio,
  FileCode,
  ArrowRight,
  RefreshCw,
  Copy,
  Check,
  Zap,
} from 'lucide-react';

interface AiChatTabProps {
  project: Project;
  initialPrompt?: string;
  onNavigateTab: (tabId: string, extra?: any) => void;
}

export const AiChatTab: React.FC<AiChatTabProps> = ({
  project,
  initialPrompt,
  onNavigateTab,
}) => {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'msg-welcome',
      role: 'assistant',
      content: `Hello! I am **CodePilot AI**, grounded in the **${project.name}** repository knowledge graph.\n\nI can explain your complete architecture, trace data flows, justify technology choices with concrete evidence snippets, or evaluate change impact. How can I help you explore this codebase today?`,
      timestamp: 'Just now',
      suggestedFollowUps: [
        'Explain the complete architecture',
        `Why is ${project.technologies[0]?.name || 'the database'} used?`,
        'How does authentication work in this project?',
        'What are the main architectural bottlenecks?',
      ],
    },
  ]);

  const [inputQuery, setInputQuery] = useState(initialPrompt || '');
  const [isLoading, setIsLoading] = useState(false);
  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto scroll to bottom
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isLoading]);

  // Handle Initial Prompt if passed from another tab
  useEffect(() => {
    if (initialPrompt && initialPrompt !== inputQuery) {
      setInputQuery(initialPrompt);
    }
  }, [initialPrompt]);

  const handleSendMessage = async (queryText?: string) => {
    const textToSend = queryText || inputQuery;
    if (!textToSend.trim() || isLoading) return;

    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: textToSend,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };

    setMessages(prev => [...prev, userMsg]);
    setInputQuery('');
    setIsLoading(true);

    try {
      const response = await askCodebaseAI(textToSend, project, messages);

      const aiMsg: ChatMessage = {
        id: `ai-${Date.now()}`,
        role: 'assistant',
        content: response.content,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        citations: response.citations,
        suggestedFollowUps: response.suggestedFollowUps,
      };

      setMessages(prev => [...prev, aiMsg]);
    } catch (err) {
      console.error('AI chat error:', err);
      const errorMsg: ChatMessage = {
        id: `err-${Date.now()}`,
        role: 'assistant',
        content: `I encountered an issue processing that query. Please try rephrasing or selecting one of the suggested prompts below.`,
        timestamp: 'Error',
      };
      setMessages(prev => [...prev, errorMsg]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleCopy = (id: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedMsgId(id);
    setTimeout(() => setCopiedMsgId(null), 2000);
  };

  const presetQueries = [
    'Explain the complete architecture',
    `Why is ${project.technologies.find(t => t.category === 'Cache')?.name || 'Redis'} used?`,
    'How does authentication work?',
    'Trace the primary request flow',
    'What happens if I remove the cache?',
  ];

  return (
    <div className="space-y-4 pb-12 flex flex-col h-[740px]">
      {/* Header Banner */}
      <div className="flex items-center justify-between p-4 rounded-2xl bg-[#0e131f] border border-slate-800 shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-purple-500/10 border border-purple-500/30 flex items-center justify-center text-purple-400">
            <Bot className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-bold text-white">AI Codebase Intelligence Assistant</h2>
              <span className="px-2 py-0.5 rounded-full bg-purple-500/10 text-purple-400 font-mono text-[10px] font-bold border border-purple-500/30">
                Grounded RAG
              </span>
            </div>
            <p className="text-[11px] text-slate-400">
              Grounded in {project.name} • {project.technologies.length} verified technologies • {project.nodes.length} architecture nodes
            </p>
          </div>
        </div>

        <button
          onClick={() =>
            setMessages([
              {
                id: 'msg-welcome-reset',
                role: 'assistant',
                content: `Chat session reset. Ready to answer questions on **${project.name}**.`,
                timestamp: 'Just now',
                suggestedFollowUps: presetQueries.slice(0, 3),
              },
            ])
          }
          className="p-2 rounded-xl bg-slate-900 border border-slate-800 text-slate-400 hover:text-white transition-colors"
          title="Reset Chat Session"
        >
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      {/* Preset Quick Question Pills */}
      <div className="flex items-center gap-2 overflow-x-auto pb-1 shrink-0 scrollbar-none">
        <span className="text-[11px] font-mono text-slate-400 uppercase font-semibold shrink-0 pl-1">
          Quick Prompts:
        </span>
        {presetQueries.map((q, idx) => (
          <button
            key={idx}
            onClick={() => handleSendMessage(q)}
            className="px-3 py-1.5 rounded-xl bg-slate-900/90 hover:bg-slate-800 border border-slate-800 text-[11.5px] text-slate-300 hover:text-cyan-300 whitespace-nowrap transition-colors flex items-center gap-1.5 shrink-0"
          >
            <Sparkles className="w-3 h-3 text-cyan-400" />
            <span>{q}</span>
          </button>
        ))}
      </div>

      {/* Messages Scroll Area */}
      <div className="flex-1 bg-[#0e131f] border border-slate-800 rounded-2xl p-4 overflow-y-auto space-y-4 shadow-inner">
        {messages.map(msg => {
          const isAi = msg.role === 'assistant';
          const isCopied = copiedMsgId === msg.id;

          return (
            <div
              key={msg.id}
              className={`flex gap-3 ${isAi ? 'items-start' : 'items-start flex-row-reverse'}`}
            >
              {/* Avatar */}
              <div
                className={`w-8 h-8 rounded-xl shrink-0 flex items-center justify-center ${
                  isAi
                    ? 'bg-purple-500/10 border border-purple-500/30 text-purple-400'
                    : 'bg-brand-500/20 border border-brand-500/30 text-brand-300'
                }`}
              >
                {isAi ? <Bot className="w-4 h-4" /> : <User className="w-4 h-4" />}
              </div>

              {/* Message Bubble */}
              <div
                className={`max-w-2xl rounded-2xl p-4 text-xs space-y-3 shadow-md ${
                  isAi
                    ? 'bg-[#131b2e] border border-slate-800 text-slate-200'
                    : 'bg-brand-600 text-white font-medium'
                }`}
              >
                {/* Content */}
                <div className="whitespace-pre-wrap leading-relaxed space-y-2">
                  {msg.content}
                </div>

                {/* Citations Box */}
                {msg.citations && msg.citations.length > 0 && (
                  <div className="pt-2 border-t border-slate-700/60 space-y-1.5">
                    <span className="text-[10px] font-mono text-cyan-400 uppercase font-semibold flex items-center gap-1">
                      <Radio className="w-3 h-3 text-cyan-400" />
                      Grounded Citations & Source References
                    </span>
                    <div className="space-y-1">
                      {msg.citations.map((cit, idx) => (
                        <div
                          key={idx}
                          className="p-2 rounded-lg bg-slate-950/80 border border-slate-800 flex items-center justify-between text-[11px] font-mono"
                        >
                          <span className="text-slate-300 truncate">
                            {cit.title}: <span className="text-cyan-400">{cit.reference}</span>
                          </span>
                          {cit.line && (
                            <span className="text-slate-500 text-[10px]">line {cit.line}</span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Suggested Follow-Ups Chips */}
                {msg.suggestedFollowUps && msg.suggestedFollowUps.length > 0 && (
                  <div className="pt-2 border-t border-slate-700/60 space-y-1.5">
                    <span className="text-[10px] font-mono text-slate-400 uppercase font-semibold">
                      Suggested Follow-Ups:
                    </span>
                    <div className="flex flex-wrap gap-1.5">
                      {msg.suggestedFollowUps.map((fu, idx) => (
                        <button
                          key={idx}
                          onClick={() => handleSendMessage(fu)}
                          className="px-2.5 py-1 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700 text-[10.5px] text-cyan-300 hover:text-white transition-colors text-left flex items-center gap-1"
                        >
                          <span>{fu}</span>
                          <ArrowRight className="w-2.5 h-2.5" />
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Message Footer: Timestamp & Copy */}
                <div className="flex items-center justify-between text-[10px] text-slate-400 pt-1">
                  <span>{msg.timestamp}</span>
                  {isAi && (
                    <button
                      onClick={() => handleCopy(msg.id, msg.content)}
                      className="hover:text-white flex items-center gap-1 transition-colors"
                      title="Copy response"
                    >
                      {isCopied ? (
                        <>
                          <Check className="w-3 h-3 text-emerald-400" />
                          <span className="text-emerald-400">Copied</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-3 h-3" />
                          <span>Copy</span>
                        </>
                      )}
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}

        {/* Loading Spinner Indicator */}
        {isLoading && (
          <div className="flex gap-3 items-start">
            <div className="w-8 h-8 rounded-xl bg-purple-500/10 border border-purple-500/30 text-purple-400 flex items-center justify-center shrink-0">
              <Bot className="w-4 h-4 animate-spin" />
            </div>
            <div className="p-3.5 rounded-2xl bg-[#131b2e] border border-slate-800 text-xs text-slate-400 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-cyan-400 animate-ping" />
              <span>Traversing Knowledge Graph & Synthesizing Grounded Explanation...</span>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input Form Bar */}
      <form
        onSubmit={e => {
          e.preventDefault();
          handleSendMessage();
        }}
        className="flex items-center gap-2 shrink-0 bg-[#0e131f] border border-slate-800 rounded-2xl p-2 shadow-2xl"
      >
        <input
          type="text"
          placeholder={`Ask anything about ${project.name} (architecture, why tech was chosen, data flows, impact)...`}
          value={inputQuery}
          onChange={e => setInputQuery(e.target.value)}
          disabled={isLoading}
          className="flex-1 bg-transparent px-3 py-2 text-xs text-slate-100 placeholder-slate-500 focus:outline-none"
        />
        <button
          type="submit"
          disabled={!inputQuery.trim() || isLoading}
          className="px-4 py-2.5 rounded-xl bg-gradient-to-r from-brand-600 to-cyan-600 hover:from-brand-500 hover:to-cyan-500 text-white font-medium text-xs disabled:opacity-40 flex items-center gap-1.5 shadow-md shadow-brand-500/20 transition-all shrink-0"
        >
          <Send className="w-3.5 h-3.5" />
          <span>Ask</span>
        </button>
      </form>
    </div>
  );
};
