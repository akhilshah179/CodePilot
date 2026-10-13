import { ArrowRight, GitBranch } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { ConfidenceBadge, Logo } from '../components/ui.tsx';
import { EASE, MagneticLink, rise, SectionHead, stagger } from '../features/landing/motion.tsx';
import { snapshot } from '../features/landing/snapshot.ts';
import { COUNTS, Hud, Story } from '../features/landing3d/Chapters.tsx';
import { Showcase } from '../features/landing3d/Showcase.tsx';
import { Stage, useStoryScroll } from '../features/landing3d/Stage.tsx';
import { api } from '../lib/api.ts';
import { useAsync, useDocumentTitle, useMediaQuery } from '../lib/hooks.ts';

const THINKS = [
  { title: 'Clone', body: 'One branch is shallow-cloned into temporary storage. Dependencies, build output and secret files are skipped before anything is parsed.', detail: 'node_modules · dist · .env excluded' },
  { title: 'Parse', body: 'Imports, re-exports, dynamic imports and require() are read with the TypeScript compiler and resolved through aliases, workspaces and index files.', detail: 'line-exact resolution' },
  { title: 'Extract facts', body: 'Manifests, lockfiles, routes, client calls, queries, Dockerfiles, Compose and CI files become facts — each with a file, a line and a redacted snippet.', detail: 'evidence before inference' },
  { title: 'Assemble', body: 'Facts are joined into applications, tools, connections and request flows. Anything that cannot be traced is labelled as unknown, not guessed.', detail: 'confirmed · strong · possible' },
];

const HEADLINE = ['Understand', 'every line.', 'See the', 'whole system.'];

