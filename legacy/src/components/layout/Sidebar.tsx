import React from 'react';
import {
  LayoutDashboard,
  Network,
  Cpu,
  Activity,
  AlertTriangle,
  GitPullRequest,
  MessageSquare,
  GraduationCap,
  FileText,
  FolderTree,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';

export interface TabItem {
  id: string;
  label: string;
  icon: React.ElementType;
  badge?: string | number;
  color?: string;
}

interface SidebarProps {
  activeTab: string;
  onTabChange: (tabId: string) => void;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  techCount?: number;
  auditCount?: number;
}

export const Sidebar: React.FC<SidebarProps> = ({
  activeTab,
  onTabChange,
  isCollapsed,
  onToggleCollapse,
  techCount = 0,
  auditCount = 0,
}) => {
  const tabs: TabItem[] = [
    { id: 'overview', label: 'Overview', icon: LayoutDashboard },
    { id: 'architecture', label: 'Architecture & Motion', icon: Network, badge: 'Live', color: 'cyan' },
    { id: 'technologies', label: 'Technologies & Evidence', icon: Cpu, badge: techCount || undefined },
    { id: 'trace', label: 'Request Flow Trace', icon: Activity },
    { id: 'impact', label: 'Impact & Blast Radius', icon: AlertTriangle },
    { id: 'audit', label: 'Architecture Audit', icon: GitPullRequest, badge: auditCount || undefined, color: 'amber' },
    { id: 'chat', label: 'AI Codebase Chat', icon: MessageSquare, badge: 'RAG', color: 'purple' },
    { id: 'interview', label: 'Interview Mode', icon: GraduationCap },
    { id: 'docs', label: 'Documentation', icon: FileText },
    { id: 'files', label: 'File Explorer & AST', icon: FolderTree },
  ];

  return (
    <aside
      className={`border-r border-slate-800 bg-[#080b11] transition-all duration-300 flex flex-col justify-between z-20 ${
        isCollapsed ? 'w-16' : 'w-64'
      }`}
    >
      {/* Navigation Links */}
      <div className="p-3 space-y-1 overflow-y-auto">
        {!isCollapsed && (
          <div className="px-3 py-2 text-[10px] font-bold text-slate-400 uppercase tracking-wider font-mono">
            Intelligence Modules
          </div>
        )}

        {tabs.map(tab => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;

          return (
            <button
              key={tab.id}
              onClick={() => onTabChange(tab.id)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-xs font-medium transition-all group relative ${
                isActive
                  ? 'bg-brand-600/15 text-white border border-brand-500/30 shadow-md shadow-brand-500/10'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/60 border border-transparent'
              }`}
              title={isCollapsed ? tab.label : undefined}
            >
              <div
                className={`transition-colors ${
                  isActive
                    ? 'text-cyan-400'
                    : 'text-slate-400 group-hover:text-slate-300'
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
              </div>

              {!isCollapsed && (
                <div className="flex-1 flex items-center justify-between truncate text-left">
                  <span className="truncate">{tab.label}</span>
                  {tab.badge && (
                    <span
                      className={`px-1.5 py-0.5 rounded-full text-[9.5px] font-mono font-bold shrink-0 ${
                        tab.color === 'cyan'
                          ? 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/30'
                          : tab.color === 'amber'
                          ? 'bg-amber-500/10 text-amber-400 border border-amber-500/30'
                          : tab.color === 'purple'
                          ? 'bg-purple-500/10 text-purple-400 border border-purple-500/30'
                          : 'bg-slate-800 text-slate-400'
                      }`}
                    >
                      {tab.badge}
                    </span>
                  )}
                </div>
              )}

              {/* Collapsed Active Indicator Pill */}
              {isCollapsed && isActive && (
                <div className="absolute right-1 w-1 h-5 rounded-full bg-cyan-400" />
              )}
            </button>
          );
        })}
      </div>

      {/* Collapse / Expand Toggle Button */}
      <div className="p-3 border-t border-slate-800/80">
        <button
          onClick={onToggleCollapse}
          className="w-full flex items-center justify-center p-2 rounded-xl bg-slate-900/60 hover:bg-slate-800 text-slate-400 hover:text-white transition-colors text-xs"
          title={isCollapsed ? 'Expand Sidebar' : 'Collapse Sidebar'}
        >
          {isCollapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
          {!isCollapsed && <span className="ml-2 text-[11px]">Collapse View</span>}
        </button>
      </div>
    </aside>
  );
};
