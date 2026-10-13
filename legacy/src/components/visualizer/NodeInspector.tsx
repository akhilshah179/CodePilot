import React from 'react';
import { GraphNode, Project, GraphEdge } from '../../types';
import { EvidenceBadge } from './EvidenceBadge';
import { X, ArrowRight, ArrowLeft, Radio, FileCode, Zap, MessageSquare, AlertTriangle, Layers, Activity } from 'lucide-react';

interface NodeInspectorProps {
  node: GraphNode | null;
  project: Project;
  onClose: () => void;
  onSelectNode: (nodeId: string) => void;
  onNavigateTab: (tab: string, extra?: any) => void;
}

export const NodeInspector: React.FC<NodeInspectorProps> = ({
  node,
  project,
  onClose,
  onSelectNode,
  onNavigateTab,
}) => {
  if (!node) return null;

  // Find incoming callers and outgoing targets
  const incomingEdges: GraphEdge[] = project.edges.filter(e => e.target === node.id);
  const outgoingEdges: GraphEdge[] = project.edges.filter(e => e.source === node.id);

  // Find associated technology
  const associatedTech = project.technologies.find(
    t => t.name.toLowerCase() === node.label.toLowerCase() || (node.technology && node.technology.toLowerCase().includes(t.name.toLowerCase()))
  );

  return (
    <div className="w-96 border-l border-slate-800 bg-[#0e131f]/95 backdrop-blur-xl flex flex-col h-full shadow-2xl z-20 transition-all duration-300">
      {/* Header */}
      <div className="p-4 border-b border-slate-800 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-brand-500/10 border border-brand-500/30 flex items-center justify-center text-brand-400">
            <Layers className="w-4 h-4" />
          </div>
          <div>
            <h3 className="font-semibold text-white text-sm tracking-wide">{node.label}</h3>
            <span className="text-xs text-slate-400 capitalize">{node.layer} Layer • {node.type}</span>
          </div>
        </div>
        <button
          onClick={onClose}
          className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800/60 transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Body */}
      <div className="p-4 overflow-y-auto space-y-5 flex-1 text-xs">
        {/* Confidence & Quick Badges */}
        <div className="flex items-center justify-between">
          <span className="text-slate-400 font-medium">Confidence Level</span>
          <EvidenceBadge confidence={node.confidence} />
        </div>

        {/* Technology / Framework Tag */}
        {node.technology && (
          <div className="p-2.5 rounded-lg bg-slate-900/80 border border-slate-800 flex items-center justify-between">
            <span className="text-slate-400">Technology</span>
            <span className="font-mono text-brand-300 font-medium">{node.technology}</span>
          </div>
        )}

        {/* File Path */}
        {node.filePath && (
          <div className="space-y-1">
            <span className="text-slate-400 font-medium flex items-center gap-1.5">
              <FileCode className="w-3.5 h-3.5 text-slate-400" />
              Source File
            </span>
            <div className="p-2 rounded bg-slate-900/60 border border-slate-800 font-mono text-[11px] text-cyan-400 break-all">
              {node.filePath}
            </div>
          </div>
        )}

        {/* Description & Purpose */}
        <div className="space-y-1.5">
          <span className="text-slate-400 font-medium">Architectural Role & Purpose</span>
          <p className="text-slate-200 leading-relaxed bg-slate-900/40 p-2.5 rounded-lg border border-slate-800/80">
            {node.description}
          </p>
        </div>

        {/* Why Used (Architectural Reason) */}
        {associatedTech?.whyUsed && (
          <div className="space-y-1.5">
            <span className="text-slate-400 font-medium text-amber-300 flex items-center gap-1.5">
              <Zap className="w-3.5 h-3.5 text-amber-400" />
              Why It Was Chosen
            </span>
            <p className="text-slate-300 leading-relaxed bg-amber-500/5 p-2.5 rounded-lg border border-amber-500/20 text-[11.5px]">
              {associatedTech.whyUsed}
            </p>
          </div>
        )}

        {/* Direct Connections: Callers */}
        <div className="space-y-2">
          <span className="text-slate-400 font-medium flex items-center gap-1.5">
            <ArrowLeft className="w-3.5 h-3.5 text-blue-400" />
            Upstream Callers ({incomingEdges.length})
          </span>
          {incomingEdges.length === 0 ? (
            <p className="text-slate-500 italic text-[11px]">No upstream callers (Entry point)</p>
          ) : (
            <div className="space-y-1.5">
              {incomingEdges.map(edge => {
                const sourceNode = project.nodes.find(n => n.id === edge.source);
                return (
                  <button
                    key={edge.id}
                    onClick={() => onSelectNode(edge.source)}
                    className="w-full text-left p-2 rounded-lg bg-slate-900/50 hover:bg-slate-800/80 border border-slate-800 flex items-center justify-between transition-colors group"
                  >
                    <span className="text-slate-200 group-hover:text-brand-300 font-medium">
                      {sourceNode?.label || edge.source}
                    </span>
                    <span className="text-[10px] text-slate-500 font-mono">{edge.relation}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Direct Connections: Callees */}
        <div className="space-y-2">
          <span className="text-slate-400 font-medium flex items-center gap-1.5">
            <ArrowRight className="w-3.5 h-3.5 text-emerald-400" />
            Downstream Dependencies ({outgoingEdges.length})
          </span>
          {outgoingEdges.length === 0 ? (
            <p className="text-slate-500 italic text-[11px]">Leaf component / Terminal store</p>
          ) : (
            <div className="space-y-1.5">
              {outgoingEdges.map(edge => {
                const targetNode = project.nodes.find(n => n.id === edge.target);
                return (
                  <button
                    key={edge.id}
                    onClick={() => onSelectNode(edge.target)}
                    className="w-full text-left p-2 rounded-lg bg-slate-900/50 hover:bg-slate-800/80 border border-slate-800 flex items-center justify-between transition-colors group"
                  >
                    <span className="text-slate-200 group-hover:text-emerald-300 font-medium">
                      {targetNode?.label || edge.target}
                    </span>
                    <span className="text-[10px] text-slate-500 font-mono">{edge.relation}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Evidence Snippets */}
        {node.evidence && node.evidence.length > 0 && (
          <div className="space-y-2">
            <span className="text-slate-400 font-medium flex items-center gap-1.5">
              <Radio className="w-3.5 h-3.5 text-brand-400" />
              Verified Repository Evidence ({node.evidence.length})
            </span>
            <div className="space-y-2">
              {node.evidence.map((ev, i) => (
                <div key={i} className="p-2.5 rounded-lg bg-slate-950 border border-slate-800 space-y-1.5">
                  <div className="flex items-center justify-between text-[10px]">
                    <span className="text-slate-400 font-mono">{ev.file}{ev.line ? `:${ev.line}` : ''}</span>
                    <span className="text-brand-400 font-semibold uppercase">{ev.type}</span>
                  </div>
                  <pre className="p-2 rounded bg-slate-900 font-mono text-[11px] text-emerald-300 overflow-x-auto whitespace-pre-wrap">
                    {ev.snippet}
                  </pre>
                  <p className="text-[11px] text-slate-400 italic">{ev.description}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Footer Quick Actions */}
      <div className="p-3 border-t border-slate-800 bg-slate-950/60 flex flex-col gap-2">
        <button
          onClick={() => onNavigateTab('impact', { targetNodeId: node.id })}
          className="w-full py-2 px-3 rounded-lg bg-brand-600/20 hover:bg-brand-600/30 text-brand-300 border border-brand-500/30 font-medium text-xs flex items-center justify-center gap-2 transition-colors"
        >
          <AlertTriangle className="w-3.5 h-3.5 text-brand-400" />
          Simulate Blast Radius Impact
        </button>
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => onNavigateTab('trace')}
            className="py-1.5 px-2 rounded-lg bg-slate-800/80 hover:bg-slate-800 text-slate-300 border border-slate-700 text-[11px] font-medium flex items-center justify-center gap-1.5 transition-colors"
          >
            <Activity className="w-3 h-3 text-cyan-400" />
            Trace Flow
          </button>
          <button
            onClick={() => onNavigateTab('chat', { initialPrompt: `Explain the architectural role of ${node.label} in ${project.name} and why it connects to ${outgoingEdges.map(e => e.target).join(', ')}.` })}
            className="py-1.5 px-2 rounded-lg bg-slate-800/80 hover:bg-slate-800 text-slate-300 border border-slate-700 text-[11px] font-medium flex items-center justify-center gap-1.5 transition-colors"
          >
            <MessageSquare className="w-3 h-3 text-purple-400" />
            Ask AI
          </button>
        </div>
      </div>
    </div>
  );
};
