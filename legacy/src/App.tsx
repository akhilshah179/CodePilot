import React, { useState, useEffect } from 'react';
import { Project, GraphNode } from './types';
import { SAMPLE_PROJECTS } from './data/sampleProjects';
import { Navbar } from './components/layout/Navbar';
import { Sidebar } from './components/layout/Sidebar';
import { CommandPalette } from './components/layout/CommandPalette';
import { OverviewTab } from './components/tabs/OverviewTab';
import { ArchitectureTab } from './components/tabs/ArchitectureTab';
import { TechnologiesTab } from './components/tabs/TechnologiesTab';
import { TraceTab } from './components/tabs/TraceTab';
import { ImpactAnalysisTab } from './components/tabs/ImpactAnalysisTab';
import { AuditTab } from './components/tabs/AuditTab';
import { AiChatTab } from './components/tabs/AiChatTab';
import { InterviewTab } from './components/tabs/InterviewTab';
import { DocsTab } from './components/tabs/DocsTab';
import { FileExplorerTab } from './components/tabs/FileExplorerTab';
import { ImportRepoModal } from './components/modals/ImportRepoModal';
import { ExportModal } from './components/modals/ExportModal';
import { SettingsModal } from './components/modals/SettingsModal';
import { AISettings } from './services/aiService';

export const App: React.FC = () => {
  // Active Project State
  const [currentProject, setCurrentProject] = useState<Project>(SAMPLE_PROJECTS[0]);

  // Navigation State
  const [activeTab, setActiveTab] = useState<string>('overview');
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState<boolean>(false);

  // Selected Node across views
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  // Modals
  const [isImportModalOpen, setIsImportModalOpen] = useState<boolean>(false);
  const [isExportModalOpen, setIsExportModalOpen] = useState<boolean>(false);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState<boolean>(false);
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState<boolean>(false);

  // Sync state
  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const [syncToast, setSyncToast] = useState<string | null>(null);

  // Settings state
  const [aiSettings, setAiSettings] = useState<AISettings>({ provider: 'built-in' });
  const [githubToken, setGithubToken] = useState<string>('');

  // Initial prompt transfer (e.g. from node inspector or trade-off card to chat)
  const [chatInitialPrompt, setChatInitialPrompt] = useState<string>('');

  // Global Keyboard Shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setIsCommandPaletteOpen(prev => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleNavigateTab = (tabId: string, extra?: any) => {
    setActiveTab(tabId);
    if (extra?.targetNodeId) {
      setSelectedNodeId(extra.targetNodeId);
    }
    if (extra?.initialPrompt) {
      setChatInitialPrompt(extra.initialPrompt);
    }
  };

  const handleSyncRepo = () => {
    setIsSyncing(true);
    setSyncToast('Analyzing latest commits & verifying knowledge graph...');
    setTimeout(() => {
      setIsSyncing(false);
      setSyncToast('Repository Knowledge Graph synchronized and up to date.');
      setTimeout(() => setSyncToast(null), 3000);
    }, 1200);
  };

  const renderActiveTab = () => {
    switch (activeTab) {
      case 'overview':
        return (
          <OverviewTab
            project={currentProject}
            onNavigateTab={handleNavigateTab}
            onSelectNode={setSelectedNodeId}
          />
        );
      case 'architecture':
        return (
          <ArchitectureTab
            project={currentProject}
            selectedNodeId={selectedNodeId}
            onSelectNode={setSelectedNodeId}
            onNavigateTab={handleNavigateTab}
          />
        );
      case 'technologies':
        return (
          <TechnologiesTab
            project={currentProject}
            onNavigateTab={handleNavigateTab}
          />
        );
      case 'trace':
        return (
          <TraceTab
            project={currentProject}
            onNavigateTab={handleNavigateTab}
          />
        );
      case 'impact':
        return (
          <ImpactAnalysisTab
            project={currentProject}
            initialNodeId={selectedNodeId || undefined}
            onNavigateTab={handleNavigateTab}
          />
        );
      case 'audit':
        return (
          <AuditTab
            project={currentProject}
            onNavigateTab={handleNavigateTab}
          />
        );
      case 'chat':
        return (
          <AiChatTab
            project={currentProject}
            initialPrompt={chatInitialPrompt}
            onNavigateTab={handleNavigateTab}
          />
        );
      case 'interview':
        return (
          <InterviewTab
            project={currentProject}
            onNavigateTab={handleNavigateTab}
          />
        );
      case 'docs':
        return (
          <DocsTab
            project={currentProject}
            onOpenExportModal={() => setIsExportModalOpen(true)}
          />
        );
      case 'files':
        return (
          <FileExplorerTab
            project={currentProject}
            onNavigateTab={handleNavigateTab}
          />
        );
      default:
        return (
          <OverviewTab
            project={currentProject}
            onNavigateTab={handleNavigateTab}
            onSelectNode={setSelectedNodeId}
          />
        );
    }
  };

  return (
    <div className="min-h-screen bg-[#080b11] text-slate-100 flex flex-col antialiased">
      {/* Top Navigation Bar */}
      <Navbar
        currentProject={currentProject}
        onSelectProject={setCurrentProject}
        onOpenImportModal={() => setIsImportModalOpen(true)}
        onOpenExportModal={() => setIsExportModalOpen(true)}
        onOpenSettingsModal={() => setIsSettingsModalOpen(true)}
        onOpenCommandPalette={() => setIsCommandPaletteOpen(true)}
        isSyncing={isSyncing}
        onSyncRepo={handleSyncRepo}
      />

      {/* Sync Toast Notification */}
      {syncToast && (
        <div className="fixed top-20 right-6 z-40 bg-[#0e131f] border border-cyan-500/40 text-cyan-300 px-4 py-2.5 rounded-xl shadow-2xl text-xs font-mono flex items-center gap-2 animate-in slide-in-from-top-2 duration-200">
          <span className="w-2 h-2 rounded-full bg-cyan-400 animate-ping" />
          <span>{syncToast}</span>
        </div>
      )}

      {/* Main Workspace Layout */}
      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar */}
        <Sidebar
          activeTab={activeTab}
          onTabChange={setActiveTab}
          isCollapsed={isSidebarCollapsed}
          onToggleCollapse={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
          techCount={currentProject.technologies.length}
          auditCount={currentProject.auditItems.length}
        />

        {/* Content Viewport */}
        <main className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8 bg-[#080b11]/80 bg-dots-pattern">
          <div className="max-w-7xl mx-auto">
            {renderActiveTab()}
          </div>
        </main>
      </div>

      {/* Global Modals */}
      <CommandPalette
        isOpen={isCommandPaletteOpen}
        onClose={() => setIsCommandPaletteOpen(false)}
        project={currentProject}
        onSelectNode={nodeId => {
          setSelectedNodeId(nodeId);
          setActiveTab('architecture');
        }}
        onSelectTab={setActiveTab}
      />

      <ImportRepoModal
        isOpen={isImportModalOpen}
        onClose={() => setIsImportModalOpen(false)}
        onProjectImported={p => {
          setCurrentProject(p);
          setActiveTab('overview');
        }}
      />

      <ExportModal
        isOpen={isExportModalOpen}
        onClose={() => setIsExportModalOpen(false)}
        project={currentProject}
      />

      <SettingsModal
        isOpen={isSettingsModalOpen}
        onClose={() => setIsSettingsModalOpen(false)}
        aiSettings={aiSettings}
        onSaveAISettings={setAiSettings}
        githubToken={githubToken}
        onSaveGithubToken={setGithubToken}
      />
    </div>
  );
};

export default App;
