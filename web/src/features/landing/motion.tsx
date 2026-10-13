import { motion, useMotionValue, useReducedMotion, useSpring, type Variants } from 'motion/react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';

/* Motion primitives for the landing page. Everything plays once, on entering the viewport. */

export const EASE = [0.22, 1, 0.36, 1] as const;

export const rise: Variants = {
  hidden: { opacity: 0, y: 18 },
  show: { opacity: 1, y: 0, transition: { duration: 0.7, ease: EASE } },
};

export const stagger = (gap = 0.08, delay = 0): Variants => ({
  hidden: {},
  show: { transition: { staggerChildren: gap, delayChildren: delay } },
});

/** A block that fades up once when it scrolls into view. */
export function Reveal({ children, className, delay = 0, as = 'div' }: { children: ReactNode; className?: string; delay?: number; as?: 'div' | 'li' | 'section' }) {
  const Tag = motion[as];
  return (
    <Tag className={className} initial="hidden" whileInView="show" viewport={{ once: true, margin: '-80px' }} variants={rise} transition={{ delay }}>
      {children}
    </Tag>
  );
}

/** Section heading: number, eyebrow, title, lede — the same structure on every section. */
export function SectionHead({ n, eyebrow, title, id, children }: { n: string; eyebrow: string; title: ReactNode; id: string; children?: ReactNode }) {
  return (
    <motion.div className="l-head" initial="hidden" whileInView="show" viewport={{ once: true, margin: '-80px' }} variants={stagger(0.08)}>
      <motion.p className="l-eyebrow" variants={rise}>
        <span className="mono">{n}</span>
        {eyebrow}
      </motion.p>
      <motion.h2 id={id} variants={rise}>
        {title}
      </motion.h2>
      {children && (
        <motion.p className="l-lede" variants={rise}>
          {children}
        </motion.p>
      )}
    </motion.div>
  );
}

const MLink = motion.create(Link);

/** A call-to-action link that leans slightly toward the pointer. */
export function MagneticLink({ to, className, children }: { to: string; className?: string; children: ReactNode }) {
  const reduce = useReducedMotion();
  const x = useSpring(useMotionValue(0), { stiffness: 260, damping: 18, mass: 0.4 });
  const y = useSpring(useMotionValue(0), { stiffness: 260, damping: 18, mass: 0.4 });
  return (
    <MLink
      to={to}
      className={className}
      style={reduce ? undefined : { x, y }}
      onPointerMove={(e) => {
        if (reduce || e.pointerType !== 'mouse') return;
        const r = e.currentTarget.getBoundingClientRect();
        x.set((e.clientX - r.left - r.width / 2) * 0.18);
        y.set((e.clientY - r.top - r.height / 2) * 0.28);
      }}
      onPointerLeave={() => {
        x.set(0);
        y.set(0);
      }}
    >
      {children}
    </MLink>
  );
}
