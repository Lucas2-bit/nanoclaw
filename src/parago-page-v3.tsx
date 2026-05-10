/**
 * PARAGO LANDING PAGE — FINAL (v3)
 */

'use client';
import { useEffect, useState, useRef } from 'react';

const PURPLE = '#8b5cf6';
const PURPLE_LIGHT = '#a78bfa';
const BG = '#030712';

const PARTICLE_COUNT_DESKTOP = 50;
const PARTICLE_COUNT_TABLET = 30;
const CONNECTION_DISTANCE = 140;
const MOUSE_INFLUENCE_RADIUS = 200;
const MOUSE_INFLUENCE_STRENGTH = 0.015;

function shouldShowCanvas(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.innerWidth < 768) return false;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
  return true;
}

function getParticleCount(): number {
  if (typeof window === 'undefined') return 0;
  return window.innerWidth >= 1024 ? PARTICLE_COUNT_DESKTOP : PARTICLE_COUNT_TABLET;
}

export default function LandingPage() {
  const [mindCount, setMindCount] = useState<number | null>(null);
  const [showCanvas, setShowCanvas] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mouseRef = useRef<{ x: number; y: number; active: boolean }>({
    x: 0, y: 0, active: false,
  });

  useEffect(() => {
    fetch('/api/admin/stats')
      .then((r) => r.json())
      .then((d) => { if (d.totalMinds != null) setMindCount(d.totalMinds); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    setShowCanvas(shouldShowCanvas());
    const onResize = () => setShowCanvas(shouldShowCanvas());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      mouseRef.current = { x: e.clientX, y: e.clientY, active: true };
    };
    const onLeave = () => {
      mouseRef.current = { ...mouseRef.current, active: false };
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerleave', onLeave);
    return () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerleave', onLeave);
    };
  }, []);

  useEffect(() => {
    if (!showCanvas) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationId: number;

    type Particle = {
      x: number; y: number; bx: number; by: number;
      vx: number; vy: number; r: number; opacity: number;
      phase: number; isAccent: boolean;
    };

    const particles: Particle[] = [];

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    resize();

    const count = getParticleCount();
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight * 0.4;

    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const dist = (Math.random() + Math.random() + Math.random()) / 3 * Math.min(cx, cy) * 0.8;
      const px = cx + Math.cos(angle) * dist;
      const py = cy + Math.sin(angle) * dist;
      particles.push({
        x: px, y: py, bx: px, by: py,
        vx: (Math.random() - 0.5) * 0.2, vy: (Math.random() - 0.5) * 0.2,
        r: Math.random() * 1.8 + 0.5, opacity: Math.random() * 0.5 + 0.15,
        phase: Math.random() * Math.PI * 2, isAccent: Math.random() < 0.12,
      });
    }

    const GRID_SIZE = CONNECTION_DISTANCE;
    const getGridKey = (x: number, y: number) =>
      `${Math.floor(x / GRID_SIZE)},${Math.floor(y / GRID_SIZE)}`;

    let time = 0;

    const draw = () => {
      time += 0.005;
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const grid: Map<string, number[]> = new Map();
      for (let i = 0; i < particles.length; i++) {
        const key = getGridKey(particles[i].x, particles[i].y);
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key)!.push(i);
      }

      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        const gx = Math.floor(p.x / GRID_SIZE);
        const gy = Math.floor(p.y / GRID_SIZE);
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            const key = `${gx + dx},${gy + dy}`;
            const cell = grid.get(key);
            if (!cell) continue;
            for (const j of cell) {
              if (j <= i) continue;
              const q = particles[j];
              const distX = p.x - q.x;
              const distY = p.y - q.y;
              const dist = Math.sqrt(distX * distX + distY * distY);
              if (dist < CONNECTION_DISTANCE) {
                const alpha = 0.08 * (1 - dist / CONNECTION_DISTANCE);
                const nearCenter =
                  Math.sqrt(
                    ((p.x + q.x) / 2 - canvas.width / 2) ** 2 +
                    ((p.y + q.y) / 2 - canvas.height * 0.4) ** 2,
                  ) < canvas.width * 0.15;
                ctx.strokeStyle = nearCenter
                  ? `rgba(167, 139, 250, ${alpha * 1.3})`
                  : `rgba(139, 92, 246, ${alpha})`;
                ctx.lineWidth = 0.5;
                ctx.beginPath();
                ctx.moveTo(p.x, p.y);
                ctx.lineTo(q.x, q.y);
                ctx.stroke();
              }
            }
          }
        }
      }

      const mouse = mouseRef.current;
      for (const p of particles) {
        const driftX = Math.sin(time * 2 + p.phase) * 15;
        const driftY = Math.cos(time * 1.7 + p.phase * 1.3) * 12;
        const targetX = p.bx + driftX;
        const targetY = p.by + driftY;
        p.vx += (targetX - p.x) * 0.003;
        p.vy += (targetY - p.y) * 0.003;
        if (mouse.active) {
          const mDx = mouse.x - p.x;
          const mDy = mouse.y - p.y;
          const mDist = Math.sqrt(mDx * mDx + mDy * mDy);
          if (mDist < MOUSE_INFLUENCE_RADIUS && mDist > 0) {
            const force = MOUSE_INFLUENCE_STRENGTH * (1 - mDist / MOUSE_INFLUENCE_RADIUS);
            p.vx += (mDx / mDist) * force;
            p.vy += (mDy / mDist) * force;
          }
        }
        p.vx *= 0.97;
        p.vy *= 0.97;
        p.x += p.vx;
        p.y += p.vy;
        const breathe = 0.85 + 0.15 * Math.sin(time * 3 + p.phase);
        const finalOpacity = p.opacity * breathe;
        const color = p.isAccent
          ? `rgba(245, 158, 11, ${finalOpacity})`
          : `rgba(139, 92, 246, ${finalOpacity})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        if (p.r > 1.5) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.r * 3, 0, Math.PI * 2);
          ctx.fillStyle = p.isAccent
            ? `rgba(245, 158, 11, ${finalOpacity * 0.08})`
            : `rgba(139, 92, 246, ${finalOpacity * 0.08})`;
          ctx.fill();
        }
      }
      animationId = requestAnimationFrame(draw);
    };
    draw();

    const onWindowResize = () => {
      resize();
      const newCx = window.innerWidth / 2;
      const newCy = window.innerHeight * 0.4;
      const scaleX = newCx / cx;
      const scaleY = newCy / cy;
      for (const p of particles) { p.bx *= scaleX; p.by *= scaleY; }
    };
    window.addEventListener('resize', onWindowResize);
    return () => {
      cancelAnimationFrame(animationId);
      window.removeEventListener('resize', onWindowResize);
    };
  }, [showCanvas]);

  return (
    <>
      <style>{`
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes fadeInUp { from { opacity: 0; transform: translateY(24px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes ctaGlow {
          0%, 100% { box-shadow: 0 0 20px rgba(139,92,246,0.25), 0 0 60px rgba(139,92,246,0.08); }
          50% { box-shadow: 0 0 30px rgba(139,92,246,0.4), 0 0 80px rgba(139,92,246,0.15); }
        }
        @keyframes subtlePulse { 0%, 100% { opacity: 0.5; } 50% { opacity: 1; } }
        @keyframes gradientShift { 0% { background-position: 0% 50%; } 50% { background-position: 100% 50%; } 100% { background-position: 0% 50%; } }
        @keyframes orbFloat { 0%, 100% { transform: translate(-50%,-50%) scale(1); } 33% { transform: translate(-48%,-52%) scale(1.03); } 66% { transform: translate(-52%,-48%) scale(0.97); } }
        @keyframes orbFloat2 { 0%, 100% { transform: translate(-50%,-50%) scale(1); } 50% { transform: translate(-53%,-47%) scale(1.05); } }
        .parago-cta { transition: transform 0.25s cubic-bezier(0.34,1.56,0.64,1), box-shadow 0.25s ease; will-change: transform, box-shadow; }
        .parago-cta:hover { transform: translateY(-3px) scale(1.03); box-shadow: 0 0 40px rgba(139,92,246,0.5), 0 0 100px rgba(139,92,246,0.2), 0 8px 32px rgba(0,0,0,0.4) !important; }
        .parago-cta:active { transform: translateY(-1px) scale(1.01); }
        .parago-investor-link { transition: color 0.2s ease, opacity 0.2s ease; }
        .parago-investor-link:hover { color: #a78bfa !important; opacity: 1 !important; }
        @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; } }
        @media (max-width: 480px) { .parago-cta { width: 100%; text-align: center; } }
      `}</style>

      <svg style={{ position: 'fixed', top: 0, left: 0, width: 0, height: 0 }} aria-hidden="true">
        <defs>
          <filter id="noiseFilter">
            <feTurbulence type="fractalNoise" baseFrequency="0.65" numOctaves="3" stitchTiles="stitch" />
            <feColorMatrix type="saturate" values="0" />
          </filter>
        </defs>
      </svg>

      <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: BG, zIndex: 0 }} />

      {showCanvas && (
        <canvas ref={canvasRef} style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', zIndex: 1, pointerEvents: 'none' }} />
      )}

      <div style={{
        position: 'relative', zIndex: 2, display: 'flex', alignItems: 'center', justifyContent: 'center',
        minHeight: '100vh', flexDirection: 'column' as const, padding: '24px 20px', textAlign: 'center' as const, overflow: 'hidden',
      }}>
        <div style={{ position: 'absolute', top: '35%', left: '50%', transform: 'translate(-50%,-50%)', width: '800px', height: '800px', borderRadius: '50%', background: 'radial-gradient(circle, rgba(139,92,246,0.07) 0%, rgba(139,92,246,0.02) 40%, transparent 70%)', pointerEvents: 'none', filter: 'blur(60px)', animation: 'orbFloat 20s ease-in-out infinite', willChange: 'transform' }} />
        <div style={{ position: 'absolute', top: '45%', left: '55%', transform: 'translate(-50%,-50%)', width: '500px', height: '500px', borderRadius: '50%', background: 'radial-gradient(circle, rgba(245,158,11,0.03) 0%, transparent 60%)', pointerEvents: 'none', filter: 'blur(80px)', animation: 'orbFloat2 25s ease-in-out infinite', willChange: 'transform' }} />
        <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: '40%', background: 'linear-gradient(180deg, rgba(139,92,246,0.03) 0%, transparent 100%)', pointerEvents: 'none' }} />
        <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, filter: 'url(#noiseFilter)', opacity: 0.02, pointerEvents: 'none', mixBlendMode: 'overlay' }} />

        {!showCanvas && (
          <div style={{ position: 'absolute', top: '30%', left: '50%', transform: 'translate(-50%,-50%)', width: '320px', height: '320px', borderRadius: '50%', background: 'radial-gradient(circle, rgba(139,92,246,0.12) 0%, rgba(139,92,246,0.04) 40%, transparent 70%)', filter: 'blur(40px)', animation: 'orbFloat 15s ease-in-out infinite', pointerEvents: 'none' }} />
        )}

        <div style={{ maxWidth: '620px', position: 'relative' }}>
          <h1 style={{ fontFamily: "'Space Grotesk', -apple-system, sans-serif", fontSize: 'clamp(52px, 10vw, 80px)', fontWeight: 600, letterSpacing: '0.08em', marginBottom: '28px', color: '#ffffff', animation: 'fadeInUp 0.7s ease-out both', textTransform: 'uppercase' as const, lineHeight: 1 }}>
            Parago
          </h1>

          <div style={{ marginBottom: '44px', animation: 'fadeInUp 0.7s ease-out 0.3s both' }}>
            <p style={{ fontFamily: "'Space Grotesk', -apple-system, sans-serif", fontSize: 'clamp(20px, 3.5vw, 28px)', fontWeight: 500, lineHeight: 1.35, color: 'rgba(255,255,255,0.9)', margin: '0 0 8px 0', letterSpacing: '-0.01em' }}>
              What if something actually understood you?
            </p>
            <p style={{ fontFamily: "'Inter', -apple-system, sans-serif", fontSize: 'clamp(16px, 2.5vw, 20px)', fontWeight: 400, lineHeight: 1.45, color: PURPLE_LIGHT, margin: 0, letterSpacing: '0.01em' }}>
              A mind that forms around who you are. Yours to own. Yours to share.
            </p>
          </div>

          <div style={{ animation: 'fadeInUp 0.7s ease-out 0.55s both', marginBottom: '16px' }}>
            <a href="/auth" className="parago-cta" style={{
              display: 'inline-block', padding: '17px 52px',
              background: 'linear-gradient(135deg, #8b5cf6 0%, #7c3aed 40%, #6d28d9 100%)',
              backgroundSize: '200% 200%',
              animation: 'ctaGlow 3.5s ease-in-out infinite, gradientShift 8s ease infinite',
              color: '#ffffff', textDecoration: 'none', borderRadius: '14px',
              fontFamily: "'Space Grotesk', -apple-system, sans-serif",
              fontSize: '17px', fontWeight: 600, letterSpacing: '0.03em',
              cursor: 'pointer', border: 'none', position: 'relative',
            }}>
              Begin Formation
            </a>
          </div>

          <p style={{ color: 'rgba(255,255,255,0.3)', fontSize: '13px', marginBottom: '36px', animation: 'fadeInUp 0.7s ease-out 0.65s both', letterSpacing: '0.02em', fontFamily: "'Inter', -apple-system, sans-serif" }}>
            Free. No setup. Sixty seconds to your first insight.
          </p>

          <div style={{ animation: 'fadeInUp 0.7s ease-out 0.75s both' }}>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', padding: '8px 20px', background: 'rgba(139,92,246,0.05)', border: '1px solid rgba(139,92,246,0.1)', borderRadius: '100px', fontSize: '13px', color: 'rgba(255,255,255,0.4)', fontFamily: "'Inter', -apple-system, sans-serif" }}>
              <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: PURPLE, animation: 'subtlePulse 2.5s ease-in-out infinite', display: 'inline-block', flexShrink: 0 }} />
              {mindCount !== null && mindCount > 50 ? (
                <span><span style={{ color: PURPLE, fontWeight: 600 }}>{mindCount}</span> minds forming</span>
              ) : (
                <span>Minds are forming</span>
              )}
            </div>
          </div>
        </div>

        <div style={{ position: 'absolute', bottom: '32px', left: '50%', transform: 'translateX(-50%)', display: 'flex', flexDirection: 'column' as const, alignItems: 'center', gap: '10px', animation: 'fadeIn 0.7s ease-out 1s both' }}>
          <a href="/vision" className="parago-investor-link" style={{ color: 'rgba(255,255,255,0.18)', fontSize: '11px', textDecoration: 'none', letterSpacing: '0.1em', textTransform: 'uppercase' as const, fontFamily: "'Inter', -apple-system, sans-serif" }}>
            Investors
          </a>
          <span style={{ color: 'rgba(255,255,255,0.1)', fontSize: '11px', letterSpacing: '0.06em', fontFamily: "'Inter', -apple-system, sans-serif" }}>
            Paracosm Holdings
          </span>
        </div>
      </div>
    </>
  );
}