export function Landing() {
  useDocumentTitle('');
  const me = useAsync(() => api.me(), []);
  const signedIn = !!me.data?.user;
  const connectHref = signedIn ? '/onboarding/repos' : '/signin';
  const exploreHref = '/sample?view=architecture';
  const reduced = !!useReducedMotion();
  const compact = useMediaQuery('(max-width: 760px)');
  const stageRef = useRef<HTMLDivElement>(null);
  useStoryScroll(stageRef);

  // The navigation turns from transparent to glass once the page moves.
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 24);
    on();
    window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, []);

  return (
    <div className="landing lx">
      <a className="skip-link" href="#main">
        Skip to content
      </a>

      <header className={`lx-nav${scrolled ? ' is-scrolled' : ''}`}>
        <Logo />
        <nav aria-label="Primary">
          <a href="#platform">Product</a>
          <a href="#map">Architecture</a>
          <a href="#trace">Automation</a>
          <a href="#explain">Technology</a>
          <a href="#docs">Docs</a>
        </nav>
        <div className="spacer" />
        {!signedIn && (
          <Link to="/signin" className="btn btn-sm btn-ghost nav-signin">
            Sign in
          </Link>
        )}
        <Link to={connectHref} className="btn btn-sm btn-primary">
          <GitBranch size={14} aria-hidden="true" />
          {signedIn ? 'Your repositories' : 'Analyze Repository'}
        </Link>
      </header>

      <Stage stageRef={stageRef} compact={compact} reduced={reduced} />
      <Hud />

      <main id="main">
        <section className="lx-hero" data-chapter={0} aria-labelledby="hero-title">
          <motion.div className="lx-hero-copy" initial="hidden" animate="show" variants={stagger(0.09, 0.15)}>
            <motion.p className="lx-kicker mono" variants={rise}>
              <span className="lx-kicker-dot" aria-hidden="true" />
              Codebase intelligence platform
            </motion.p>
            <h1 id="hero-title" className="lx-title">
              {HEADLINE.map((line, i) => (
                <motion.span key={line} className={i === 3 ? 'l-gradient' : undefined} initial={reduced ? false : { opacity: 0, y: '0.5em', filter: 'blur(6px)' }} animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }} transition={{ delay: 0.25 + i * 0.12, duration: 0.9, ease: EASE }}>
                  {line}
                </motion.span>
              ))}
            </h1>
            <motion.p className="lx-sub" variants={rise}>
              CodePilot reads a repository and maps what is really there — every file and import, the architecture they form, the requests that run through it and the technologies behind it, each with the line that proves it.
            </motion.p>
            <motion.div className="l-ctas" variants={rise}>
              <MagneticLink to={connectHref} className="btn btn-lg btn-primary l-cta">
                <GitBranch size={16} aria-hidden="true" />
                {signedIn ? 'Choose a repository' : 'Analyze a Repository'}
              </MagneticLink>
              <MagneticLink to={exploreHref} className="btn btn-lg l-cta-2">
                Explore CodePilot
                <ArrowRight size={16} aria-hidden="true" />
              </MagneticLink>
            </motion.div>
            <motion.p className="lx-note faint small" variants={rise}>
              The system behind this text is CodePilot’s analysis of its own source: {snapshot.totals.files} files, {snapshot.symbols.length} exported symbols, {snapshot.totals.edges} imports. Move the cursor over it.
            </motion.p>
          </motion.div>
          <motion.a href="#discover" className="lx-scroll small mono" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 1.6, duration: 0.8 }}>
            Scroll to follow the analysis
            <span aria-hidden="true" />
          </motion.a>
        </section>

        <Story />

        <section id="platform" className="l-section lx-platform" aria-labelledby="platform-title">
          <SectionHead n="07" eyebrow="The platform" title="One model of your system, seven ways to read it" id="platform-title">
            Every surface below runs on the same analysis of CodePilot’s own repository you just scrolled through.
          </SectionHead>
          <Showcase />
          <motion.dl className="l-stats" initial="hidden" whileInView="show" viewport={{ once: true }} variants={stagger(0.06)}>
            {COUNTS.map((s) => (
              <motion.div key={s.label} variants={rise}>
                <dd className="mono">{s.value.toLocaleString()}</dd>
                <dt>{s.label.toLowerCase()}</dt>
              </motion.div>
            ))}
          </motion.dl>
        </section>

        <section id="docs" className="l-section lx-docs" aria-labelledby="docs-title">
          <SectionHead n="08" eyebrow="How it works" title="Facts first. Inference second. Guesses never." id="docs-title">
            Every node and connection is derived from something that can be pointed at: a manifest line, an import, a route, a query.
          </SectionHead>
          <motion.ol className="l-thinks" initial="hidden" whileInView="show" viewport={{ once: true, margin: '-60px' }} variants={stagger(0.1)}>
            {THINKS.map((s, i) => (
              <motion.li key={s.title} variants={rise}>
                <span className="l-thinks-n mono">{String(i + 1).padStart(2, '0')}</span>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
                <p className="mono faint small">{s.detail}</p>
              </motion.li>
            ))}
          </motion.ol>
          <div className="l-conf-row">
            <span>
              <ConfidenceBadge level="confirmed" /> seen directly in code or configuration
            </span>
            <span>
              <ConfidenceBadge level="strong" /> follows from several facts together
            </span>
            <span>
              <ConfidenceBadge level="possible" /> a single weak signal, shown faintly
            </span>
            <span>
              <ConfidenceBadge level="unknown" /> not enough evidence — said, not guessed
            </span>
          </div>
        </section>

        <section id="trust" className="l-section" aria-labelledby="trust-title">
          <SectionHead n="09" eyebrow="Trust" title="What CodePilot reads, and what it never keeps" id="trust-title" />
          <motion.div className="l-trust" initial="hidden" whileInView="show" viewport={{ once: true }} variants={stagger(0.08)}>
            <motion.div variants={rise}>
              <h3>What is read</h3>
              <ul>
                <li>The files of the branch you choose, from a shallow clone in temporary storage, deleted when the analysis finishes.</li>
                <li>Manifests such as package.json and tsconfig.json, to resolve imports correctly.</li>
              </ul>
            </motion.div>
            <motion.div variants={rise}>
              <h3>What is excluded</h3>
              <ul>
                <li>
                  <code>.git</code>, <code>node_modules</code>, <code>dist</code> and other build output.
                </li>
                <li>
                  <code>.env</code> files, private keys, credential files and generated bundles.
                </li>
              </ul>
            </motion.div>
            <motion.div variants={rise}>
              <h3>How tokens are protected</h3>
              <ul>
                <li>GitHub tokens stay on the server, encrypted at rest with AES-256-GCM, never sent to the browser or logged.</li>
                <li>Sessions use HTTP-only cookies; you can revoke access from GitHub at any time.</li>
              </ul>
            </motion.div>
            <motion.div variants={rise}>
              <h3>Secrets in evidence</h3>
              <ul>
                <li>Stored data is paths, symbols, line numbers and short snippets — never whole files.</li>
                <li>Credential-shaped values are redacted from every snippet before it is stored.</li>
              </ul>
            </motion.div>
          </motion.div>
        </section>

        <section className="lx-final" data-chapter={7} aria-labelledby="cta-title">
          <motion.div className="lx-final-copy" initial="hidden" whileInView="show" viewport={{ amount: 0.5 }} variants={stagger(0.1)}>
            <motion.h2 id="cta-title" variants={rise}>
              Your codebase.
              <br />
              <span className="l-gradient">Finally understood.</span>
            </motion.h2>
            <motion.p className="l-lede" variants={rise}>
              Connect a repository and get its dependency graph, architecture, request flows and technologies — with the evidence for each.
            </motion.p>
            <motion.div className="l-ctas" variants={rise}>
              <MagneticLink to={connectHref} className="btn btn-lg btn-primary l-cta">
                <GitBranch size={16} aria-hidden="true" />
                {signedIn ? 'Choose a repository' : 'Analyze Your Repository'}
              </MagneticLink>
              <MagneticLink to={exploreHref} className="btn btn-lg l-cta-2">
                Explore the Platform
                <ArrowRight size={16} aria-hidden="true" />
              </MagneticLink>
            </motion.div>
          </motion.div>
        </section>
      </main>

      <footer className="l-footer">
        <div className="l-footer-brand">
          <Logo />
          <span className="faint small">Architecture derived from source code, never guessed.</span>
        </div>
        <nav aria-label="Footer">
          <Link to={exploreHref}>Sample architecture</Link>
          <Link to="/sample?view=wireframe">Sample dependency graph</Link>
          <Link to="/sample?view=automation">Sample automation</Link>
          <Link to={connectHref}>Connect GitHub</Link>
          <a href="#trust">Trust</a>
        </nav>
        <p className="faint small mono">
          Everything on this page is CodePilot’s analysis of its own repository{snapshot.commit ? ` at ${snapshot.commit.slice(0, 7)}` : ''}, generated {new Date(snapshot.generatedAt).toLocaleDateString()}.
        </p>
      </footer>
    </div>
  );
}
