import React, { useState } from 'react';
import { Project, InterviewQuestion } from '../../types';
import {
  GraduationCap,
  Clock,
  Mic,
  FileCode,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Sparkles,
  HelpCircle,
  Award,
} from 'lucide-react';

interface InterviewTabProps {
  project: Project;
  onNavigateTab: (tabId: string, extra?: any) => void;
}

export const InterviewTab: React.FC<InterviewTabProps> = ({ project, onNavigateTab }) => {
  const [activePitchType, setActivePitchType] = useState<'30s' | '2m' | '5m'>('30s');
  const [expandedQuestionId, setExpandedQuestionId] = useState<string | null>(
    project.interview.technicalQuestions[0]?.id || null
  );

  const getDifficultyBadge = (diff: InterviewQuestion['difficulty']) => {
    switch (diff) {
      case 'Staff':
        return 'bg-purple-500/10 text-purple-400 border-purple-500/30';
      case 'Advanced':
        return 'bg-rose-500/10 text-rose-400 border-rose-500/30';
      default:
        return 'bg-blue-500/10 text-blue-400 border-blue-500/30';
    }
  };

  return (
    <div className="space-y-6 pb-12">
      {/* Header Banner */}
      <div className="p-5 rounded-2xl bg-[#0e131f] border border-slate-800 shadow-xl space-y-2">
        <div className="flex items-center gap-2">
          <span className="px-2.5 py-0.5 rounded-full bg-amber-500/10 text-amber-400 font-mono text-[11px] font-bold border border-amber-500/30 flex items-center gap-1">
            <GraduationCap className="w-3.5 h-3.5" />
            PROJECT INTERVIEW & PLACEMENT MODE
          </span>
          <span className="text-xs text-slate-400 font-mono">
            Derived from repository architecture and code evidence
          </span>
        </div>
        <h2 className="text-xl font-bold text-white tracking-tight">
          Explain Your Project in Technical Interviews
        </h2>
        <p className="text-xs text-slate-400 max-w-3xl leading-relaxed">
          Master how to present this codebase with tailored 30s, 2-minute, and 5-minute architecture walkthroughs, plus hard technical questions based on real implementation decisions.
        </p>
      </div>

      {/* Pitch Length Toggle Tabs */}
      <div className="bg-[#0e131f] border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4">
        <div className="flex items-center justify-between border-b border-slate-800 pb-3">
          <div className="flex items-center gap-2">
            <Mic className="w-4 h-4 text-amber-400" />
            <h3 className="font-bold text-white text-sm">System Walkthrough Pitch</h3>
          </div>

          <div className="flex items-center gap-1.5 bg-slate-900 p-1 rounded-xl border border-slate-800">
            <button
              onClick={() => setActivePitchType('30s')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                activePitchType === '30s'
                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              30-Second Elevator Pitch
            </button>
            <button
              onClick={() => setActivePitchType('2m')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                activePitchType === '2m'
                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              2-Minute Overview
            </button>
            <button
              onClick={() => setActivePitchType('5m')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                activePitchType === '5m'
                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              5-Minute Deep Architecture
            </button>
          </div>
        </div>

        {/* Pitch Content Box */}
        <div className="p-4 rounded-xl bg-slate-950/80 border border-slate-800 space-y-3">
          <div className="flex items-center justify-between text-xs">
            <span className="font-mono text-amber-400 font-bold uppercase flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5" />
              {activePitchType === '30s'
                ? 'Quick 30s Summary for Recruiter Screen / Introduction'
                : activePitchType === '2m'
                ? 'Technical 2-Minute Architectural Overview'
                : 'Deep 5-Minute Staff / Senior Engineering Breakdown'}
            </span>
            <span className="text-slate-500 font-mono text-[10.5px]">Memorize & Practice</span>
          </div>

          <p className="text-slate-200 text-sm leading-relaxed font-sans bg-slate-900/40 p-4 rounded-xl border border-slate-800/80">
            {activePitchType === '30s'
              ? project.interview.elevatorPitch30s
              : activePitchType === '2m'
              ? project.interview.overview2Min
              : project.interview.architectureDeepDive5Min}
          </p>
        </div>
      </div>

      {/* Real Implementation Interview Questions */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <h3 className="font-bold text-white text-base flex items-center gap-2">
              <HelpCircle className="w-4 h-4 text-cyan-400" />
              Real Implementation System Design Questions
            </h3>
            <p className="text-xs text-slate-400">
              Questions an interviewer will ask based on the specific architecture decisions and code in this repository.
            </p>
          </div>
          <span className="px-2.5 py-1 rounded-lg bg-cyan-500/10 text-cyan-400 font-mono text-xs font-bold border border-cyan-500/30">
            {project.interview.technicalQuestions.length} Questions
          </span>
        </div>

        {/* Questions Accordion */}
        <div className="space-y-3">
          {project.interview.technicalQuestions.map(q => {
            const isExpanded = expandedQuestionId === q.id;

            return (
              <div
                key={q.id}
                className={`rounded-2xl border transition-all overflow-hidden ${
                  isExpanded
                    ? 'bg-[#0e131f] border-cyan-500/50 shadow-xl shadow-cyan-500/10'
                    : 'bg-[#0e131f]/90 hover:bg-[#131b2e] border-slate-800'
                }`}
              >
                {/* Accordion Trigger Header */}
                <button
                  onClick={() => setExpandedQuestionId(isExpanded ? null : q.id)}
                  className="w-full text-left p-4.5 flex items-center justify-between gap-4"
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span
                        className={`px-2 py-0.5 rounded-full text-[10px] font-bold font-mono uppercase border ${getDifficultyBadge(
                          q.difficulty
                        )}`}
                      >
                        {q.difficulty}
                      </span>
                      <span className="px-2 py-0.5 rounded bg-slate-900 text-slate-400 font-mono text-[10px] uppercase border border-slate-800">
                        {q.category}
                      </span>
                    </div>
                    <h4 className="font-bold text-white text-sm text-left mt-1">{q.question}</h4>
                  </div>

                  <div className="p-2 rounded-lg bg-slate-900 text-slate-400 shrink-0">
                    {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                  </div>
                </button>

                {/* Expanded Answer & Evidence Body */}
                {isExpanded && (
                  <div className="p-5 pt-0 border-t border-slate-800/80 space-y-4 text-xs">
                    {/* Context in Repo */}
                    <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 text-slate-300">
                      <span className="text-slate-400 font-bold block mb-0.5 text-[11px] uppercase tracking-wider font-mono">
                        Repository Context:
                      </span>
                      {q.context}
                    </div>

                    {/* Suggested Answer */}
                    <div className="p-4 rounded-xl bg-emerald-500/5 border border-emerald-500/20 space-y-1.5">
                      <span className="text-emerald-400 font-bold text-xs flex items-center gap-1.5 font-mono uppercase">
                        <Award className="w-4 h-4 text-emerald-400" />
                        Model Answer & Trade-off Explanation:
                      </span>
                      <p className="text-slate-200 leading-relaxed text-[12.5px]">{q.suggestedAnswer}</p>
                    </div>

                    {/* Evidence Reference */}
                    <div className="flex items-center justify-between text-[11px] text-slate-400 font-mono pt-1">
                      <span className="flex items-center gap-1.5">
                        <FileCode className="w-3.5 h-3.5 text-cyan-400" />
                        Evidence: <span className="text-cyan-300">{q.evidenceReference}</span>
                      </span>
                      <button
                        onClick={() =>
                          onNavigateTab('chat', {
                            initialPrompt: `Conduct a mock technical interview asking me: "${q.question}". Evaluate my answer grounded in ${project.name}'s architecture.`,
                          })
                        }
                        className="text-cyan-400 hover:text-cyan-300 font-medium flex items-center gap-1 font-sans"
                      >
                        <Sparkles className="w-3 h-3" /> Practice Mock Interview with AI
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
